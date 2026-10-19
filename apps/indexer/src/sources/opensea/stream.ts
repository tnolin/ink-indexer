import type { Sql } from "@ink-indexer/db"
import { type OsStreamFrame, parseStreamFrame } from "@ink-indexer/sdk"
import type { Address } from "viem"
import type { Logger } from "../../log"
import { CURSOR_ROW } from "../../store"
import {
  BLOCK_S,
  FIREHOSE_METER_EVERY_MS,
  RANK_WINDOW_S,
  STILL_MINTING_S,
  STREAM_BACKOFF_MS,
  STREAM_BACKOFF_RESET_MS,
  STREAM_DOWN_REPORT_MS,
  STREAM_HEARTBEAT_MS,
  STREAM_MAX_CONNS,
  STREAM_PER_CONN,
  STREAM_PROBE_TIMEOUT_MS,
  STREAM_REFUSED_TO_FIREHOSE,
  TRACKED_CAP,
} from "../nft/policy"

const STREAM_URL = "wss://stream-api.opensea.io/socket/websocket"
const TOPIC_PREFIX = "collection:"
/** The firehose's topic name after the prefix: every collection on every chain. */
const ALL = "*"
const PROBE_SLUG = "cap-probe-"

/** The Stream events the source subscribes to. */
export const STREAM_EVENT_TYPES = [
  "item_listed",
  "item_cancelled",
  "item_sold",
  "item_transferred",
  "item_metadata_updated",
] as const
export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number]

export type StreamEvent = {
  type: StreamEventType
  slug: string
  /** Lowercase. */
  contract: Address
  tokenId: string
  /** The event's `payload` as OpenSea sent it (item, prices, maker and so on). */
  payload: unknown
  /** Unix milliseconds. */
  receivedAt: number
}

/** The part of a WebSocket the stream uses. Text frames only. */
export type WebSocketLike = {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((data: string) => void) | null
  onclose: ((code: number, reason: string) => void) | null
}

/** The runtime's WebSocket behind `WebSocketLike`. Binary frames are dropped; the Stream sends text. */
function nativeSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url)
  const s: WebSocketLike = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  }
  ws.onopen = () => s.onopen?.()
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") s.onmessage?.(ev.data)
  }
  ws.onclose = (ev) => s.onclose?.(ev.code, ev.reason)
  return s
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null

const NFT_ID = /^ink\/(0x[0-9a-fA-F]{40})\/(\d+)$/
const TYPES: ReadonlySet<string> = new Set(STREAM_EVENT_TYPES)

/**
 * A pushed frame as a `StreamEvent`, or null when it is not one of the subscribed types, its item
 * is not on Ink (other chains leak onto a slug's topic) or its `nft_id` is not `ink/<contract>/<id>`.
 */
function toEvent(f: OsStreamFrame, slug: string, receivedAt: number): StreamEvent | null {
  if (!TYPES.has(f.event)) return null
  const payload = obj(obj(f.body)?.payload)
  const item = obj(payload?.item)
  if (obj(item?.chain)?.name !== "ink") return null
  const m = typeof item?.nft_id === "string" ? NFT_ID.exec(item.nft_id) : null
  if (!m) return null
  return {
    type: f.event as StreamEventType,
    slug,
    contract: m[1]!.toLowerCase() as Address,
    tokenId: m[2]!,
    payload,
    receivedAt,
  }
}

/** The collection slug a firehose event names in its payload. */
function payloadSlug(body: unknown): string | null {
  const slug = obj(obj(obj(body)?.payload)?.collection)?.slug
  return typeof slug === "string" && slug !== "" ? slug : null
}

/** One Stream connection: a shard of collection topics, or the firehose. */
type Conn = {
  name: string
  kind: "shard" | "firehose"
  /** Slugs assigned to the connection; the firehose holds `*`. */
  topics: Set<string>
  ws: WebSocketLike | null
  open: boolean
  /** Join replies awaited, by ref. */
  pending: Map<string, string>
  /** The join ref of each joined slug, for its leave. */
  joinRefs: Map<string, string>
  heartbeatRef: string | null
  heartbeat: ReturnType<typeof setInterval> | null
  retry: ReturnType<typeof setTimeout> | null
  downTimer: ReturnType<typeof setTimeout> | null
  /** Reconnects since the backoff last reset. */
  attempt: number
  openedAt: number | null
  downSince: number | null
  /** A join of this connection has been accepted once: it is no longer a new shard. */
  proven: boolean
  retired: boolean
}

export type Stream = {
  /** The collections to stream. Rebalances the shards, keeping existing assignments. */
  setSlugs(slugs: string[]): void
  mode(): "shards" | "firehose"
  stop(): void
}

/**
 * OpenSea Stream events for the tracked collections.
 *
 * Shards: each connection joins up to `perConn` `collection:<slug>` topics (OpenSea's cap is 50),
 * up to `maxConns` connections. A changed set leaves removed slugs and joins new ones in free slots,
 * opening a new shard only when every shard is full. Every connection heartbeats every 25 s and is
 * closed when a heartbeat has no reply by the next one. A lost connection reconnects after 1, 2, 5,
 * 10, then 30 s (from 1 s again after a minute up) and rejoins all its topics; one down for over
 * 5 minutes is reported once per outage.
 *
 * Firehose: one connection joining `collection:*`, kept to Ink events of tracked slugs, when the
 * set is larger than the shards hold, when the startup probe (`perConn + 1` throwaway joins on one
 * connection) sees fewer than `perConn` accepted, or when two new shards in a row are refused or
 * have every join fail. It logs its messages and bytes per minute every 10 minutes.
 * shortcut: the switch lasts until restart; a refusal that turns out to be transient keeps the
 * firehose. Add a periodic shard retry if that happens.
 * shortcut: events sent while a connection is down are lost; OpenSea does not replay them. Read
 * the REST listings of the affected collections after a reconnect if the gaps matter.
 *
 * The key is part of the connection URL: neither the URL nor the key is ever logged or reported,
 * and error text has the key replaced with `***`.
 */
export function createStream(deps: {
  key: string
  socket?: (url: string) => WebSocketLike
  onEvent(e: StreamEvent): void
  log: Logger
  report: (err: unknown) => void
  now?: () => number
  perConn?: number
  maxConns?: number
}): Stream {
  const { key, onEvent, log, report } = deps
  const socket = deps.socket ?? nativeSocket
  const now = deps.now ?? Date.now
  const perConn = deps.perConn ?? STREAM_PER_CONN
  const maxConns = deps.maxConns ?? STREAM_MAX_CONNS
  const url = `${STREAM_URL}?token=${encodeURIComponent(key)}&vsn=2.0.0`
  const secrets = [key, encodeURIComponent(key)].filter((s) => s !== "")
  /** Text safe to log: the key replaced, and capped. */
  const scrub = (v: unknown): string => {
    let s = v instanceof Error ? v.message : String(v)
    for (const k of secrets) s = s.split(k).join("***")
    return s.slice(0, 300)
  }
  const safely = (fn: () => void) => {
    try {
      fn()
    } catch {}
  }

  let mode: "shards" | "firehose" = "shards"
  let probing = true
  let stopped = false
  let tracked = new Set<string>()
  let shards: Conn[] = []
  let hose: Conn | null = null
  let refusedInARow = 0
  let conns = 0
  let lastRef = 0
  const nextRef = () => String(++lastRef)
  let meter = { since: now(), messages: 0, bytes: 0, events: 0 }
  let meterTimer: ReturnType<typeof setInterval> | null = null
  let endProbe: ((accepted: number | null) => void) | null = null

  const topicOf = (slug: string) => `${TOPIC_PREFIX}${slug}`
  const joinPayload = { event_types: STREAM_EVENT_TYPES }

  function send(c: Conn, frame: unknown[]) {
    try {
      c.ws?.send(JSON.stringify(frame))
    } catch (err) {
      log("warn", "opensea stream send failed", { conn: c.name, error: scrub(err) })
    }
  }

  function join(c: Conn, slug: string) {
    const ref = nextRef()
    c.pending.set(ref, slug)
    c.joinRefs.set(slug, ref)
    send(c, [ref, ref, topicOf(slug), "phx_join", joinPayload])
  }

  function leave(c: Conn, slug: string) {
    for (const [ref, s] of c.pending) if (s === slug) c.pending.delete(ref)
    const joinRef = c.joinRefs.get(slug) ?? null
    c.joinRefs.delete(slug)
    send(c, [joinRef, nextRef(), topicOf(slug), "phx_leave", {}])
  }

  function newConn(kind: Conn["kind"], topics: string[]): Conn {
    const c: Conn = {
      name: kind === "firehose" ? "firehose" : `shard-${++conns}`,
      kind,
      topics: new Set(topics),
      ws: null,
      open: false,
      pending: new Map(),
      joinRefs: new Map(),
      heartbeatRef: null,
      heartbeat: null,
      retry: null,
      downTimer: null,
      attempt: 0,
      openedAt: null,
      downSince: null,
      proven: false,
      retired: false,
    }
    markDown(c)
    return c
  }

  /** Closes the socket, if any, without hearing from it again. */
  function detach(c: Conn) {
    const ws = c.ws
    c.ws = null
    c.open = false
    if (c.heartbeat) clearInterval(c.heartbeat)
    c.heartbeat = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    safely(() => ws.close())
  }

  function retire(c: Conn) {
    c.retired = true
    detach(c)
    if (c.retry) clearTimeout(c.retry)
    if (c.downTimer) clearTimeout(c.downTimer)
  }

  function markDown(c: Conn) {
    if (c.downSince !== null) return
    c.downSince = now()
    c.downTimer = setTimeout(() => {
      if (stopped || c.retired || c.open) return
      const minutes = STREAM_DOWN_REPORT_MS / 60_000
      log("error", "opensea stream connection down", { conn: c.name, minutes })
      safely(() => report(new Error(`opensea stream ${c.name} down for over ${minutes} minutes`)))
    }, STREAM_DOWN_REPORT_MS)
  }

  function connect(c: Conn) {
    c.retry = null
    if (stopped || c.retired) return
    let ws: WebSocketLike
    try {
      ws = socket(url)
    } catch (err) {
      log("warn", "opensea stream connect failed", { conn: c.name, error: scrub(err) })
      lost(c)
      return
    }
    c.ws = ws
    ws.onopen = () => opened(c)
    ws.onmessage = (raw) => message(c, raw)
    ws.onclose = (code, reason) => {
      log("warn", "opensea stream closed", { conn: c.name, code, reason: scrub(reason) })
      lost(c)
    }
  }

  function opened(c: Conn) {
    c.open = true
    c.openedAt = now()
    c.downSince = null
    if (c.downTimer) clearTimeout(c.downTimer)
    c.downTimer = null
    c.pending.clear()
    c.joinRefs.clear()
    c.heartbeatRef = null
    for (const slug of c.topics) join(c, slug)
    c.heartbeat = setInterval(() => {
      if (c.heartbeatRef !== null) {
        log("warn", "opensea stream heartbeat missed", { conn: c.name })
        lost(c)
        return
      }
      c.heartbeatRef = nextRef()
      send(c, [null, c.heartbeatRef, "phoenix", "heartbeat", {}])
    }, STREAM_HEARTBEAT_MS)
  }

  /** The connection is gone: count a refused new shard, or reconnect after the backoff. */
  function lost(c: Conn) {
    detach(c)
    if (stopped || c.retired) return
    if (c.kind === "shard" && !c.proven) {
      refusedInARow++
      log("warn", "opensea stream shard refused", { conn: c.name, inARow: refusedInARow })
      if (refusedInARow >= STREAM_REFUSED_TO_FIREHOSE) {
        toFirehose(`${refusedInARow} new shards refused in a row`)
        return
      }
    }
    markDown(c)
    if (c.openedAt !== null && now() - c.openedAt >= STREAM_BACKOFF_RESET_MS) c.attempt = 0
    c.openedAt = null
    const wait = STREAM_BACKOFF_MS[Math.min(c.attempt, STREAM_BACKOFF_MS.length - 1)]!
    c.attempt++
    c.retry = setTimeout(() => connect(c), wait)
  }

  function message(c: Conn, raw: string) {
    if (c.kind === "firehose") {
      meter.messages++
      meter.bytes += Buffer.byteLength(raw)
    }
    const f = parseStreamFrame(raw)
    if (!f) return
    if (f.event === "phx_reply") return reply(c, f)
    const slug =
      c.kind === "firehose"
        ? payloadSlug(f.body)
        : f.topic.startsWith(TOPIC_PREFIX)
          ? f.topic.slice(TOPIC_PREFIX.length)
          : null
    if (slug === null || !tracked.has(slug)) return
    const e = toEvent(f, slug, now())
    if (!e) return
    if (c.kind === "firehose") meter.events++
    try {
      onEvent(e)
    } catch (err) {
      log("warn", "opensea stream event not handled", { slug, type: e.type, error: scrub(err) })
    }
  }

  function reply(c: Conn, f: OsStreamFrame) {
    if (f.topic === "phoenix") {
      if (f.ref !== null && f.ref === c.heartbeatRef) c.heartbeatRef = null
      return
    }
    const slug = f.ref === null ? undefined : c.pending.get(f.ref)
    if (slug === undefined || f.ref === null) return
    c.pending.delete(f.ref)
    const status = obj(f.body)?.status
    if (status === "ok") {
      if (!c.proven) {
        c.proven = true
        refusedInARow = 0
      }
      return
    }
    log("warn", "opensea stream join failed", {
      conn: c.name,
      slug,
      status: typeof status === "string" ? status : null,
    })
    if (!c.proven && c.pending.size === 0) {
      log("warn", "opensea stream joins all failed", { conn: c.name })
      lost(c)
    }
  }

  function rebalance() {
    for (const c of shards)
      for (const slug of [...c.topics])
        if (!tracked.has(slug)) {
          c.topics.delete(slug)
          if (c.open) leave(c, slug)
        }
    const assigned = new Set(shards.flatMap((c) => [...c.topics]))
    const fresh: Conn[] = []
    for (const slug of tracked) {
      if (assigned.has(slug)) continue
      let c = shards.find((s) => s.topics.size < perConn)
      if (!c) {
        c = newConn("shard", [])
        shards.push(c)
        fresh.push(c)
      }
      c.topics.add(slug)
      if (c.open) join(c, slug)
    }
    for (const c of shards) if (c.topics.size === 0) retire(c)
    shards = shards.filter((c) => !c.retired)
    for (const c of fresh) connect(c)
  }

  function toFirehose(reason: string) {
    if (mode === "firehose") return
    mode = "firehose"
    log("warn", "opensea stream firehose", { reason })
    for (const c of shards) retire(c)
    shards = []
    hose = newConn("firehose", [ALL])
    meter = { since: now(), messages: 0, bytes: 0, events: 0 }
    meterTimer = setInterval(() => {
      const minutes = (now() - meter.since) / 60_000
      if (minutes > 0)
        log("info", "opensea firehose meter", {
          minutes: Math.round(minutes),
          messagesPerMin: Math.round(meter.messages / minutes),
          bytesPerMin: Math.round(meter.bytes / minutes),
          eventsPerMin: Math.round(meter.events / minutes),
        })
      meter = { since: now(), messages: 0, bytes: 0, events: 0 }
    }, FIREHOSE_METER_EVERY_MS)
    connect(hose)
  }

  /** Joins `perConn + 1` throwaway topics on one connection and counts the accepted joins. */
  function probe() {
    const n = perConn + 1
    const refs = new Set<string>()
    let replies = 0
    let accepted = 0
    let ws: WebSocketLike | null = null
    const timer = setTimeout(() => endProbe?.(null), STREAM_PROBE_TIMEOUT_MS)
    endProbe = (result) => {
      endProbe = null
      probing = false
      clearTimeout(timer)
      if (ws) {
        const w = ws
        w.onopen = null
        w.onmessage = null
        w.onclose = null
        safely(() => w.close())
      }
      if (stopped) return
      if (result === null) log("warn", "opensea stream probe inconclusive", {})
      else log("info", "opensea stream probe", { joins: n, accepted: result })
      if (result !== null && result < perConn)
        toFirehose(`the probe saw ${result} of ${n} joins accepted`)
      else if (mode === "shards") rebalance()
    }
    try {
      ws = socket(url)
    } catch (err) {
      log("warn", "opensea stream connect failed", { conn: "probe", error: scrub(err) })
      endProbe(null)
      return
    }
    const w = ws
    w.onopen = () => {
      for (let i = 1; i <= n; i++) {
        const ref = nextRef()
        refs.add(ref)
        safely(() =>
          w.send(JSON.stringify([ref, ref, topicOf(`${PROBE_SLUG}${i}`), "phx_join", {}])),
        )
      }
    }
    w.onmessage = (raw) => {
      const f = parseStreamFrame(raw)
      if (f?.event !== "phx_reply" || f.ref === null || !refs.delete(f.ref)) return
      replies++
      if (obj(f.body)?.status === "ok") accepted++
      if (replies === n) endProbe?.(accepted)
    }
    w.onclose = () => endProbe?.(null)
  }

  probe()

  return {
    setSlugs(slugs) {
      if (stopped) return
      tracked = new Set(slugs)
      if (mode === "shards" && tracked.size > perConn * maxConns)
        toFirehose(`${tracked.size} tracked collections, over ${perConn * maxConns}`)
      if (mode === "shards" && !probing) rebalance()
    },
    mode: () => mode,
    stop() {
      if (stopped) return
      stopped = true
      endProbe?.(null)
      for (const c of shards) retire(c)
      shards = []
      if (hose) retire(hose)
      hose = null
      if (meterTimer) clearInterval(meterTimer)
    },
  }
}

/**
 * The collections to stream, in order: manual marks other than `junk`, then `real` collections,
 * then `pending` collections minting now (a mint in the last 10 minutes), then any collection with
 * an on-chain sale in 7 days. A manual `junk` mark leaves the collection out entirely. Within each
 * group the most 7-day sales come first, ties by slug. Only collections with a slug.
 *
 * At most `TRACKED_CAP + 1` (1,001): when more than the cap qualify, the extra one makes the set
 * larger than the shards hold, and `setSlugs` switches the stream to the firehose.
 *
 * "Now" for the block windows is the chain cursor (see `assignTiers`); with no cursor yet, only
 * marks and `real` collections qualify.
 */
export async function trackedSlugs(sql: Sql): Promise<string[]> {
  const [cursor] = await sql<{ block: string }[]>`
    select block::text as block from indexer.cursors where source = ${CURSOR_ROW}`
  const head = cursor ? BigInt(cursor.block) : null
  const blockBefore = (seconds: number) =>
    head === null ? null : (head - BigInt(Math.floor(seconds / BLOCK_S))).toString()
  const salesCut = blockBefore(RANK_WINDOW_S)
  const mintCut = blockBefore(STILL_MINTING_S)
  const rows = await sql<{ slug: string }[]>`
    with sales as (
      select contract, count(*)::int as n from indexer.nft_sales
      where block >= ${salesCut}::bigint group by contract)
    select c.slug from indexer.nft_collections c
    left join indexer.nft_overrides o on o.contract = c.contract
    left join sales s on s.contract = c.contract
    cross join lateral (select case
      when o.contract is not null then 1
      when c.verdict = 'real' then 2
      when c.verdict = 'pending' and exists (select 1 from indexer.nft_mints m
        where m.contract = c.contract and m.block >= ${mintCut}::bigint) then 3
      when s.n > 0 then 4 end as rank) r
    where c.slug is not null and r.rank is not null and o.verdict is distinct from 'junk'
    order by r.rank, coalesce(s.n, 0) desc, c.slug
    limit ${TRACKED_CAP + 1}`
  return [...new Set(rows.map((r) => r.slug))]
}
