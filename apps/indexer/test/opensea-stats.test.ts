import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { NftStatsEvent } from "@ink-indexer/events"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import type { NftBatch } from "../src/sources/nft/index"
import { writeRows } from "../src/sources/nft/write"
import type { Budget } from "../src/sources/opensea/budget"
import { createOpenSeaRest } from "../src/sources/opensea/rest"
import { createScheduler } from "../src/sources/opensea/scheduler"
import {
  assignTiers,
  createStats,
  latestFloors,
  planTiers,
  type TierCandidate,
} from "../src/sources/opensea/stats"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import { type FakeRequest, type FakeResponse, fakeFetch, recorded } from "./opensea/fake-fetch"

const KEY = "test-key-0123456789abcdef"
const SEC = 1000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.parse("2026-10-19T00:00:00Z")
/** The chain cursor: "now" in blocks, one a second. */
const HEAD = 10_000_000
const ETH = 10n ** 18n

let sql: Sql
let store: Store
let chain: FakeChain
let clock: number
let reports: unknown[]
let takeBudget: () => Promise<boolean>

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  chain = new FakeChain(10n)
  clock = T0
  reports = []
  takeBudget = async () => true
  // Off-chain events are stamped with the chain cursor.
  await store.writeBatch([], [], {
    cursor: { block: BigInt(HEAD), hash: `0x${"11".repeat(32)}` },
    head: BigInt(HEAD),
  })
})
afterEach(() => sql.end())

const now = () => clock
const log: Logger = () => {}
const report = (e: unknown) => void reports.push(e)
const budget: Budget = { take: () => takeBudget(), block: async () => {} }

/** OpenSea's stats body: prices are floats in ETH. */
const osStats = (o: {
  floor?: number | null
  owners?: number
  volume?: number
  sales?: number
}): FakeResponse => ({
  status: 200,
  body: {
    total: { floor_price: o.floor ?? null, num_owners: o.owners ?? 10 },
    intervals: [{ interval: "one_day", volume: o.volume ?? 0, sales: o.sales ?? 0 }],
  },
})

/** A page of the best-listings endpoint: `n` listings and a cursor, if there is one. */
const listings = (n: number, next: string | null): FakeResponse => ({
  status: 200,
  body: { listings: Array.from({ length: n }, (_, i) => ({ order_hash: `0x${i}` })), next },
})

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const fetch = fakeFetch(routes)
  const rest = createOpenSeaRest({ key: KEY, budget, fetch, log, report, now })
  const stats = createStats({ sql, store, rest, chain, log, now })
  return { fetch, rest, stats }
}
const callsTo = (fetch: { calls: FakeRequest[] }, path: string) =>
  fetch.calls.filter((c) => c.path === path).length

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const A = addr(0xa1)
const B = addr(0xb2)
const slugOf = (contract: string) => `slug-${contract.slice(-4)}`
const statsPath = (contract: string) => `/collections/${slugOf(contract)}/stats`
const listedPath = (contract: string) => `/listings/collection/${slugOf(contract)}/best`

async function addCollection(contract: string, extra: Record<string, unknown> = {}) {
  await sql`insert into indexer.nft_collections ${sql({
    contract,
    standard: "erc721",
    slug: slugOf(contract),
    next_discovery_at: null,
    ...extra,
  })}`
}
// biome-ignore lint/suspicious/noExplicitAny: rows are read by column name
type Row = Record<string, any>
const rowOf = async (contract: string): Promise<Row> =>
  (await sql`select * from indexer.nft_collections where contract = ${contract}`)[0] as Row
const statRows = async (contract: string) =>
  (await sql`select * from indexer.nft_stats where contract = ${contract} order by at`) as Row[]
const statsEvents = async () =>
  (
    await sql<{ tx_hash: string; payload: NftStatsEvent }[]>`
      select tx_hash, payload from indexer.events where type = 'nft.stats' order by id`
  ).map((r) => r.payload)
const tiers = async () =>
  Object.fromEntries(
    (
      await sql<{ contract: string; stats_tier: string | null }[]>`
      select contract, stats_tier from indexer.nft_collections`
    ).map((r) => [r.contract, r.stats_tier]),
  )

/** `n` sales of the contract, `ageS` seconds before the cursor block. */
async function addSales(contract: string, n: number, ageS: number) {
  const rows = Array.from({ length: n }, (_, i) => ({
    tx_hash: `0x${contract.slice(2, 10)}${ageS.toString(16)}${i.toString(16).padStart(8, "0")}`,
    log_index: 0,
    token_id: String(i),
    contract,
    qty: "1",
    price_wei: "1000",
    currency: "ETH",
    buyer: addr(1),
    seller: addr(2),
    order_hash: "0xaa",
    block: String(HEAD - ageS),
  }))
  if (rows.length > 0) await sql`insert into indexer.nft_sales ${sql(rows)}`
}
async function addMint(contract: string, ageS: number) {
  await sql`insert into indexer.nft_mints ${sql({
    tx_hash: `0xmint${contract.slice(-6)}`,
    log_index: 0,
    idx: 0,
    contract,
    token_id: "1",
    recipient: addr(3),
    qty: "1",
    block: String(HEAD - ageS),
  })}`
}

describe("tiers", () => {
  it("minting collection is hot; 31st by sales is warm; junk with a sale in 30 days is cold; idle is untiered", async () => {
    // 31 collections with 40, 39, ... 10 sales in the last 7 days.
    const sellers = Array.from({ length: 31 }, (_, i) => addr(0x100 + i))
    for (const [i, c] of sellers.entries()) {
      await addCollection(c)
      await addSales(c, 40 - i, DAY / SEC)
    }
    const minting = addr(0x200)
    await addCollection(minting, { verdict: "real" })
    await addMint(minting, 60)
    // Junk is never hot or warm, however much it sells or mints.
    const junkQuiet = addr(0x201)
    await addCollection(junkQuiet, { verdict: "junk" })
    await addSales(junkQuiet, 1, (10 * DAY) / SEC)
    const junkBusy = addr(0x202)
    await addCollection(junkBusy, { verdict: "junk" })
    await addSales(junkBusy, 100, DAY / SEC)
    await addMint(junkBusy, 30)
    // A sale 40 days ago is outside the window.
    const idle = addr(0x203)
    await addCollection(idle)
    await addSales(idle, 1, (40 * DAY) / SEC)
    // A mint without a slug cannot be asked about.
    const noSlug = addr(0x204)
    await addCollection(noSlug, { slug: null })
    await addMint(noSlug, 30)
    // Listed within 30 days but not sold: tracked, so warm.
    const listed = addr(0x205)
    await addCollection(listed, { last_listing_at: new Date(T0 - 5 * DAY) })

    await assignTiers(sql, new Date(T0))
    const t = await tiers()
    for (const c of sellers.slice(0, 30)) expect(t[c], c).toBe("hot")
    expect(t[sellers[30]!]).toBe("warm")
    expect(t[minting]).toBe("hot")
    expect(t[junkQuiet]).toBe("cold")
    expect(t[junkBusy]).toBe("cold")
    expect(t[idle]).toBeNull()
    expect(t[noSlug]).toBeNull()
    expect(t[listed]).toBe("warm")

    // A newly tiered collection is due at once; assigning again changes nothing.
    const row = await rowOf(sellers[0]!)
    expect(row.next_stats_at.getTime()).toBe(T0)
    await sql`update indexer.nft_collections set next_stats_at = ${new Date(T0 + HOUR)}`
    await assignTiers(sql, new Date(T0 + 10 * MIN))
    expect((await rowOf(sellers[0]!)).next_stats_at.getTime()).toBe(T0 + HOUR)
  })

  it("a collection that gets hotter is due within the new interval; one that goes idle loses its schedule", async () => {
    await addCollection(A, { stats_tier: "cold", next_stats_at: new Date(T0 + 12 * HOUR) })
    await addCollection(B, { stats_tier: "warm", next_stats_at: new Date(T0 + HOUR) })
    await addMint(A, 60)
    await assignTiers(sql, new Date(T0))
    const a = await rowOf(A)
    expect(a.stats_tier).toBe("hot")
    expect(a.next_stats_at.getTime()).toBe(T0 + 20 * MIN)
    const b = await rowOf(B)
    expect(b.stats_tier).toBeNull()
    expect(b.next_stats_at).toBeNull()
  })

  it("the hot and warm tiers are cut at 30 and 70, the rest of the tracked set is cold", () => {
    const rows: TierCandidate[] = Array.from({ length: 120 }, (_, i) => ({
      contract: addr(i + 1),
      junk: false,
      minting: false,
      sales7d: 1000 - i,
    }))
    const plan = planTiers(rows)
    const count = (tier: string) => [...plan.values()].filter((t) => t === tier).length
    expect([count("hot"), count("warm"), count("cold")]).toEqual([30, 70, 20])
    expect(plan.get(addr(30))).toBe("hot")
    expect(plan.get(addr(31))).toBe("warm")
    expect(plan.get(addr(100))).toBe("warm")
    expect(plan.get(addr(101))).toBe("cold")
  })
})

describe("stats job", () => {
  it("polls a due collection, stores the row and writes nft.stats", async () => {
    const s = setup({ [statsPath(A)]: osStats({ floor: 0.5, owners: 7, volume: 1.5, sales: 3 }) })
    await addCollection(A, {
      stats_tier: "cold",
      next_stats_at: new Date(T0),
      total_supply: 2222,
      max_supply: "3333",
    })
    expect(await s.stats.job.due(sql, new Date(T0))).toEqual([A])
    await s.stats.job.run(A)

    expect(callsTo(s.fetch, statsPath(A))).toBe(1)
    expect(s.fetch.calls[0]?.headers["x-api-key"]).toBe(KEY)
    const rows = await statRows(A)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      floor_wei: String(ETH / 2n),
      owners: 7,
      volume_24h_wei: String((ETH * 3n) / 2n),
      sales_24h: 3,
      total_supply: 2222,
    })
    expect(rows[0]?.at.getTime()).toBe(T0)
    expect(await statsEvents()).toEqual([
      {
        v: 1,
        chainId: 57073,
        type: "nft.stats",
        contract: A,
        source: "opensea",
        txHash: `os:stats:${A}:1`,
        logIndex: 0,
        blockNumber: String(HEAD),
        blockTimestamp: T0 / 1000,
        floorWei: String(ETH / 2n),
        floor24hAgoWei: null,
        owners: 7,
        volume24hWei: String((ETH * 3n) / 2n),
        sales24h: 3,
        totalSupply: "2222",
        maxSupply: "3333",
        listedCount: null,
        listedCapped: false,
      },
    ])
    // Cold: the next poll is in 12 hours, and it is not due before.
    const row = await rowOf(A)
    expect(row.next_stats_at.getTime()).toBe(T0 + 12 * HOUR)
    expect(row.stats_n).toBe(1)
    expect(await s.stats.job.due(sql, new Date(T0 + 12 * HOUR - 1))).toEqual([])
    expect(await s.stats.job.due(sql, new Date(T0 + 12 * HOUR))).toEqual([A])
  })

  it("takes the first poll's numbers from the recorded OpenSea stats", async () => {
    const hornet = addr(0x4d)
    const s = setup({ [statsPath(hornet)]: recorded("collections/ink-hornet/stats") })
    await addCollection(hornet, {
      stats_tier: "hot",
      next_stats_at: new Date(T0),
      total_supply: 2222,
    })
    await s.stats.job.run(hornet)
    const [e] = await statsEvents()
    expect(e).toMatchObject({
      floorWei: "1627690000000000",
      owners: 729,
      volume24hWei: "12515469999990000",
      sales24h: 10,
      totalSupply: "2222",
      maxSupply: null,
    })
    expect((await rowOf(hornet)).next_stats_at.getTime()).toBe(T0 + 20 * MIN)
  })

  it("floor24hAgo picks the row at or before now−24h", async () => {
    const s = setup({ [statsPath(A)]: osStats({ floor: 3, owners: 1 }) })
    await addCollection(A, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 })
    const old = (ageMs: number, floor: bigint) => ({
      contract: A,
      at: new Date(T0 - ageMs),
      floor_wei: String(floor),
      owners: 1,
      volume_24h_wei: "0",
      sales_24h: 0,
      total_supply: 10,
    })
    await sql`insert into indexer.nft_stats ${sql([
      old(30 * HOUR, 1n),
      old(25 * HOUR, 2n),
      // Exactly 24 hours ago counts.
      old(24 * HOUR, 4n),
      old(23 * HOUR, 5n),
      old(1 * HOUR, 6n),
    ])}`
    await s.stats.job.run(A)
    expect((await statsEvents())[0]?.floor24hAgoWei).toBe("4")
  })

  it("floor24hAgo is null under 24 hours of history", async () => {
    const s = setup({ [statsPath(A)]: osStats({ floor: 3, owners: 1 }) })
    await addCollection(A, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 })
    await sql`insert into indexer.nft_stats ${sql({
      contract: A,
      at: new Date(T0 - 23 * HOUR),
      floor_wei: "1",
      owners: 1,
      volume_24h_wei: "0",
      sales_24h: 0,
      total_supply: 10,
    })}`
    await s.stats.job.run(A)
    expect((await statsEvents())[0]?.floor24hAgoWei).toBeNull()
  })

  it("unchanged stats write no event", async () => {
    let body = osStats({ floor: 1, owners: 5, volume: 2, sales: 2 })
    const s = setup({ [statsPath(A)]: () => body })
    await addCollection(A, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 })
    await s.stats.job.run(A)
    expect(await statsEvents()).toHaveLength(1)

    // The same numbers again: the row is kept, no event.
    clock += 20 * MIN
    await s.stats.job.run(A)
    expect(await statRows(A)).toHaveLength(2)
    expect(await statsEvents()).toHaveLength(1)
    // Sales and total supply alone do not make an event either.
    clock += 20 * MIN
    body = osStats({ floor: 1, owners: 5, volume: 2, sales: 9 })
    await s.stats.job.run(A)
    expect(await statsEvents()).toHaveLength(1)

    // Each of floor, owners and 24 h volume does.
    for (const [i, change] of [{ floor: 2 }, { owners: 6 }, { volume: 3 }].entries()) {
      clock += 20 * MIN
      body = osStats({ floor: 1, owners: 5, volume: 2, sales: 2, ...change })
      await s.stats.job.run(A)
      clock += 20 * MIN
      body = osStats({ floor: 1, owners: 5, volume: 2, sales: 2 })
      await s.stats.job.run(A)
      expect((await statsEvents()).length).toBe(1 + 2 * (i + 1))
    }
    expect((await statsEvents()).map((e) => e.txHash)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((n) => `os:stats:${A}:${n}`),
    )
    expect(reports).toEqual([])
  })

  it("a collection with no floor writes null, and a missing 24 h interval is zero volume", async () => {
    const s = setup({ [statsPath(A)]: { status: 200, body: { total: { num_owners: 3 } } } })
    await addCollection(A, { stats_tier: "cold", next_stats_at: new Date(T0), total_supply: 10 })
    await s.stats.job.run(A)
    expect((await statsEvents())[0]).toMatchObject({
      floorWei: null,
      owners: 3,
      volume24hWei: "0",
      sales24h: 0,
    })
  })

  it("a collection with unknown supply still gets its stats event", async () => {
    const s = setup({ [statsPath(A)]: osStats({ floor: 1 }) })
    await addCollection(A, { stats_tier: "cold", next_stats_at: new Date(T0) })
    await s.stats.job.run(A)
    expect((await statRows(A))[0]?.total_supply).toBeNull()
    expect(await statsEvents()).toHaveLength(1)
    expect((await statsEvents())[0]).toMatchObject({ totalSupply: null, maxSupply: null })
  })

  it("defers when the budget is empty and leaves the collection due", async () => {
    takeBudget = async () => false
    const s = setup({ [statsPath(A)]: osStats({ floor: 1 }) })
    await addCollection(A, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 })
    expect(await s.stats.job.run(A)).toBe("deferred")
    expect(await statRows(A)).toHaveLength(0)
    expect(await s.stats.job.due(sql, new Date(T0))).toEqual([A])
  })

  it("a collection OpenSea does not know is asked again at its tier's interval; an error in five minutes", async () => {
    const s = setup({
      [statsPath(A)]: { status: 404, body: {} },
      [statsPath(B)]: { status: 500, body: {} },
    })
    for (const c of [A, B])
      await addCollection(c, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 })
    await s.stats.job.run(A)
    await s.stats.job.run(B)
    expect((await rowOf(A)).next_stats_at.getTime()).toBe(T0 + 20 * MIN)
    expect((await rowOf(B)).next_stats_at.getTime()).toBe(T0 + 5 * MIN)
    expect(await statRows(A)).toHaveLength(0)
    expect(await statRows(B)).toHaveLength(0)
  })

  describe("a due listed count with no tier", () => {
    /** Ticks the scheduler every minute for a day; returns the stats requests made. */
    async function day(status: number) {
      const s = setup({ [statsPath(A)]: { status, body: {} }, [listedPath(A)]: listings(3, null) })
      await addCollection(A, { total_supply: 10, listed_due_at: new Date(T0) })
      const scheduler = createScheduler([s.stats.job], { sql, log, report, now })
      for (let m = 0; m <= 24 * 60; m++) {
        clock = T0 + m * MIN
        await scheduler.tick()
      }
      return { calls: callsTo(s.fetch, statsPath(A)), row: await rowOf(A) }
    }

    it("a sold-out collection whose stats fetch 404s is polled a few times, then dropped", async () => {
      const { calls, row } = await day(404)
      expect(calls).toBe(3)
      expect(row.listed_due_at).toBeNull()
      expect(row.listed_failures).toBe(0)
    })

    it("a sold-out collection whose stats fetch keeps failing is polled hourly at most", async () => {
      const { calls, row } = await day(500)
      expect(calls).toBeLessThanOrEqual(25)
      expect(row.listed_due_at).not.toBeNull()
    })

    it("a budget deferral also moves the count back", async () => {
      takeBudget = async () => false
      const s = setup({ [statsPath(A)]: osStats({ floor: 1 }) })
      await addCollection(A, { total_supply: 10, listed_due_at: new Date(T0) })
      expect(await s.stats.job.run(A)).toBe("deferred")
      expect((await rowOf(A)).listed_due_at.getTime()).toBe(T0 + HOUR)
    })
  })

  it("the scheduler assigns tiers, then polls what they make due", async () => {
    const s = setup({ [statsPath(A)]: osStats({ floor: 1, owners: 2 }) })
    await addCollection(A, { total_supply: 10 })
    await addMint(A, 60)
    const scheduler = createScheduler([s.stats.tierJob, s.stats.job], { sql, log, report, now })
    await scheduler.tick()
    expect((await rowOf(A)).stats_tier).toBe("hot")
    expect(callsTo(s.fetch, statsPath(A))).toBe(1)
    expect(await statsEvents()).toHaveLength(1)
    // The tiers are assigned every 10 minutes, no more often.
    await sql`update indexer.nft_collections set stats_tier = 'cold'`
    clock += 9 * MIN
    await scheduler.tick()
    expect((await rowOf(A)).stats_tier).toBe("cold")
    clock += 1 * MIN
    await scheduler.tick()
    expect((await rowOf(A)).stats_tier).toBe("hot")
  })
})

describe("supply", () => {
  it("chimera stats read permanentSupply and maxPermanent", async () => {
    const s = setup({ [statsPath(A)]: osStats({ floor: 1 }) })
    await addCollection(A, {
      launchpad: "chimera",
      stats_tier: "hot",
      next_stats_at: new Date(T0),
      // OpenSea's own total and the column from discovery are not used for a Chimera collection.
      total_supply: 5,
      max_supply: "7",
    })
    chain.chimeraSupplies.set(A, { permanentSupply: 729n, maxPermanent: 999n })
    await s.stats.job.run(A)
    expect(chain.chimeraReads).toEqual([A])
    expect((await statsEvents())[0]).toMatchObject({ totalSupply: "729", maxSupply: "999" })
    expect((await statRows(A))[0]?.total_supply).toBe(729)
  })

  it("a chimera collection whose reads revert falls back to the collection's total supply", async () => {
    const s = setup({ [statsPath(A)]: osStats({ floor: 1 }) })
    await addCollection(A, {
      launchpad: "chimera",
      stats_tier: "hot",
      next_stats_at: new Date(T0),
      total_supply: 5,
    })
    await s.stats.job.run(A)
    expect((await statsEvents())[0]).toMatchObject({ totalSupply: "5", maxSupply: null })
  })

  it("other collections do not read the chain", async () => {
    const s = setup({ [statsPath(A)]: osStats({ floor: 1 }) })
    await addCollection(A, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 5 })
    await s.stats.job.run(A)
    expect(chain.chimeraReads).toEqual([])
  })
})

describe("listed count", () => {
  /** Pages of 100 listings with cursors p2, p3, ... until `pages` pages have been served. */
  const paged =
    (pages: number, lastPage = 100, more = false) =>
    (req: FakeRequest) => {
      const cursor = new URL(req.url).searchParams.get("next")
      const page = cursor === null ? 1 : Number(cursor.slice(1))
      return page < pages
        ? listings(100, `p${page + 1}`)
        : listings(lastPage, more ? `p${page + 1}` : null)
    }

  it("listed count pages up to 3 and caps at 300", async () => {
    const s = setup({
      [statsPath(A)]: osStats({ floor: 1 }),
      [listedPath(A)]: paged(3, 100, true),
    })
    await addCollection(A, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 })
    await s.stats.job.run(A)
    expect(callsTo(s.fetch, listedPath(A))).toBe(3)
    const urls = s.fetch.calls.filter((c) => c.path === listedPath(A)).map((c) => new URL(c.url))
    expect(urls.map((u) => u.searchParams.get("limit"))).toEqual(["100", "100", "100"])
    expect(urls.map((u) => u.searchParams.get("next"))).toEqual([null, "p2", "p3"])
    expect((await statsEvents())[0]).toMatchObject({ listedCount: 300, listedCapped: true })
  })

  it("counts fewer than 300 listings exactly, and exactly 300 without a next page as not capped", async () => {
    const s = setup({
      [statsPath(A)]: osStats({ floor: 1 }),
      [statsPath(B)]: osStats({ floor: 1 }),
      [listedPath(A)]: paged(2, 37),
      [listedPath(B)]: paged(3, 100),
    })
    for (const c of [A, B])
      await addCollection(c, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 })
    await s.stats.job.run(A)
    await s.stats.job.run(B)
    expect(callsTo(s.fetch, listedPath(A))).toBe(2)
    const [a, b] = await statsEvents()
    expect(a).toMatchObject({ contract: A, listedCount: 137, listedCapped: false })
    expect(b).toMatchObject({ contract: B, listedCount: 300, listedCapped: false })
  })

  it("hot collections are counted hourly, warm every 6 hours, cold never", async () => {
    const [hot, warm, cold] = [addr(0xc1), addr(0xc2), addr(0xc3)]
    const routes: Parameters<typeof fakeFetch>[0] = {}
    for (const c of [hot, warm, cold]) {
      // The floor moves at every poll, so each one writes an event.
      let floor = 1
      routes[statsPath(c)] = () => osStats({ floor: floor++ })
      routes[listedPath(c)] = listings(5, null)
      await addCollection(c, {
        stats_tier: c === hot ? "hot" : c === warm ? "warm" : "cold",
        next_stats_at: new Date(T0),
        total_supply: 10,
      })
    }
    const s = setup(routes)
    const counts = () => [hot, warm, cold].map((c) => callsTo(s.fetch, listedPath(c)))
    const events = async (c: string) => (await statsEvents()).filter((e) => e.contract === c)

    // Every 20 minutes for 12 hours; the cold one is also polled, at its tier's own interval.
    for (let i = 0; i <= 36; i++) {
      clock = T0 + i * 20 * MIN
      for (const c of [hot, warm, cold]) {
        const [row] = await sql<{ next: Date }[]>`
          select next_stats_at as next from indexer.nft_collections where contract = ${c}`
        if (row!.next.getTime() <= clock) await s.stats.job.run(c)
      }
      if (i === 0) expect(counts()).toEqual([1, 1, 0])
      if (i === 2) expect(counts()).toEqual([1, 1, 0])
      if (i === 3) expect(counts()).toEqual([2, 1, 0])
    }
    // Over 12 hours (37 looks): hot at 0, 1 h, ... 12 h; warm at 0, 6 h, 12 h.
    expect(counts()).toEqual([13, 3, 0])
    expect((await events(hot)).filter((e) => e.listedCount === 5)).toHaveLength(13)
    expect((await events(warm)).filter((e) => e.listedCount === 5)).toHaveLength(3)
    expect((await events(cold)).every((e) => e.listedCount === null)).toBe(true)
  })

  it("sold_out triggers one listed count", async () => {
    // The milestone stamps the database clock, so the test runs on it too.
    clock = Date.now() + 1000
    const s = setup({
      [statsPath(A)]: osStats({ floor: 1 }),
      [listedPath(A)]: listings(12, null),
    })
    await addCollection(A, { total_supply: 10 })
    const batch: NftBatch = {
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
      milestones: [
        { contract: A as `0x${string}`, maxSupply: 10n, lastMarkBps: 7500, soldOutBlock: 99n },
      ],
      touched: [],
    }
    await sql.begin((tx) => writeRows(tx, batch))
    expect((await rowOf(A)).listed_due_at).not.toBeNull()

    // No tier (nothing minted lately and no sale), yet the count is due.
    expect(await s.stats.job.due(sql, new Date(clock))).toEqual([A])
    await s.stats.job.run(A)
    expect(callsTo(s.fetch, listedPath(A))).toBe(1)
    expect((await statsEvents())[0]).toMatchObject({ listedCount: 12, listedCapped: false })
    expect((await rowOf(A)).listed_due_at).toBeNull()
    expect((await rowOf(A)).next_stats_at).toBeNull()

    // Done: not due again, and a second sell-out write does not ask for another count.
    expect(await s.stats.job.due(sql, new Date(clock + DAY))).toEqual([])
    await sql.begin((tx) => writeRows(tx, batch))
    expect((await rowOf(A)).listed_due_at).toBeNull()
  })

  it("unchanged floor, owners and volume with a changed listed count writes one event", async () => {
    let listed = listings(5, null)
    const s = setup({
      [statsPath(A)]: osStats({ floor: 1, owners: 5, volume: 2 }),
      [listedPath(A)]: () => listed,
    })
    await addCollection(A, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 })
    await s.stats.job.run(A)
    expect(await statsEvents()).toHaveLength(1)
    expect((await statRows(A))[0]).toMatchObject({ listed_count: 5, listed_capped: false })

    // An hour on: counted again, same count, nothing else changed. No event.
    clock += HOUR
    await s.stats.job.run(A)
    expect(callsTo(s.fetch, listedPath(A))).toBe(2)
    expect(await statsEvents()).toHaveLength(1)

    // A poll that does not count does not compare listed counts, and keeps null in its row.
    clock += 20 * MIN
    await s.stats.job.run(A)
    expect(await statsEvents()).toHaveLength(1)
    expect((await statRows(A))[2]?.listed_count).toBeNull()

    // The count changes: one event with it.
    clock += 40 * MIN
    listed = listings(8, null)
    await s.stats.job.run(A)
    const events = await statsEvents()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ listedCount: 8, listedCapped: false })

    // Past the cap: 300, capped.
    clock += HOUR
    const capped = setup({
      [statsPath(A)]: osStats({ floor: 1, owners: 5, volume: 2 }),
      [listedPath(A)]: () => listings(100, "more"),
    })
    await capped.stats.job.run(A)
    expect((await statsEvents())[2]).toMatchObject({ listedCount: 300, listedCapped: true })
  })

  it("a failed listing page leaves the stats written and the count for later", async () => {
    const s = setup({
      [statsPath(A)]: osStats({ floor: 1 }),
      [listedPath(A)]: { status: 500, body: {} },
    })
    await addCollection(A, { stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 })
    await s.stats.job.run(A)
    expect((await statsEvents())[0]).toMatchObject({ listedCount: null, listedCapped: false })
    expect((await rowOf(A)).listed_counted_at).toBeNull()
  })
})

describe("requestStats", () => {
  it("requestStats twice within 30 minutes makes one call", async () => {
    const s = setup({ [statsPath(A)]: osStats({ floor: 2, owners: 4 }) })
    await addCollection(A, {
      stats_tier: "warm",
      next_stats_at: new Date(T0 + HOUR),
      total_supply: 10,
    })

    expect(await s.stats.requestStats(A, 1000)).toBe(true)
    expect(callsTo(s.fetch, statsPath(A))).toBe(1)
    // An on-demand refresh does not count listings.
    expect(callsTo(s.fetch, listedPath(A))).toBe(0)
    expect((await statRows(A))[0]).toMatchObject({ floor_wei: String(2n * ETH), owners: 4 })
    expect(await statsEvents()).toHaveLength(1)
    // The fresh poll moves the schedule.
    expect((await rowOf(A)).next_stats_at.getTime()).toBe(T0 + 2 * HOUR)

    clock += 29 * MIN
    expect(await s.stats.requestStats(A, 1000)).toBe(false)
    expect(callsTo(s.fetch, statsPath(A))).toBe(1)

    clock += 1 * MIN
    expect(await s.stats.requestStats(A, 1000)).toBe(true)
    expect(callsTo(s.fetch, statsPath(A))).toBe(2)
  })

  it("requestStats resolves false after waitMs when the budget blocks", async () => {
    let release = () => {}
    takeBudget = () => new Promise<boolean>((r) => (release = () => r(false)))
    const s = setup({ [statsPath(A)]: osStats({ floor: 2 }) })
    await addCollection(A, { total_supply: 10 })
    const started = Date.now()
    expect(await s.stats.requestStats(A, 80)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
    release()
    expect(await statRows(A)).toHaveLength(0)
    expect(s.fetch.calls).toHaveLength(0)
  })

  it("is false for a collection with no slug, without using up the throttle", async () => {
    const s = setup({})
    await addCollection(A, { slug: null })
    expect(await s.stats.requestStats(A, 100)).toBe(false)
    expect(await s.stats.requestStats(addr(0xdead), 100)).toBe(false)
    expect((await rowOf(A)).stats_requested_at).toBeNull()
    expect(s.fetch.calls).toHaveLength(0)
  })

  it("is false when OpenSea fails", async () => {
    const s = setup({ [statsPath(A)]: { status: 500, body: {} } })
    await addCollection(A, { total_supply: 10 })
    expect(await s.stats.requestStats(A, 1000)).toBe(false)
    expect(await statRows(A)).toHaveLength(0)
  })
})

describe("latestFloor", () => {
  it("is the newest row's floor and time, null without rows", async () => {
    const s = setup({})
    expect(await s.stats.latestFloor(A)).toBeNull()
    const row = (ageMs: number, floor: string | null) => ({
      contract: A,
      at: new Date(T0 - ageMs),
      floor_wei: floor,
      owners: 1,
      volume_24h_wei: "0",
      sales_24h: 0,
      total_supply: null,
    })
    await sql`insert into indexer.nft_stats ${sql([row(3 * HOUR, "5"), row(1 * HOUR, "7")])}`
    expect(await s.stats.latestFloor(A)).toEqual({ floorWei: 7n, at: new Date(T0 - HOUR) })
    await sql`insert into indexer.nft_stats ${sql(row(0, null))}`
    expect(await s.stats.latestFloor(A)).toEqual({ floorWei: null, at: new Date(T0) })
  })

  it("latestFloors reads many contracts at once", async () => {
    await sql`insert into indexer.nft_stats ${sql([
      {
        contract: A,
        at: new Date(T0 - HOUR),
        floor_wei: "5",
        owners: 1,
        volume_24h_wei: "0",
        sales_24h: 0,
        total_supply: null,
      },
      {
        contract: A,
        at: new Date(T0),
        floor_wei: "6",
        owners: 1,
        volume_24h_wei: "0",
        sales_24h: 0,
        total_supply: null,
      },
      {
        contract: B,
        at: new Date(T0),
        floor_wei: null,
        owners: 1,
        volume_24h_wei: "0",
        sales_24h: 0,
        total_supply: null,
      },
    ])}`
    const floors = await latestFloors(sql, [A, B, addr(0xee)])
    expect(floors.get(A)).toBe(6n)
    expect(floors.get(B)).toBeNull()
    expect(floors.has(addr(0xee))).toBe(false)
  })
})
