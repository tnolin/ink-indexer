import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Level } from "../src/log"
import { TRACKED_CAP } from "../src/sources/nft/policy"
import {
  createStream,
  type StreamEvent,
  trackedSlugs,
  type WebSocketLike,
} from "../src/sources/opensea/stream"
import { createStore } from "../src/store"
import { FakeStream, type Frame } from "./opensea/fake-ws"
import { loadOpenSeaFixture } from "./opensea/fixtures"

const KEY = "dummy-stream-key-0123456789abcdef"
const SEC = 1000
const MIN = 60 * SEC
const TYPES = [
  "item_listed",
  "item_cancelled",
  "item_sold",
  "item_transferred",
  "item_metadata_updated",
]

type Recorded = { frames: { atMs: number; frame: Frame }[] }

describe("Stream shards", () => {
  let server: FakeStream
  let events: StreamEvent[]
  let logs: { level: Level; msg: string; fields?: Record<string, unknown> }[]
  let reports: unknown[]
  let stream: ReturnType<typeof createStream> | undefined

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
    vi.setSystemTime(Date.parse("2026-10-19T00:00:00Z"))
    server = new FakeStream()
    events = []
    logs = []
    reports = []
    stream = undefined
  })
  afterEach(() => {
    stream?.stop()
    vi.useRealTimers()
  })

  /** Lets queued socket opens, replies and closes run. */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms)
    await flush()
  }

  /** A stream whose startup probe has finished. */
  async function start(opts: { perConn?: number; maxConns?: number } = {}) {
    stream = createStream({
      key: KEY,
      socket: server.factory,
      onEvent: (e) => events.push(e),
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
      report: (e) => reports.push(e),
      ...opts,
    })
    await flush()
    return stream
  }

  const slugs = (n: number, prefix = "slug") =>
    Array.from({ length: n }, (_, i) => `${prefix}-${i}`)
  const topics = (xs: string[]) => xs.map((s) => `collection:${s}`)
  /** The shard sockets (the first socket is the startup probe). */
  const shards = () => server.sockets.slice(1)

  /** A pushed item event on `topic` for an item of `chain`. */
  const itemEvent = (
    topic: string,
    event: string,
    o: { chain?: string; slug?: string; nft?: string } = {},
  ): Frame => [
    null,
    null,
    topic,
    event,
    {
      event_type: event,
      payload: {
        collection: { slug: o.slug ?? topic.replace("collection:", "") },
        item: {
          nft_id: o.nft ?? "ink/0x3EA71C6ABDE8A1B3CF6E5683761A7378B4E9E448/7",
          chain: { name: o.chain ?? "ink" },
        },
        base_price: "1000",
      },
    },
  ]

  it("the startup probe joins perConn + 1 throwaway topics and closes", async () => {
    await start()
    const probe = server.sockets[0]!
    expect(probe.url).toBe(`wss://stream-api.opensea.io/socket/websocket?token=${KEY}&vsn=2.0.0`)
    expect(probe.joins()).toHaveLength(51)
    expect(probe.state).toBe("closed")
    expect(stream!.mode()).toBe("shards")
  })

  it("120 slugs make 3 shards of 50, 50, 20", async () => {
    const s = await start()
    const all = slugs(120)
    s.setSlugs(all)
    await flush()
    expect(shards().map((x) => x.joins().length)).toEqual([50, 50, 20])
    expect(shards().flatMap((x) => x.joins())).toEqual(topics(all))
    expect(shards().every((x) => x.state === "open")).toBe(true)
    for (const f of shards()[0]!.sent.filter((f) => f[3] === "phx_join"))
      expect(f[4]).toEqual({ event_types: TYPES })
    expect(s.mode()).toBe("shards")
    // One line per shard once its joins are answered.
    expect(logs.filter((l) => l.msg === "opensea stream joined").map((l) => l.fields)).toEqual([
      { conn: expect.any(String), kind: "shard", topics: 50 },
      { conn: expect.any(String), kind: "shard", topics: 50 },
      { conn: expect.any(String), kind: "shard", topics: 20 },
    ])
  })

  it("rebalance keeps assignments and fills holes", async () => {
    const s = await start()
    const first = slugs(120)
    s.setSlugs(first)
    await flush()
    const [a, b, c] = shards()
    const next = first.filter((x) => x !== "slug-3" && x !== "slug-60")
    next.push("new-a", "new-b", "new-c")
    s.setSlugs(next)
    await flush()
    expect(shards()).toHaveLength(3)
    expect(a!.leaves()).toEqual(["collection:slug-3"])
    expect(b!.leaves()).toEqual(["collection:slug-60"])
    expect(a!.joins().slice(50)).toEqual(["collection:new-a"])
    expect(b!.joins().slice(50)).toEqual(["collection:new-b"])
    expect(c!.joins().slice(20)).toEqual(["collection:new-c"])

    // 30 more: the third shard fills to 50 and only then a fourth opens.
    s.setSlugs([...next, ...slugs(30, "more")])
    await flush()
    expect(c!.joined.size).toBe(50)
    expect(shards()).toHaveLength(4)
    expect(shards()[3]!.joins()).toEqual(["collection:more-29"])
    expect(a!.joined.size + b!.joined.size).toBe(100)
  })

  it("close 1006 then 4500: backoff 1s then 2s, every topic rejoined", async () => {
    const s = await start()
    s.setSlugs(["a", "b", "c"])
    await flush()
    shards()[0]!.serverClose(1006)
    await advance(999)
    expect(shards()).toHaveLength(1)
    await advance(1)
    expect(shards()).toHaveLength(2)
    expect(shards()[1]!.joins()).toEqual(topics(["a", "b", "c"]))

    shards()[1]!.serverClose(4500)
    await advance(1999)
    expect(shards()).toHaveLength(2)
    await advance(1)
    expect(shards()).toHaveLength(3)
    expect([...shards()[2]!.joined]).toEqual(topics(["a", "b", "c"]))

    // A minute of uptime resets the backoff to 1 s.
    await advance(60 * SEC)
    shards()[2]!.serverClose(1006)
    await advance(1000)
    expect(shards()).toHaveLength(4)
    expect(s.mode()).toBe("shards")
  })

  it("the 51st join error is logged and does not drop the shard", async () => {
    server.joinCap = 52
    const s = await start({ perConn: 51 })
    expect(s.mode()).toBe("shards")
    server.joinCap = 50
    s.setSlugs(slugs(51))
    await flush()
    const failed = logs.filter((l) => l.msg === "opensea stream join failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]!.fields).toMatchObject({ slug: "slug-50" })
    await advance(10 * SEC)
    expect(shards()).toHaveLength(1)
    expect(shards()[0]!.state).toBe("open")
    shards()[0]!.push(itemEvent("collection:slug-0", "item_listed"))
    expect(events).toHaveLength(1)
  })

  it("non-ink events are dropped", async () => {
    const s = await start()
    s.setSlugs(["a"])
    await flush()
    const sock = shards()[0]!
    sock.push(itemEvent("collection:a", "item_listed"))
    sock.push(itemEvent("collection:a", "item_listed", { chain: "ethereum" }))
    sock.push(itemEvent("collection:a", "item_sold", { chain: "base" }))
    sock.push(itemEvent("collection:a", "order_invalidate"))
    sock.push(itemEvent("collection:a", "item_sold", { nft: "ink/not-an-address/1" }))
    expect(events).toEqual([
      {
        type: "item_listed",
        slug: "a",
        contract: "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448",
        tokenId: "7",
        payload: expect.objectContaining({ base_price: "1000" }),
        receivedAt: Date.parse("2026-10-19T00:00:00Z"),
      },
    ])
  })

  it("replayed recorded frames produce the right StreamEvents", async () => {
    const rec = loadOpenSeaFixture("stream/collections") as Recorded
    const s = await start()
    s.setSlugs(["ink-hornet", "inkverse-920024436", "prtscn-ink", "wiredonink"])
    await flush()
    const sock = shards()[0]!
    for (const { frame } of rec.frames) if (frame[3] !== "phx_reply") sock.push(frame)
    const count = (t: string) => events.filter((e) => e.type === t).length
    expect(count("item_listed")).toBe(120)
    expect(count("item_cancelled")).toBe(72)
    expect(count("item_transferred")).toBe(9)
    expect(count("item_metadata_updated")).toBe(25)
    expect(events).toHaveLength(226)
    const first = events[0]!
    expect(first).toMatchObject({
      type: "item_listed",
      slug: "prtscn-ink",
      contract: "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448",
      tokenId: "1506",
    })
    expect(first.payload).toMatchObject({ base_price: "37471900000000000", is_private: false })
    const moved = events.find((e) => e.type === "item_transferred")!
    expect(moved).toMatchObject({
      slug: "wiredonink",
      contract: "0x7c701c0148e0e965065aa05e008ac9341e6efc6c",
      tokenId: "6559",
    })
  })

  it("probe with cap 40 switches to firehose", async () => {
    server.joinCap = 40
    const s = await start()
    expect(s.mode()).toBe("firehose")
    expect(logs.some((l) => l.level === "warn" && l.msg === "opensea stream firehose")).toBe(true)
    expect(server.openSockets()).toHaveLength(1)
    const hose = server.sockets[1]!
    expect(hose.joins()).toEqual(["collection:*"])
    expect(hose.sent[0]![4]).toEqual({ event_types: TYPES })

    // The firehose keeps only Ink events of tracked collections, by the payload's slug.
    s.setSlugs(["a"])
    hose.push(itemEvent("collection:*", "item_listed", { slug: "a" }))
    hose.push(itemEvent("collection:*", "item_listed", { slug: "untracked" }))
    hose.push(itemEvent("collection:*", "item_listed", { slug: "a", chain: "ethereum" }))
    expect(events.map((e) => e.slug)).toEqual(["a"])
    expect(server.sockets).toHaveLength(2)
  })

  it("two refused new shards switch to firehose", async () => {
    const s = await start()
    s.setSlugs(slugs(50))
    await flush()
    // Shard 1 is up, so the server is reachable: shards 2 and 3 are refused.
    server.refuse = 2
    s.setSlugs(slugs(150))
    await flush()
    expect(s.mode()).toBe("firehose")
    const open = server.openSockets()
    expect(open).toHaveLength(1)
    expect(open[0]!.joins()).toEqual(["collection:*"])
  })

  it("a new shard whose joins all fail while another is up counts as refused", async () => {
    const s = await start()
    s.setSlugs(slugs(50))
    await flush()
    server.joinCap = 0
    s.setSlugs(slugs(150))
    await flush()
    expect(s.mode()).toBe("firehose")
  })

  it("one new shard failing again and again does not switch", async () => {
    const s = await start()
    s.setSlugs(slugs(50))
    await flush()
    server.refuse = 6
    s.setSlugs(slugs(60))
    await advance(1 * SEC + 2 * SEC + 5 * SEC + 10 * SEC + 30 * SEC + 30 * SEC)
    expect(s.mode()).toBe("shards")
    expect(server.openSockets().map((x) => x.joined.size)).toEqual([50, 10])
  })

  it("a startup with the Stream unreachable does not switch, and the shards come up later", async () => {
    server.refuse = 1000
    const s = await start()
    s.setSlugs(slugs(120))
    await advance(3 * MIN)
    expect(s.mode()).toBe("shards")
    server.refuse = 0
    await advance(30 * SEC)
    expect(s.mode()).toBe("shards")
    expect(server.openSockets().map((x) => x.joined.size)).toEqual([50, 50, 20])
  })

  it("reconnects of a shard that was up do not count as refusals", async () => {
    const s = await start()
    s.setSlugs(["a"])
    await flush()
    server.refuse = 5
    shards()[0]!.serverClose(1006)
    await advance(1 * SEC + 2 * SEC + 5 * SEC + 10 * SEC + 30 * SEC)
    expect(s.mode()).toBe("shards")
  })

  it("more slugs than perConn × maxConns switch to firehose", async () => {
    const s = await start({ perConn: 2, maxConns: 2 })
    s.setSlugs(["a", "b", "c", "d"])
    await flush()
    expect(s.mode()).toBe("shards")
    s.setSlugs(["a", "b", "c", "d", "e"])
    await flush()
    expect(s.mode()).toBe("firehose")
    expect(server.openSockets().map((x) => x.joins())).toEqual([["collection:*"]])
  })

  it("a heartbeat with no reply by the next one closes the socket", async () => {
    const s = await start()
    s.setSlugs(["a"])
    await flush()
    const sock = shards()[0]!
    await advance(25 * SEC)
    expect(sock.sent.filter((f) => f[3] === "heartbeat")).toEqual([
      [null, expect.any(String), "phoenix", "heartbeat", {}],
    ])
    expect(sock.state).toBe("open")
    server.heartbeats = false
    await advance(25 * SEC)
    expect(sock.state).toBe("open")
    await advance(25 * SEC)
    expect(sock.closedBy).toBe("client")
    await advance(1 * SEC)
    expect(shards()).toHaveLength(2)
  })

  it("a shard down over 5 minutes is reported once per outage", async () => {
    const s = await start()
    s.setSlugs(["a"])
    await flush()
    server.refuse = 1000
    shards()[0]!.serverClose(1006)
    await advance(5 * MIN - SEC)
    expect(reports).toHaveLength(0)
    await advance(2 * SEC)
    expect(reports).toHaveLength(1)
    await advance(20 * MIN)
    expect(reports).toHaveLength(1)

    // Up again, then a second outage is a second report.
    server.refuse = 0
    await advance(30 * SEC)
    const up = server.openSockets()
    expect(up).toHaveLength(1)
    server.refuse = 1000
    up[0]!.serverClose(4500)
    await advance(6 * MIN)
    expect(reports).toHaveLength(2)
  })

  it("the firehose logs messages and bytes per minute every 10 minutes", async () => {
    server.joinCap = 40
    // What the firehose socket had received when the meter was logged.
    let seen: { messages: number; bytes: number } | undefined
    const meters: Record<string, unknown>[] = []
    stream = createStream({
      key: KEY,
      socket: server.factory,
      onEvent: () => {},
      log: (_level, msg, fields) => {
        if (msg !== "opensea firehose meter") return
        meters.push(fields!)
        seen ??= { messages: hose().received, bytes: hose().receivedBytes }
      },
      report: () => {},
    })
    const hose = () => server.sockets[1]!
    await flush()
    const frame = itemEvent("collection:*", "order_invalidate", { slug: "x" })
    for (let i = 0; i < 100; i++) hose().push(frame)
    await advance(10 * MIN)
    expect(meters).toHaveLength(1)
    expect(seen!.messages).toBeGreaterThan(100)
    expect(meters[0]).toEqual({
      minutes: 10,
      messagesPerMin: Math.round(seen!.messages / 10),
      bytesPerMin: Math.round(seen!.bytes / 10),
      eventsPerMin: 0,
    })
  })

  it("stop closes every socket and nothing reconnects", async () => {
    const s = await start()
    s.setSlugs(slugs(60))
    await flush()
    s.stop()
    await advance(10 * MIN)
    expect(server.openSockets()).toHaveLength(0)
    expect(server.sockets).toHaveLength(3)
  })

  it("stop during a backoff wait or during the probe opens nothing more", async () => {
    const s = await start()
    s.setSlugs(["a"])
    await flush()
    shards()[0]!.serverClose(1006)
    s.stop()
    await advance(10 * MIN)
    expect(server.sockets).toHaveLength(2)

    const other = new FakeStream()
    const msgs: string[] = []
    const t = createStream({
      key: KEY,
      socket: other.factory,
      onEvent: () => {},
      log: (_level, msg) => msgs.push(msg),
      report: () => {},
    })
    t.setSlugs(["a"])
    t.stop()
    await advance(10 * MIN)
    expect(other.sockets).toHaveLength(1)
    expect(other.sockets[0]!.state).toBe("closed")
    expect(msgs).toEqual([])
  })

  it("the probe reads the recorded join-limit replies as 50 accepted", async () => {
    const rec = loadOpenSeaFixture("stream/join-limit") as Recorded
    // The probe is the first thing the stream sends, so its join refs are 1 to 51 as in the recording.
    const recorded: WebSocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send(data) {
        if ((JSON.parse(data) as Frame)[1] === "51")
          for (const { frame } of rec.frames)
            queueMicrotask(() => recorded.onmessage?.(JSON.stringify(frame)))
      },
      close() {},
    }
    queueMicrotask(() => recorded.onopen?.())
    let first = true
    const s = createStream({
      key: KEY,
      socket: (url) => {
        if (!first) return server.factory(url)
        first = false
        return recorded
      },
      onEvent: () => {},
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
      report: () => {},
    })
    stream = s
    await flush()
    expect(logs.find((l) => l.msg === "opensea stream probe")?.fields).toEqual({
      joins: 51,
      accepted: 50,
    })
    expect(s.mode()).toBe("shards")
  })

  it("a slug whose join failed on a shard that is up is joined again by the next setSlugs", async () => {
    const s = await start()
    server.joinCap = 1
    s.setSlugs(["a", "b"])
    await flush()
    const sock = shards()[0]!
    const failed = () =>
      logs.filter((l) => l.msg === "opensea stream join failed").map((l) => l.fields?.slug)
    expect(failed()).toEqual(["b"])
    sock.cap = 50
    s.setSlugs(["a", "b"])
    await flush()
    expect(sock.joins()).toEqual(topics(["a", "b", "b"]))
    expect([...sock.joined]).toEqual(topics(["a", "b"]))
    expect(failed()).toEqual(["b"])
    expect(shards()).toHaveLength(1)
  })

  it("the key never appears in any log call", async () => {
    // The first shard connection throws an error that carries the URL.
    let calls = 0
    const socket = (url: string) => {
      if (++calls === 2) throw new Error(`cannot connect to ${url}`)
      return server.factory(url)
    }
    const logged: unknown[] = []
    const reported: string[] = []
    stream = createStream({
      key: KEY,
      socket,
      onEvent: () => {},
      log: (...args) => logged.push(args),
      report: (e) => reported.push(e instanceof Error ? `${e.message} ${e.stack}` : String(e)),
    })
    await flush()
    expect(server.sockets[0]!.url).toContain(KEY)
    stream.setSlugs(["a"])
    await advance(1 * SEC)
    server.openSockets()[0]!.serverClose(4500, `bad token ${KEY}`)
    server.refuse = 1000
    await advance(6 * MIN) // down past the report
    server.refuse = 0
    server.heartbeats = false
    await advance(2 * MIN) // heartbeats time out
    stream.setSlugs(slugs(2000)) // firehose
    await advance(10 * MIN) // meter
    expect(reported).toHaveLength(1)
    const text = JSON.stringify(logged) + reported.join(" ")
    expect(text).toContain("***")
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(encodeURIComponent(KEY))
  })
})

describe("trackedSlugs", () => {
  let sql: Sql
  const HEAD = 10_000_000
  const DAY_S = 86_400

  beforeEach(async () => {
    sql = await resetDb(inject("databaseUrl"))
    await createStore(sql).writeBatch([], [], {
      cursor: { block: BigInt(HEAD), hash: `0x${"11".repeat(32)}` },
      head: BigInt(HEAD),
    })
  })
  afterEach(() => sql.end())

  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
  async function add(n: number, extra: Record<string, unknown> = {}) {
    await sql`insert into indexer.nft_collections ${sql({
      contract: addr(n),
      standard: "erc721",
      slug: `c-${n}`,
      ...extra,
    })}`
  }
  async function sales(n: number, count: number, ageS: number) {
    const rows = Array.from({ length: count }, (_, i) => ({
      tx_hash: `0x${n.toString(16)}${ageS.toString(16)}${i.toString(16).padStart(6, "0")}`,
      log_index: 0,
      token_id: String(i),
      contract: addr(n),
      qty: "1",
      price_wei: "1000",
      currency: "ETH",
      buyer: addr(1),
      seller: addr(2),
      order_hash: "0xaa",
      block: String(HEAD - ageS),
    }))
    await sql`insert into indexer.nft_sales ${sql(rows)}`
  }
  async function mint(n: number, ageS: number) {
    await sql`insert into indexer.nft_mints ${sql({
      tx_hash: `0xmint${n}`,
      log_index: 0,
      idx: 0,
      contract: addr(n),
      token_id: "1",
      recipient: addr(3),
      qty: "1",
      block: String(HEAD - ageS),
    })}`
  }

  it("orders marks, real, pending minting now, then 7-day sellers by sales", async () => {
    await add(10) // marked, pending, no activity
    await sql`insert into indexer.nft_overrides (contract, kind) values (${addr(10)}, 'continuous')`
    await add(20, { verdict: "real" })
    await add(21, { verdict: "real" })
    await sales(21, 2, DAY_S)
    await add(30, { verdict: "pending" })
    await mint(30, 60)
    await add(31, { verdict: "pending" }) // its last mint is an hour old
    await mint(31, 3600)
    await add(40, { verdict: "filtered" })
    await sales(40, 3, DAY_S)
    await add(41, { verdict: "pending" })
    await sales(41, 5, 2 * DAY_S)
    await add(42) // the only sale is 8 days old
    await sales(42, 9, 8 * DAY_S)
    await add(50, { verdict: "real", slug: null })
    expect(await trackedSlugs(sql)).toEqual(["c-10", "c-21", "c-20", "c-30", "c-41", "c-40"])
  })

  it("a manual filtered mark leaves the collection out, however much it sells", async () => {
    await add(10, { verdict: "filtered" })
    await sql`insert into indexer.nft_overrides (contract, verdict) values (${addr(10)}, 'filtered')`
    await sales(10, 50, DAY_S)
    await add(11, { verdict: "real" })
    await sql`insert into indexer.nft_overrides (contract, verdict) values (${addr(11)}, 'real')`
    await add(12, { verdict: "filtered" }) // filtered by the gates, not by a mark: a 7-day seller
    await sales(12, 1, DAY_S)
    expect(await trackedSlugs(sql)).toEqual(["c-11", "c-12"])
  })

  it("contracts that share a slug count once, and a filtered mark on any of them leaves the slug out", async () => {
    await add(60, { verdict: "real", slug: "shared" })
    await add(61, { slug: "shared" })
    await sales(61, 9, DAY_S)
    await add(62, { verdict: "real", slug: "marked" })
    await add(63, { slug: "marked" })
    await sql`insert into indexer.nft_overrides (contract, verdict) values (${addr(63)}, 'filtered')`
    await add(64, { verdict: "real" })
    expect(await trackedSlugs(sql)).toEqual(["shared", "c-64"])
  })

  it("returns one past the cap, so 1,001 eligible collections switch the stream to the firehose", async () => {
    const rows = Array.from({ length: 1002 }, (_, i) => ({
      contract: addr(1000 + i),
      standard: "erc721",
      slug: `r-${i}`,
      verdict: "real",
    }))
    await sql`insert into indexer.nft_collections ${sql(rows)}`
    const tracked = await trackedSlugs(sql)
    expect(tracked).toHaveLength(TRACKED_CAP + 1)

    const server = new FakeStream()
    const stream = createStream({
      key: KEY,
      socket: server.factory,
      onEvent: () => {},
      log: () => {},
      report: () => {},
    })
    try {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
      expect(stream.mode()).toBe("shards")
      stream.setSlugs(tracked)
      expect(stream.mode()).toBe("firehose")
      stream.setSlugs(tracked.slice(0, TRACKED_CAP))
      expect(stream.mode()).toBe("firehose")
    } finally {
      stream.stop()
    }
  })
})
