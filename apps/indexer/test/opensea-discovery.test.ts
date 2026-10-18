import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { NftCollectionEvent, NftDropEvent } from "@ink-indexer/events"
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Logger } from "../src/log"
import type { NftBatch } from "../src/sources/nft/index"
import { writeRows } from "../src/sources/nft/write"
import type { Budget } from "../src/sources/opensea/budget"
import { createDiscoveryJob, createMetadataJob } from "../src/sources/opensea/discovery"
import { createDropsJob } from "../src/sources/opensea/drops"
import { createOpenSeaRest } from "../src/sources/opensea/rest"
import { createScheduler, type Job, startScheduler } from "../src/sources/opensea/scheduler"
import { createSnapshots, snapshotHash } from "../src/sources/opensea/snapshot"
import { createStore, type Store } from "../src/store"
import { type FakeResponse, fakeFetch, recorded } from "./opensea/fake-fetch"

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const PRTSCN = "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448"
const WIRED = "0x7c701c0148e0e965065aa05e008ac9341e6efc6c"
const INKVERSE = "0xfffbd67f37e1e9fd9d9ebef9b687daa72a33da64"
const KEY = "test-key-0123456789abcdef"
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.parse("2026-10-19T00:00:00Z")

let sql: Sql
let store: Store
let clock: number
let budgetOpen: boolean
let reports: unknown[]
let logs: [string, string][]

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  clock = T0
  budgetOpen = true
  reports = []
  logs = []
  // Off-chain events are stamped with the chain cursor, so it needs a block.
  await store.writeBatch([], [], {
    cursor: { block: 100n, hash: `0x${"11".repeat(32)}` },
    head: 100n,
  })
})
afterEach(() => sql.end())

const now = () => clock
const log: Logger = (level, msg) => void logs.push([level, msg])
const report = (e: unknown) => void reports.push(e)
const budget: Budget = { take: async () => budgetOpen, block: async () => {} }

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const fetch = fakeFetch(routes)
  const rest = createOpenSeaRest({ key: KEY, budget, fetch, log, report, now })
  const snapshots = createSnapshots({ sql, store, now })
  const deps = { sql, store, rest, snapshots, log, now }
  const jobs = [createDiscoveryJob(deps), createMetadataJob(deps), createDropsJob(deps)]
  const scheduler = createScheduler(jobs, { sql, log, report, now })
  return { fetch, rest, snapshots, jobs, scheduler, deps }
}

/** A collection row as the chain source leaves it, due for discovery at the test clock. */
async function addCollection(contract: string, extra: Record<string, unknown> = {}) {
  const row = {
    contract,
    standard: "erc721",
    next_discovery_at: new Date(T0),
    ...extra,
  }
  await sql`insert into indexer.nft_collections ${sql(row)}`
}
// biome-ignore lint/suspicious/noExplicitAny: rows are read by column name
type Row = Record<string, any>
const rowOf = async (contract: string): Promise<Row> =>
  (await sql`select * from indexer.nft_collections where contract = ${contract}`)[0] as Row
const eventsOf = async <T>(type: string) =>
  (
    await sql<{ tx_hash: string; payload: T }[]>`
    select tx_hash, payload from indexer.events where type = ${type} order by id`
  ).map((r) => ({
    txHash: r.tx_hash,
    ...r.payload,
  })) as (T & { txHash: string })[]
const at = (ms: number) => new Date(ms).toISOString()

const discoveryRoutes = (contract: string, slug: string) => ({
  [`/chain/ink/contract/${contract}`]: recorded(`contract/${contract}`),
  [`/collections/${slug}`]: recorded(`collections/${slug}`),
})

function emptyBatch(over: Partial<NftBatch>): NftBatch {
  return {
    events: [],
    blocks: [],
    mints: [],
    burns: [],
    seadropMints: [],
    seadropConfig: [],
    sales: [],
    launches: [],
    collections: [],
    stages: [],
    milestones: [],
    touched: [],
    ...over,
  }
}
const write = (batch: NftBatch) => sql.begin((tx) => writeRows(tx, batch))
const touch = (contract: string, over: object = {}) => ({
  contract: contract as `0x${string}`,
  standard: "erc721" as const,
  firstMint: null,
  seadrop: false,
  launch: null,
  ...over,
})

describe("discovery", () => {
  it("a new contract is discovered: slug, socials stored, nft.collection written once", async () => {
    const s = setup(discoveryRoutes(HORNET, "ink-hornet"))
    await addCollection(HORNET)
    await s.scheduler.tick()

    const row = await rowOf(HORNET)
    expect(row).toMatchObject({
      slug: "ink-hornet",
      name: "Ink Hornet",
      twitter: "inkthehornet",
      website: "https://www.inkhornet.com/",
      discord: null,
      safelist: "not_requested",
      opensea_url: "https://opensea.io/collection/ink-hornet",
      max_rank: 2222,
      discovery_attempts: 0,
      next_discovery_at: null,
      verdict_dirty: true,
      verdict: "pending",
      snapshot_n: 1,
    })
    expect(row.image_url).toMatch(/^https:\/\//)
    expect(at(row.rarity_calculated_at.getTime())).toBe("2026-10-18T12:08:38.783Z")
    expect(at(row.discovered_at.getTime())).toBe(at(T0))
    expect(at(row.next_metadata_at.getTime())).toBe(at(T0 + DAY))
    expect(row.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)

    const events = await eventsOf<NftCollectionEvent>("nft.collection")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      txHash: `os:col:${HORNET}:1`,
      source: "opensea",
      logIndex: 0,
      contract: HORNET,
      blockTimestamp: T0 / 1000,
      blockNumber: "100",
      slug: "ink-hornet",
      name: "Ink Hornet",
      links: { twitter: "inkthehornet", website: "https://www.inkhornet.com/", discord: null },
      standard: "erc721",
      verdict: "pending",
      manual: false,
      launchpad: null,
      launchToken: null,
      maxRank: 2222,
    })
    expect(events[0]?.gates).toEqual({
      page: "pending",
      structure: "pending",
      traits: "pending",
      farm: "pending",
      farmShareBps: null,
    })

    // Found: it is not asked about again.
    const calls = s.fetch.calls.length
    clock += 11_000
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(calls)
    expect(await eventsOf("nft.collection")).toHaveLength(1)
    expect(reports).toEqual([])
  })

  it("takes the standard from OpenSea when the chain has not shown one", async () => {
    const s = setup(discoveryRoutes(HORNET, "ink-hornet"))
    await addCollection(HORNET, { standard: null, seadrop: true })
    await s.scheduler.tick()
    expect((await rowOf(HORNET)).standard).toBe("erc721")
    expect(await eventsOf("nft.collection")).toHaveLength(1)
  })

  it("no slug: retries at 5m, 30m, 2h, 6h then daily; gives up after 7 days", async () => {
    const s = setup({
      [`/chain/ink/contract/${WIRED}`]: { status: 404, body: { errors: ["not found"] } },
    })
    await addCollection(WIRED)
    const offsets: number[] = []
    let seen = 0
    for (let i = 0; i < 40; i++) {
      await s.scheduler.tick()
      if (s.fetch.calls.length > seen) {
        seen = s.fetch.calls.length
        offsets.push(clock - T0)
      }
      const next = (await rowOf(WIRED)).next_discovery_at as Date | null
      if (next === null) break
      // Shortly before it is due, nothing is asked.
      clock = next.getTime() - 20_000
      await s.scheduler.tick()
      expect(s.fetch.calls).toHaveLength(seen)
      clock = next.getTime()
    }
    expect(offsets).toEqual([
      0,
      5 * MIN,
      35 * MIN,
      35 * MIN + 2 * HOUR,
      35 * MIN + 8 * HOUR,
      35 * MIN + 8 * HOUR + DAY,
      35 * MIN + 8 * HOUR + 2 * DAY,
      35 * MIN + 8 * HOUR + 3 * DAY,
      35 * MIN + 8 * HOUR + 4 * DAY,
      35 * MIN + 8 * HOUR + 5 * DAY,
      35 * MIN + 8 * HOUR + 6 * DAY,
    ])
    // The last try is inside the 7 days; the next would have been after them.
    expect(offsets.at(-1)).toBeLessThanOrEqual(7 * DAY)
    const row = await rowOf(WIRED)
    expect(row).toMatchObject({ slug: null, discovery_attempts: 11, next_discovery_at: null })
    expect(await eventsOf("nft.collection")).toHaveLength(0)

    clock += 30 * DAY
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(seen)
    expect(reports).toEqual([])
  })

  it("a slug that OpenSea cannot show yet counts as an attempt too", async () => {
    const s = setup({
      [`/chain/ink/contract/${HORNET}`]: recorded(`contract/${HORNET}`),
      "/collections/ink-hornet": { status: 404, body: {} },
    })
    await addCollection(HORNET)
    await s.scheduler.tick()
    expect(await rowOf(HORNET)).toMatchObject({
      slug: null,
      discovery_attempts: 1,
      next_discovery_at: new Date(T0 + 5 * MIN),
    })
  })

  it("a transient error retries in five minutes without counting an attempt", async () => {
    const s = setup({ [`/chain/ink/contract/${HORNET}`]: { status: 500, body: {} } })
    await addCollection(HORNET)
    await s.scheduler.tick()
    expect(await rowOf(HORNET)).toMatchObject({
      discovery_attempts: 0,
      next_discovery_at: new Date(T0 + 5 * MIN),
    })
    expect(reports).toEqual([])
  })

  it("new activity on a contract with no slug restarts discovery; a contract with a slug is left alone", async () => {
    const s = setup({
      [`/chain/ink/contract/${WIRED}`]: { status: 404, body: {} },
    })
    await addCollection(WIRED)
    // Given up.
    await sql`update indexer.nft_collections set discovery_attempts = 11, next_discovery_at = null where contract = ${WIRED}`
    await addCollection(PRTSCN, {
      slug: "prtscn-ink",
      discovery_attempts: 0,
      next_discovery_at: null,
    })
    const before = Date.now()
    await write(
      emptyBatch({
        collections: [touch(WIRED), touch(PRTSCN)],
        mints: [
          {
            txHash: `0x${"aa".repeat(32)}`,
            logIndex: 0,
            idx: 0,
            contract: WIRED,
            tokenId: 1n,
            account: "0x00000000000000000000000000000000000000aa",
            qty: 1n,
            block: 90n,
          },
          {
            txHash: `0x${"bb".repeat(32)}`,
            logIndex: 0,
            idx: 0,
            contract: PRTSCN,
            tokenId: 1n,
            account: "0x00000000000000000000000000000000000000aa",
            qty: 1n,
            block: 90n,
          },
        ],
      }),
    )
    const wired = await rowOf(WIRED)
    expect(wired.discovery_attempts).toBe(0)
    expect(wired.next_discovery_at.getTime()).toBeGreaterThanOrEqual(before - 1_000)
    expect(wired.next_discovery_at.getTime()).toBeLessThan(Date.now() + 1_000)
    expect(await rowOf(PRTSCN)).toMatchObject({ next_discovery_at: null, discovery_attempts: 0 })

    // A pending retry is pulled forward to five minutes, never pushed back.
    await sql`update indexer.nft_collections set discovery_attempts = 4, next_discovery_at = now() + interval '6 hours' where contract = ${WIRED}`
    await write(emptyBatch({ collections: [touch(WIRED)], sales: [saleOf(WIRED)] }))
    const pulled = await rowOf(WIRED)
    expect(pulled.discovery_attempts).toBe(0)
    expect(pulled.next_discovery_at.getTime()).toBeLessThanOrEqual(Date.now() + 5 * MIN + 1_000)
    await sql`update indexer.nft_collections set discovery_attempts = 2, next_discovery_at = now() + interval '1 minute' where contract = ${WIRED}`
    await write(emptyBatch({ collections: [touch(WIRED)], sales: [saleOf(WIRED)] }))
    const kept = await rowOf(WIRED)
    expect(kept.discovery_attempts).toBe(0)
    expect(kept.next_discovery_at.getTime()).toBeLessThanOrEqual(Date.now() + MIN + 1_000)
    expect(s.fetch.calls).toHaveLength(0)
  })

  it("a new collection row is due for discovery at once", async () => {
    const before = Date.now()
    await write(emptyBatch({ collections: [touch(HORNET)] }))
    const row = await rowOf(HORNET)
    expect(row.next_discovery_at.getTime()).toBeGreaterThanOrEqual(before - 1_000)
    expect(row.next_discovery_at.getTime()).toBeLessThan(Date.now() + 1_000)
    // Seen again, it keeps its schedule.
    await sql`update indexer.nft_collections set next_discovery_at = null where contract = ${HORNET}`
    await write(emptyBatch({ collections: [touch(HORNET)] }))
    expect((await rowOf(HORNET)).next_discovery_at).toBeNull()
  })

  it("a collection that already has a SeaDrop page gets a drops fetch after discovery", async () => {
    const s = setup(discoveryRoutes(HORNET, "ink-hornet"))
    await addCollection(HORNET, { seadrop: true })
    await createScheduler([s.jobs[0]!], { sql, log, report, now }).tick()
    expect((await rowOf(HORNET)).next_drops_at).toEqual(new Date(T0))

    const t = setup(discoveryRoutes(PRTSCN, "prtscn-ink"))
    await addCollection(PRTSCN, { seadrop: false })
    await createScheduler([t.jobs[0]!], { sql, log, report, now }).tick()
    expect((await rowOf(PRTSCN)).next_drops_at).toBeNull()
  })
})

function saleOf(contract: string): NftBatch["sales"][number] {
  return {
    txHash: `0x${"cc".repeat(32)}`,
    logIndex: 3,
    contract: contract as `0x${string}`,
    tokenId: 7n,
    qty: 1n,
    priceWei: 1n,
    currency: "ETH",
    buyer: "0x00000000000000000000000000000000000000aa",
    seller: "0x00000000000000000000000000000000000000bb",
    orderHash: `0x${"dd".repeat(32)}`,
    block: 90n,
  }
}

describe("metadata refresh", () => {
  it("fetches the collection daily; an unchanged page writes nothing, a changed safelist writes one event", async () => {
    let safelist = "not_requested"
    const collection = recorded("collections/ink-hornet")
    const s = setup({
      [`/chain/ink/contract/${HORNET}`]: recorded(`contract/${HORNET}`),
      "/collections/ink-hornet": () => ({
        status: 200,
        body: { ...(collection.body as object), safelist_status: safelist },
      }),
    })
    await addCollection(HORNET)
    await s.scheduler.tick()
    expect(await eventsOf("nft.collection")).toHaveLength(1)
    await sql`update indexer.nft_collections set verdict_dirty = false where contract = ${HORNET}`

    // Not yet due.
    clock = T0 + DAY - 2 * MIN
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(2)

    // Due, unchanged.
    clock = T0 + DAY
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(3)
    let row = await rowOf(HORNET)
    expect(at(row.next_metadata_at.getTime())).toBe(at(T0 + 2 * DAY))
    expect(row.verdict_dirty).toBe(false)
    expect(await eventsOf("nft.collection")).toHaveLength(1)

    // Due, safelist changed.
    safelist = "verified"
    clock = T0 + 2 * DAY
    await s.scheduler.tick()
    row = await rowOf(HORNET)
    expect(row).toMatchObject({ safelist: "verified", verdict_dirty: true, snapshot_n: 2 })
    const events = await eventsOf<NftCollectionEvent>("nft.collection")
    expect(events.map((e) => e.txHash)).toEqual([`os:col:${HORNET}:1`, `os:col:${HORNET}:2`])
    expect(events[1]?.safelist).toBe("verified")
  })
})

describe("drops", () => {
  const configLog = (contract: string) =>
    emptyBatch({
      collections: [touch(contract, { seadrop: true })],
      seadropConfig: [
        {
          txHash: `0x${"ee".repeat(32)}`,
          logIndex: 1,
          contract: contract as `0x${string}`,
          event: "PublicDropUpdated",
          fields: {},
          block: 95n,
        },
      ],
    })

  it("drop fetched after a config log and nft.drop written; unchanged refetch writes nothing", async () => {
    clock = Date.now()
    const s = setup({ "/drops/ink-hornet": recorded("drops/ink-hornet") })
    await addCollection(HORNET, { slug: "ink-hornet", next_discovery_at: null, seadrop: true })
    await write(configLog(HORNET))
    const due = (await rowOf(HORNET)).next_drops_at as Date
    expect(due.getTime()).toBeGreaterThan(Date.now() + 4 * MIN)
    expect(due.getTime()).toBeLessThanOrEqual(Date.now() + 5 * MIN + 1_000)

    // A second log does not push it back.
    await write(configLog(HORNET))
    expect((await rowOf(HORNET)).next_drops_at).toEqual(due)

    // Not before it is due.
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(0)

    // The database keeps microseconds, a Date milliseconds.
    clock = due.getTime() + 1
    await s.scheduler.tick()
    expect(s.fetch.calls.map((c) => c.path)).toEqual(["/drops/ink-hornet"])
    const events = await eventsOf<NftDropEvent>("nft.drop")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      txHash: `os:drop:${HORNET}:1`,
      source: "opensea",
      logIndex: 0,
      contract: HORNET,
      slug: "ink-hornet",
      maxSupply: "2222",
      blockNumber: "100",
      blockTimestamp: Math.floor(clock / 1000),
    })
    expect(events[0]?.stages.map((x) => x.label)).toEqual(["Team", "GTD", "FCFS", "Public stage"])
    expect(events[0]?.stages[3]).toEqual({
      type: "public_sale",
      label: "Public stage",
      priceWei: "500000000000000",
      startTime: Date.parse("2026-09-06T17:00:00Z") / 1000,
      endTime: Date.parse("2026-09-27T17:00:00Z") / 1000,
      maxPerWallet: 10,
      allowlistCount: null,
    })
    let row = await rowOf(HORNET)
    expect(at(row.drop_first_start.getTime())).toBe("2026-09-06T09:00:00.000Z")
    // The first start is past, so nothing more is scheduled.
    expect(row).toMatchObject({ drop_n: 1, next_drops_at: null, verdict_dirty: true })
    const [stored] = await sql`select * from indexer.nft_drops where contract = ${HORNET}`
    expect(stored).toMatchObject({ slug: "ink-hornet", max_supply: "2222" })
    expect(stored?.stages).toHaveLength(4)
    expect(stored?.fetched_at.getTime()).toBe(clock)

    // Another config log, same drop: fetched again, nothing written.
    await sql`update indexer.nft_collections set verdict_dirty = false where contract = ${HORNET}`
    await write(configLog(HORNET))
    clock += 6 * MIN
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(2)
    expect(await eventsOf("nft.drop")).toHaveLength(1)
    row = await rowOf(HORNET)
    expect(row).toMatchObject({ drop_n: 1, next_drops_at: null, verdict_dirty: false })
    const [again] = await sql`select fetched_at from indexer.nft_drops where contract = ${HORNET}`
    expect(again?.fetched_at.getTime()).toBe(clock)
  })

  it("writes a new nft.drop when a stage changes", async () => {
    clock = T0
    const drop = recorded("drops/ink-hornet").body as { stages: { price: string; label: string }[] }
    let price = "500000000000000"
    const s = setup({
      "/drops/ink-hornet": () => ({
        status: 200,
        body: {
          ...drop,
          stages: drop.stages.map((x) => (x.label === "Public stage" ? { ...x, price } : x)),
        },
      }),
    })
    await addCollection(HORNET, {
      slug: "ink-hornet",
      next_discovery_at: null,
      next_drops_at: new Date(T0),
    })
    await s.scheduler.tick()
    price = "400000000000000"
    await sql`update indexer.nft_collections set next_drops_at = ${new Date(T0)} where contract = ${HORNET}`
    clock += 11_000
    await s.scheduler.tick()
    const events = await eventsOf<NftDropEvent>("nft.drop")
    expect(events.map((e) => e.txHash)).toEqual([`os:drop:${HORNET}:1`, `os:drop:${HORNET}:2`])
    expect(
      new Set(events.map((e) => e.stages.find((x) => x.label === "Public stage")?.priceWei)),
    ).toEqual(new Set(["500000000000000", "400000000000000"]))
  })

  it("schedules a refetch an hour before the first stage starts", async () => {
    const start = T0 + 3 * DAY
    const drop = recorded("drops/inkverse-920024436").body as {
      stages: { start_time: string; end_time: string | null }[]
    }
    const s = setup({
      "/drops/inkverse-920024436": {
        status: 200,
        body: {
          ...drop,
          stages: drop.stages.map((x, i) => ({
            ...x,
            start_time: new Date(start + i * HOUR).toISOString(),
            end_time: null,
          })),
        },
      },
    })
    await addCollection(INKVERSE, {
      slug: "inkverse-920024436",
      next_discovery_at: null,
      next_drops_at: new Date(T0),
    })
    await s.scheduler.tick()
    const row = await rowOf(INKVERSE)
    expect(at(row.drop_first_start.getTime())).toBe(at(start))
    expect(at(row.next_drops_at.getTime())).toBe(at(start - HOUR))
  })

  it("a collection with no drop page is not asked again until a config log", async () => {
    const s = setup({ "/drops/prtscn-ink": recorded("drops/prtscn-ink") })
    await addCollection(PRTSCN, {
      slug: "prtscn-ink",
      next_discovery_at: null,
      next_drops_at: new Date(T0),
    })
    await s.scheduler.tick()
    expect(await rowOf(PRTSCN)).toMatchObject({ next_drops_at: null, drop_n: 0 })
    expect(await eventsOf("nft.drop")).toHaveLength(0)
    expect(await sql`select 1 from indexer.nft_drops`).toHaveLength(0)
    clock += DAY
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(1)
  })

  it("waits for the slug: a due drops time with no slug is not fetched", async () => {
    const s = setup({})
    await addCollection(HORNET, { next_discovery_at: null, next_drops_at: new Date(T0) })
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(0)
  })
})

const reverseKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(reverseKeys)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .reverse()
            .map(([k, x]) => [k, reverseKeys(x)]),
        )
      : v

describe("snapshot", () => {
  const fields = {
    slug: "ink-hornet",
    name: "Ink Hornet",
    image_url: "https://example.test/i.png",
    twitter: "inkthehornet",
    website: "https://example.test",
    safelist: "not_requested",
    next_discovery_at: null,
  }

  it("unchanged writes nothing; a changed safelist writes one event", async () => {
    const snapshots = createSnapshots({ sql, store, now })
    await addCollection(HORNET, fields)
    expect(await snapshots.emitSnapshotIfChanged(HORNET)).toBe(true)
    expect(await snapshots.emitSnapshotIfChanged(HORNET)).toBe(false)
    clock += 5_000
    expect(await snapshots.emitSnapshotIfChanged(HORNET)).toBe(false)
    expect(await eventsOf("nft.collection")).toHaveLength(1)

    expect(await snapshots.emitSnapshotIfChanged(HORNET, { safelist: "verified" })).toBe(true)
    const events = await eventsOf<NftCollectionEvent>("nft.collection")
    expect(events.map((e) => [e.txHash, e.safelist])).toEqual([
      [`os:col:${HORNET}:1`, "not_requested"],
      [`os:col:${HORNET}:2`, "verified"],
    ])
    expect((await rowOf(HORNET)).safelist).toBe("verified")
    expect(await snapshots.emitSnapshotIfChanged(HORNET)).toBe(false)
  })

  it("a patch that changes nothing in the event is stored without one", async () => {
    const snapshots = createSnapshots({ sql, store, now })
    await addCollection(HORNET, fields)
    await snapshots.emitSnapshotIfChanged(HORNET)
    expect(await snapshots.emitSnapshotIfChanged(HORNET, { verdict_dirty: false })).toBe(false)
    expect((await rowOf(HORNET)).verdict_dirty).toBe(false)
    expect(await eventsOf("nft.collection")).toHaveLength(1)
  })

  it("the hash ignores the base fields and nothing else", async () => {
    const snapshots = createSnapshots({ sql, store, now })
    await addCollection(HORNET, fields)
    await snapshots.emitSnapshotIfChanged(HORNET)
    const [e] = await eventsOf<NftCollectionEvent>("nft.collection")
    const same = { ...e!, txHash: "os:col:x:9", logIndex: 4, blockNumber: "5", blockTimestamp: 1 }
    expect(snapshotHash(same)).toBe(snapshotHash(e!))
    expect(snapshotHash({ ...e!, name: "Other" })).not.toBe(snapshotHash(e!))
    expect(snapshotHash({ ...e!, links: { ...e!.links, discord: "x" } })).not.toBe(snapshotHash(e!))
    // Key order is irrelevant.
    expect(snapshotHash(reverseKeys(e!) as NftCollectionEvent)).toBe(snapshotHash(e!))
    expect((await rowOf(HORNET)).snapshot_hash).toBe(snapshotHash(e!))
  })

  it("carries the launchpad and token of a Chimera collection, and marks gates that do not apply", async () => {
    const snapshots = createSnapshots({ sql, store, now })
    const token = "0x00000000000000000000000000000000000000cc"
    await addCollection(HORNET, {
      ...fields,
      kind: "continuous",
      launchpad: "chimera",
      launch_token: token,
      max_supply: "5000",
      seadrop: false,
    })
    await snapshots.emitSnapshotIfChanged(HORNET)
    const [e] = await eventsOf<NftCollectionEvent>("nft.collection")
    expect(e).toMatchObject({
      kind: "continuous",
      launchpad: "chimera",
      launchToken: token,
      maxSupply: "5000",
      seadrop: false,
    })
    expect(e?.gates).toEqual({
      page: "pending",
      structure: "n/a",
      traits: "pending",
      farm: "n/a",
      farmShareBps: null,
    })
  })

  it("a collection whose standard is not known yet writes no event", async () => {
    const snapshots = createSnapshots({ sql, store, now })
    await addCollection(HORNET, { ...fields, standard: null })
    expect(await snapshots.emitSnapshotIfChanged(HORNET)).toBe(false)
    expect(await eventsOf("nft.collection")).toHaveLength(0)
    expect(
      await snapshots.emitSnapshotIfChanged("0x0000000000000000000000000000000000000001"),
    ).toBe(false)
  })

  it("a failed event write leaves the patch unapplied", async () => {
    const snapshots = createSnapshots({ sql, store, now })
    await addCollection(HORNET, fields)
    await sql`delete from indexer.cursors`
    await expect(
      snapshots.emitSnapshotIfChanged(HORNET, { safelist: "verified" }),
    ).rejects.toThrow()
    expect(await rowOf(HORNET)).toMatchObject({ safelist: "not_requested", snapshot_n: 0 })
  })
})

describe("scheduler", () => {
  it("budget exhaustion defers the job instead of failing", async () => {
    const s = setup({
      ...discoveryRoutes(HORNET, "ink-hornet"),
      ...discoveryRoutes(WIRED, "wiredonink"),
    })
    await addCollection(HORNET)
    await addCollection(WIRED)
    budgetOpen = false
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(0)
    expect(await rowOf(HORNET)).toMatchObject({ slug: null, discovery_attempts: 0 })
    expect(await rowOf(WIRED)).toMatchObject({ slug: null, discovery_attempts: 0 })
    expect(reports).toEqual([])
    expect(logs.filter(([l]) => l === "error")).toEqual([])

    budgetOpen = true
    clock += 10_000
    await s.scheduler.tick()
    expect((await rowOf(HORNET)).slug).toBe("ink-hornet")
    expect((await rowOf(WIRED)).slug).toBe("wiredonink")
  })

  it("a rate limit defers without counting an attempt", async () => {
    const s = setup({
      [`/chain/ink/contract/${HORNET}`]: { status: 429, headers: { "retry-after": "30" } },
    })
    await addCollection(HORNET)
    await s.scheduler.tick()
    expect(await rowOf(HORNET)).toMatchObject({
      discovery_attempts: 0,
      next_discovery_at: new Date(T0),
    })
    expect(reports).toEqual([])
  })

  it("a refused key pauses every job for an hour", async () => {
    const s = setup({
      [`/chain/ink/contract/${HORNET}`]: { status: 401, body: {} },
      "/drops/prtscn-ink": recorded("drops/prtscn-ink"),
    })
    await addCollection(HORNET)
    await addCollection(PRTSCN, {
      slug: "prtscn-ink",
      next_discovery_at: null,
      next_drops_at: new Date(T0),
    })
    await s.scheduler.tick()
    // The drops job did not run after the discovery job was refused.
    expect(s.fetch.calls.map((c) => c.path)).toEqual([`/chain/ink/contract/${HORNET}`])
    expect(await rowOf(HORNET)).toMatchObject({ discovery_attempts: 0 })

    clock = T0 + HOUR - 1_000
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(1)
    clock = T0 + HOUR
    await s.scheduler.tick()
    expect(s.fetch.calls.length).toBeGreaterThan(1)
  })

  it("a job error is logged and reported, the other contracts still run, and it retries next tick", async () => {
    let fail = true
    const ran: string[] = []
    const jobs: Job[] = [
      {
        name: "flaky",
        everyMs: 10_000,
        due: async () => ["a", "b", "c"],
        run: async (c) => {
          ran.push(c)
          if (c === "a" && fail) throw new Error("db down")
        },
      },
      {
        name: "after",
        everyMs: 10_000,
        due: async () => ["z"],
        run: async (c) => void ran.push(c),
      },
    ]
    const sch = createScheduler(jobs, { sql, log, report, now })
    await sch.tick()
    expect(ran).toEqual(["a", "b", "c", "z"])
    expect(reports).toHaveLength(1)
    expect(logs).toContainEqual(["error", "opensea job failed"])
    fail = false
    clock += 10_000
    await sch.tick()
    expect(ran.slice(4)).toEqual(["a", "b", "c", "z"])
  })

  it("runs at most 20 contracts per job per tick, in order, and each job at its own pace", async () => {
    const ran: string[] = []
    const many = Array.from({ length: 30 }, (_, i) => `c${i}`)
    const jobs: Job[] = [
      { name: "many", everyMs: 10_000, due: async () => many, run: async (c) => void ran.push(c) },
      { name: "slow", everyMs: 60_000, due: async () => ["s"], run: async (c) => void ran.push(c) },
    ]
    const sch = createScheduler(jobs, { sql, log, report, now })
    await sch.tick()
    expect(ran).toEqual([...many.slice(0, 20), "s"])
    clock += 10_000
    await sch.tick()
    expect(ran.filter((c) => c === "s")).toHaveLength(1)
    clock += 50_000
    await sch.tick()
    expect(ran.filter((c) => c === "s")).toHaveLength(2)
  })

  it("a deferral stops that job for the tick but not the others", async () => {
    const ran: string[] = []
    const jobs: Job[] = [
      {
        name: "starved",
        everyMs: 10_000,
        due: async () => ["a", "b"],
        run: async (c) => {
          ran.push(c)
          return "deferred"
        },
      },
      {
        name: "other",
        everyMs: 10_000,
        due: async () => ["z"],
        run: async (c) => void ran.push(c),
      },
    ]
    await createScheduler(jobs, { sql, log, report, now }).tick()
    expect(ran).toEqual(["a", "z"])
  })

  it("a failing due query is reported and does not stop the other jobs", async () => {
    const ran: string[] = []
    const jobs: Job[] = [
      {
        name: "broken",
        everyMs: 10_000,
        due: async () => {
          throw new Error("no table")
        },
        run: async () => {},
      },
      {
        name: "other",
        everyMs: 10_000,
        due: async () => ["z"],
        run: async (c) => void ran.push(c),
      },
    ]
    await createScheduler(jobs, { sql, log, report, now }).tick()
    expect(ran).toEqual(["z"])
    expect(reports).toHaveLength(1)
  })

  it("startScheduler ticks on an interval until stopped", async () => {
    vi.useFakeTimers()
    try {
      let runs = 0
      const stop = startScheduler(
        [{ name: "j", everyMs: 0, due: async () => ["a"], run: async () => void runs++ }],
        { sql, log, report, tickMs: 10_000 },
      )
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(runs).toBe(2)
      stop()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(runs).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

export type { FakeResponse }
