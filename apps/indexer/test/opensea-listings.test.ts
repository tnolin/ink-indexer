import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { NftListingEvent } from "@ink-indexer/events"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import type { NftBatch } from "../src/sources/nft/index"
import { writeRows } from "../src/sources/nft/write"
import type { Budget } from "../src/sources/opensea/budget"
import { createListings } from "../src/sources/opensea/listings"
import { createRanks } from "../src/sources/opensea/ranks"
import { createOpenSeaRest } from "../src/sources/opensea/rest"
import { createStats } from "../src/sources/opensea/stats"
import type { StreamEvent } from "../src/sources/opensea/stream"
import { createStore, type Store } from "../src/store"
import { type FakeRequest, type FakeResponse, fakeFetch, recorded } from "./opensea/fake-fetch"
import { loadOpenSeaFixture } from "./opensea/fixtures"

const KEY = "test-key-0123456789abcdef"
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.parse("2026-10-19T00:00:00Z")
/** The chain cursor, which off-chain events are stamped with. */
const HEAD = 10_000_000

const PRTSCN = "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448"
const WIRED = "0x7c701c0148e0e965065aa05e008ac9341e6efc6c"
const BURST = "0x165dcae7953657e23035c96503b2a5b51ddfa4cd"
const MAKER = "0xb961301342058846b8353c27d376c23fdddb0bb4"
/** The collection's floor and the highest price that still gets a rank fetch (floor times 11/10). */
const FLOOR = 10n ** 17n
const NEAR = (FLOOR * 11n) / 10n
const FAR = NEAR + 1n
const MAX_RANK = 3333
const CALCULATED = new Date(T0 - 3 * DAY)

let sql: Sql
let store: Store
let clock: number
let reports: unknown[]
let warnings: string[]
let takeBudget: () => Promise<boolean>

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  clock = T0
  reports = []
  warnings = []
  takeBudget = async () => true
  await store.writeBatch([], [], {
    cursor: { block: BigInt(HEAD), hash: `0x${"11".repeat(32)}` },
    head: BigInt(HEAD),
  })
  await addCollection(PRTSCN, "prtscn-ink", {
    rarity_calculated_at: CALCULATED,
    max_rank: MAX_RANK,
  })
  await addCollection(WIRED, "wiredonink")
  await addFloor(PRTSCN, FLOOR, T0 - 10 * MIN)
})
afterEach(() => sql.end())

const now = () => clock
const log: Logger = (level, msg) => {
  if (level !== "debug") warnings.push(`${level}: ${msg}`)
}
const report = (e: unknown) => void reports.push(e)
const budget: Budget = { take: () => takeBudget(), block: async () => {} }

async function addCollection(contract: string, slug: string, extra: Record<string, unknown> = {}) {
  await sql`insert into indexer.nft_collections ${sql({
    contract,
    standard: "erc721",
    slug,
    next_discovery_at: null,
    verdict_dirty: false,
    ...extra,
  })}`
}
async function addFloor(contract: string, floor: bigint | null, at: number) {
  await sql`insert into indexer.nft_stats ${sql({
    contract,
    at: new Date(at),
    floor_wei: floor === null ? null : floor.toString(),
  })}`
}

/** OpenSea's stats body: prices are floats in ETH. */
const osStats = (floor: number | null): FakeResponse => ({
  status: 200,
  body: {
    total: { floor_price: floor, num_owners: 10 },
    intervals: [{ interval: "one_day", volume: 0, sales: 0 }],
  },
})
const statsPath = "/collections/prtscn-ink/stats"
const nftPath = (token: string, contract = PRTSCN) =>
  `/chain/ink/contract/${contract}/nfts/${token}`
/** Recorded: PRTSCN #489 has rank 2960, and token #1 of the burst collection has none. */
const ranked = (): FakeResponse => recorded(`nfts/${PRTSCN}/489`)
const unranked = (): FakeResponse => recorded(`nfts/${BURST}/1`)
const RANKED = "489"

function setup(
  routes: Parameters<typeof fakeFetch>[0] = {},
  withStore: Pick<Store, "writeOffchain"> = store,
) {
  const fetch = fakeFetch({ [statsPath]: osStats(0.1), ...routes })
  const rest = createOpenSeaRest({ key: KEY, budget, fetch, log, report, now })
  const stats = createStats({ sql, store, rest, log, now })
  const ranks = createRanks({ sql, rest, log, now })
  const listings = createListings({ sql, store: withStore, stats, ranks, log, report, now })
  return { fetch, rest, stats, ranks, listings, handle: listings.handleStreamEvent }
}
const callsTo = (fetch: { calls: FakeRequest[] }, path: string) =>
  fetch.calls.filter((c) => c.path === path).length

// A recorded payload is read and edited by field name.
// biome-ignore lint/suspicious/noExplicitAny: OpenSea payloads are untyped JSON
type Json = any
type Ev = StreamEvent & { payload: Json }

// Recorded frames, as the stream hands them over.
type Frame = [string | null, string | null, string, string, { payload: Json }]
const FRAMES = (
  loadOpenSeaFixture("stream/collections") as { frames: { frame: Frame }[] }
).frames.map((f) => f.frame)
const RECORDED_LISTED = FRAMES.find(
  (f) => f[3] === "item_listed" && f[2] === "collection:prtscn-ink",
)!
const RECORDED_CANCELLED = FRAMES.find((f) => f[3] === "item_cancelled")!
const RECORDED_METADATA = FRAMES.filter(
  (f) => f[3] === "item_metadata_updated" && f[2] === "collection:wiredonink",
)

let hashes = 0
const hash = () => `0x${(++hashes).toString(16).padStart(64, "0")}`

type ListedOpts = {
  token?: string
  price?: bigint
  hash?: string
  /** Seconds between the listing and its expiry. */
  life?: number
  priv?: boolean
  paying?: { symbol: string; address: string }
  quantity?: number
  name?: string | null
  image?: string | null
}
/** A recorded PRTSCN `item_listed` with the fields a test changes. */
function listed(o: ListedOpts = {}): Ev {
  const payload = structuredClone(RECORDED_LISTED[4].payload)
  const token = o.token ?? "1506"
  payload.base_price = String(o.price ?? NEAR)
  payload.order_hash = o.hash ?? hash()
  payload.listing_date = new Date(clock).toISOString()
  payload.expiration_date = new Date(clock + (o.life ?? 30 * 86400) * SEC).toISOString()
  payload.is_private = o.priv ?? false
  payload.maker = { address: MAKER }
  if (o.paying) payload.payment_token = { ...payload.payment_token, ...o.paying }
  if (o.quantity !== undefined) payload.quantity = o.quantity
  payload.item.nft_id = `ink/${PRTSCN}/${token}`
  if (o.name !== undefined) payload.item.metadata.name = o.name
  if (o.image !== undefined) payload.item.metadata.image_url = o.image
  return {
    type: "item_listed",
    slug: "prtscn-ink",
    contract: PRTSCN,
    tokenId: token,
    payload,
    receivedAt: clock,
  }
}
/** An event that ends an item's listing. No `item_sold` was recorded: it has the shape of the recorded cancel. */
function ends(type: "item_cancelled" | "item_sold" | "item_transferred", token = "1506"): Ev {
  const payload = structuredClone(RECORDED_CANCELLED[4].payload)
  payload.item.nft_id = `ink/${PRTSCN}/${token}`
  return { type, slug: "prtscn-ink", contract: PRTSCN, tokenId: token, payload, receivedAt: clock }
}
/** The i-th recorded `item_metadata_updated` of WIRED, received at `at`. */
function metadata(i: number, at: number): Ev {
  const frame = RECORDED_METADATA[i % RECORDED_METADATA.length]!
  const nft = /^ink\/(0x[0-9a-f]{40})\/(\d+)$/.exec(frame[4].payload.item.nft_id)!
  return {
    type: "item_metadata_updated",
    slug: "wiredonink",
    contract: nft[1] as `0x${string}`,
    tokenId: nft[2]!,
    payload: frame[4].payload,
    receivedAt: at,
  }
}

const listingEvents = async () =>
  (
    await sql<{ tx_hash: string; sub: string; payload: NftListingEvent }[]>`
      select tx_hash, sub, payload from indexer.events where type = 'nft.listing' order by id`
  ).map((r) => ({ ...r.payload, sub: r.sub }))
const stateOf = async (token: string) =>
  (
    await sql<{ last_price_wei: string; order_hash: string; expires_at: Date }[]>`
      select last_price_wei::text, order_hash, expires_at from indexer.nft_listing_state
      where contract = ${PRTSCN} and token_id = ${token}`
  )[0]
const rankRows = async () =>
  await sql<
    {
      token_id: string
      rank: number
      max_rank: number
      calculated_at: Date | null
      fetched_at: Date
    }[]
  >`select token_id::text as token_id, rank, max_rank, calculated_at, fetched_at
    from indexer.nft_ranks order by token_id`
// biome-ignore lint/suspicious/noExplicitAny: rows are read by column name
const collectionOf = async (contract: string): Promise<Record<string, any>> =>
  (await sql`select * from indexer.nft_collections where contract = ${contract}`)[0]!

describe("the filter", () => {
  it("15-minute expiry is dropped", async () => {
    const s = setup()
    await s.handle(listed({ life: 15 * 60 }))
    await s.handle(listed({ life: 3599, token: "2" }))
    expect(await listingEvents()).toEqual([])
    expect(await stateOf("1506")).toBeUndefined()
    // One hour is long enough.
    await s.handle(listed({ life: 3600, token: "3" }))
    expect(await listingEvents()).toHaveLength(1)
  })

  it("private and non-ETH listings are dropped", async () => {
    const s = setup()
    await s.handle(listed({ priv: true }))
    await s.handle(
      listed({
        token: "2",
        paying: { symbol: "USDC", address: "0x0000000000000000000000000000000000000001" },
      }),
    )
    // A token that calls itself ETH is not ETH.
    await s.handle(
      listed({
        token: "3",
        paying: { symbol: "ETH", address: "0x0000000000000000000000000000000000000002" },
      }),
    )
    expect(await listingEvents()).toEqual([])

    // WETH is accepted, and says so.
    await s.handle(
      listed({
        token: "4",
        paying: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
      }),
    )
    await s.handle(listed({ token: "5" }))
    expect((await listingEvents()).map((e) => [e.tokenId, e.currency])).toEqual([
      ["4", "WETH"],
      ["5", "ETH"],
    ])
  })

  it("drops what it cannot read, without throwing", async () => {
    const s = setup()
    const bad = listed()
    delete bad.payload.base_price
    await s.handle(bad)
    await s.handle({ ...listed(), payload: null })
    await s.handle({ ...listed(), payload: { ...(listed().payload as object), base_price: "1.5" } })
    await s.handle({ ...listed({ quantity: 0 }) })
    await s.handle({ ...listed({ hash: "0xnothex" }) })
    expect(await listingEvents()).toEqual([])
    expect(reports).toEqual([])
  })

  it("prices an ERC-1155 listing per unit", async () => {
    const s = setup()
    await s.handle(listed({ quantity: 5, price: 5n * NEAR + 4n }))
    expect((await listingEvents())[0]).toMatchObject({ priceWei: NEAR.toString() })
    expect((await stateOf("1506"))?.last_price_wei).toBe(NEAR.toString())
  })

  it("same item relisted cheaper writes again, same or higher price does not", async () => {
    const s = setup()
    await s.handle(listed({ price: 900n }))
    await s.handle(listed({ price: 900n }))
    await s.handle(listed({ price: 901n }))
    expect((await listingEvents()).map((e) => e.priceWei)).toEqual(["900"])

    await s.handle(listed({ price: 899n }))
    await s.handle(listed({ price: 899n }))
    const written = await listingEvents()
    expect(written.map((e) => e.priceWei)).toEqual(["900", "899"])
    expect(await stateOf("1506")).toMatchObject({
      last_price_wei: "899",
      order_hash: written[1]!.orderHash,
    })

    // Another item of the collection has its own state.
    await s.handle(listed({ price: 900n, token: "7" }))
    expect(await listingEvents()).toHaveLength(3)
  })

  it("the state expires with the listing", async () => {
    const s = setup()
    await s.handle(listed({ price: 900n, life: 2 * 3600 }))
    clock += 2 * HOUR - SEC
    await s.handle(listed({ price: 950n }))
    expect(await listingEvents()).toHaveLength(1)
    clock += SEC
    await s.handle(listed({ price: 950n }))
    expect((await listingEvents()).map((e) => e.priceWei)).toEqual(["900", "950"])
    expect((await stateOf("1506"))?.last_price_wei).toBe("950")
  })

  it.each(["item_cancelled", "item_sold", "item_transferred"] as const)(
    "%s resets: next listing at any price writes",
    async (type) => {
      const s = setup()
      await s.handle(listed({ price: 900n }))
      await s.handle(listed({ price: 900n }))
      expect(await listingEvents()).toHaveLength(1)

      // Another item's end changes nothing.
      await s.handle(ends(type, "99"))
      expect(await stateOf("1506")).toBeDefined()
      await s.handle(ends(type))
      expect(await stateOf("1506")).toBeUndefined()

      await s.handle(listed({ price: 5_000n }))
      expect((await listingEvents()).map((e) => e.priceWei)).toEqual(["900", "5000"])
    },
  )

  it("chain sale resets the state", async () => {
    const s = setup()
    await s.handle(listed({ price: 900n }))
    const batch: NftBatch = {
      events: [],
      blocks: [],
      mints: [],
      burns: [],
      seadropMints: [],
      seadropConfig: [],
      sales: [
        {
          txHash: `0x${"aa".repeat(32)}`,
          logIndex: 0,
          contract: PRTSCN,
          tokenId: 1506n,
          qty: 1n,
          priceWei: 900n,
          currency: "ETH",
          buyer: "0x00000000000000000000000000000000000000b1",
          seller: MAKER,
          orderHash: `0x${"bb".repeat(32)}`,
          block: 5n,
        },
      ],
      launches: [],
      collections: [],
      stages: [],
      milestones: [],
      touched: [],
    }
    await sql.begin((tx) => writeRows(tx, batch))
    expect(await stateOf("1506")).toBeUndefined()
    await s.handle(listed({ price: 901n }))
    expect(await listingEvents()).toHaveLength(2)
  })

  it("a cancel that arrives while the listing waits is handled after it", async () => {
    let release!: () => void
    takeBudget = () => new Promise<boolean>((r) => (release = () => r(true)))
    const s = setup({ [nftPath(RANKED)]: ranked() })
    const first = s.handle(listed({ token: RANKED, price: NEAR }))
    const cancel = s.handle(ends("item_cancelled", RANKED))
    await new Promise((r) => setTimeout(r, 50))
    expect(await listingEvents()).toEqual([])
    release()
    await Promise.all([first, cancel])
    expect(await listingEvents()).toHaveLength(1)
    expect(await stateOf(RANKED)).toBeUndefined()
  })

  it("a duplicate order_hash writes once", async () => {
    const same = hash()
    const a = setup()
    const b = setup()
    // Two handlers (two processes) see the frame at once: both pass the state check.
    await Promise.all([a.handle(listed({ hash: same })), b.handle(listed({ hash: same }))])
    expect(await listingEvents()).toHaveLength(1)
    expect((await sql`select 1 from indexer.nft_listing_state`).length).toBe(1)

    // The frame comes again after the state was cleared: the unique key still holds.
    await sql`delete from indexer.nft_listing_state`
    await a.handle(listed({ hash: same }))
    expect(await listingEvents()).toHaveLength(1)
  })
})

describe("a listing that loses a race", () => {
  it("is rolled back when a lower price was written meanwhile", async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const slow = {
      writeOffchain: (...a: Parameters<Store["writeOffchain"]>) =>
        gate.then(() => store.writeOffchain(...a)),
    }
    const late = setup({}, slow)
    const early = setup()
    // The higher price passed the state check while the item had none, then waits to write.
    const higher = late.handle(listed({ price: 950n }))
    await new Promise((r) => setTimeout(r, 50))
    await early.handle(listed({ price: 900n }))
    open()
    await higher
    expect((await listingEvents()).map((e) => e.priceWei)).toEqual(["900"])
    expect((await stateOf("1506"))?.last_price_wei).toBe("900")
  })
})

describe("the floor", () => {
  it("a fresh floor is used as it is", async () => {
    const s = setup()
    await s.handle(listed({ price: FAR }))
    expect(callsTo(s.fetch, statsPath)).toBe(0)
    expect((await listingEvents())[0]).toMatchObject({
      floorWei: FLOOR.toString(),
      floorAt: Math.floor((T0 - 10 * MIN) / SEC),
    })
  })

  it("stale floor triggers one stats refresh and waits", async () => {
    await sql`delete from indexer.nft_stats`
    await addFloor(PRTSCN, FLOOR, T0 - 3 * HOUR)
    let release!: () => void
    takeBudget = () => new Promise<boolean>((r) => (release = () => r(true)))
    const s = setup({ [statsPath]: osStats(0.2) })
    // Two listings of the collection at once share the one refresh.
    const both = Promise.all([
      s.handle(listed({ token: "1", price: 3n * FLOOR })),
      s.handle(listed({ token: "2", price: 3n * FLOOR })),
    ])
    await new Promise((r) => setTimeout(r, 50))
    expect(await listingEvents()).toEqual([])
    release()
    await both
    expect(callsTo(s.fetch, statsPath)).toBe(1)
    const written = await listingEvents()
    expect(written).toHaveLength(2)
    for (const e of written)
      expect(e).toMatchObject({
        floorWei: (2n * FLOOR).toString(),
        floorAt: Math.floor(T0 / SEC),
      })
  })

  it("a floor exactly 10 minutes old is not refreshed; a collection with no stats row is", async () => {
    await sql`delete from indexer.nft_stats`
    await addFloor(PRTSCN, FLOOR, T0 - 10 * MIN)
    const s = setup({ [statsPath]: osStats(0.2) })
    await s.handle(listed({ token: "1", price: 3n * FLOOR }))
    expect(callsTo(s.fetch, statsPath)).toBe(0)

    await sql`delete from indexer.nft_stats`
    await s.handle(listed({ token: "2", price: 3n * FLOOR }))
    expect(callsTo(s.fetch, statsPath)).toBe(1)
    expect((await listingEvents())[1]).toMatchObject({ floorWei: (2n * FLOOR).toString() })
  })

  it("a refresh that cannot run leaves the old floor in the event", async () => {
    await sql`delete from indexer.nft_stats`
    await addFloor(PRTSCN, FLOOR, T0 - 3 * HOUR)
    takeBudget = async () => false
    const s = setup()
    await s.handle(listed({ price: FAR }))
    expect((await listingEvents())[0]).toMatchObject({
      floorWei: FLOOR.toString(),
      floorAt: Math.floor((T0 - 3 * HOUR) / SEC),
    })
  })

  it("a floor 11 minutes old is read once and the event carries the fresh floor and its time", async () => {
    await sql`delete from indexer.nft_stats`
    await addFloor(PRTSCN, FLOOR, T0 - 11 * MIN)
    const s = setup({ [statsPath]: osStats(0.2) })
    await s.handle(listed({ token: "1", price: 3n * FLOOR }))
    expect(callsTo(s.fetch, statsPath)).toBe(1)
    expect((await listingEvents())[0]).toMatchObject({
      floorWei: (2n * FLOOR).toString(),
      floorAt: Math.floor(T0 / SEC),
    })
    // The read is stored like a scheduled one.
    expect((await sql`select 1 from indexer.nft_stats where at = ${new Date(T0)}`).length).toBe(1)

    // A second listing 2 minutes later finds the stored floor fresh and reads nothing.
    clock += 2 * MIN
    await s.handle(listed({ token: "2", price: 3n * FLOOR }))
    expect(callsTo(s.fetch, statsPath)).toBe(1)
    expect((await listingEvents())[1]).toMatchObject({
      floorWei: (2n * FLOOR).toString(),
      floorAt: Math.floor(T0 / SEC),
    })
  })

  it("a floor 5 minutes old is used without a read", async () => {
    await sql`delete from indexer.nft_stats`
    await addFloor(PRTSCN, FLOOR, T0 - 5 * MIN)
    const s = setup({ [statsPath]: osStats(0.2) })
    await s.handle(listed({ token: "1", price: 3n * FLOOR }))
    expect(callsTo(s.fetch, statsPath)).toBe(0)
    expect((await listingEvents())[0]).toMatchObject({
      floorWei: FLOOR.toString(),
      floorAt: Math.floor((T0 - 5 * MIN) / SEC),
    })
  })

  it("a failed read writes the event with the old floor and its old time, and the next listing within 10 minutes does not read again", async () => {
    await sql`delete from indexer.nft_stats`
    await addFloor(PRTSCN, FLOOR, T0 - 11 * MIN)
    const s = setup({ [statsPath]: { status: 500, body: {} } })
    await s.handle(listed({ token: "1", price: 3n * FLOOR }))
    const calls = callsTo(s.fetch, statsPath)
    expect(calls).toBeGreaterThan(0)
    expect((await listingEvents())[0]).toMatchObject({
      floorWei: FLOOR.toString(),
      floorAt: Math.floor((T0 - 11 * MIN) / SEC),
    })
    clock += 9 * MIN
    await s.handle(listed({ token: "2", price: 3n * FLOOR }))
    expect(callsTo(s.fetch, statsPath)).toBe(calls)
    expect((await listingEvents())[1]).toMatchObject({
      floorAt: Math.floor((T0 - 11 * MIN) / SEC),
    })
    // Ten minutes after the first attempt, the floor is read again.
    clock += 1 * MIN
    await s.handle(listed({ token: "3", price: 3n * FLOOR }))
    expect(callsTo(s.fetch, statsPath)).toBeGreaterThan(calls)
  })

  it("the read takes a token from the shared budget", async () => {
    await sql`delete from indexer.nft_stats`
    await addFloor(PRTSCN, FLOOR, T0 - 11 * MIN)
    let taken = 0
    takeBudget = async () => {
      taken++
      return true
    }
    const s = setup({ [statsPath]: osStats(0.2) })
    await s.handle(listed({ token: "1", price: 3n * FLOOR }))
    expect(taken).toBe(1)
    // A fresh floor takes none.
    await s.handle(listed({ token: "2", price: 3n * FLOOR }))
    expect(taken).toBe(1)
  })

  it("no floor: null floor fields and no rank fetch", async () => {
    await sql`delete from indexer.nft_stats`
    const s = setup({ [statsPath]: osStats(null), [nftPath(RANKED)]: ranked() })
    await s.handle(listed({ token: RANKED, price: 1n }))
    expect(callsTo(s.fetch, statsPath)).toBe(1)
    expect(callsTo(s.fetch, nftPath(RANKED))).toBe(0)
    expect((await listingEvents())[0]).toMatchObject({ floorWei: null, rank: null, maxRank: null })
    expect((await listingEvents())[0]!.floorAt).toBe(Math.floor(T0 / SEC))
  })
})

describe("ranks", () => {
  it("rank fetched only within floor × 1.1, cached, refetched after calculated_at changes", async () => {
    const s = setup({ [nftPath(RANKED)]: ranked() })
    // Above the near-floor price: no request, no rank.
    await s.handle(listed({ token: RANKED, price: FAR + 100n }))
    expect(callsTo(s.fetch, nftPath(RANKED))).toBe(0)
    expect((await listingEvents())[0]).toMatchObject({ rank: null, maxRank: null })

    // At floor × 1.1 exactly: fetched and cached with the collection's calculated_at.
    await s.handle(listed({ token: RANKED, price: NEAR }))
    expect(callsTo(s.fetch, nftPath(RANKED))).toBe(1)
    expect((await listingEvents())[1]).toMatchObject({ rank: 2960, maxRank: MAX_RANK })
    expect(await rankRows()).toEqual([
      {
        token_id: RANKED,
        rank: 2960,
        max_rank: MAX_RANK,
        calculated_at: CALCULATED,
        fetched_at: new Date(T0),
      },
    ])

    // Relisted cheaper: the cache serves it.
    await s.handle(listed({ token: RANKED, price: NEAR - 1n }))
    expect(callsTo(s.fetch, nftPath(RANKED))).toBe(1)
    expect((await listingEvents())[2]).toMatchObject({ rank: 2960, maxRank: MAX_RANK })

    // The collection's rarity moves (a reveal): the cached row is stale.
    await sql`update indexer.nft_collections set rarity_calculated_at = ${new Date(T0 - DAY)}, max_rank = 3000 where contract = ${PRTSCN}`
    await s.handle(listed({ token: RANKED, price: NEAR - 2n }))
    expect(callsTo(s.fetch, nftPath(RANKED))).toBe(2)
    expect((await listingEvents())[3]).toMatchObject({ rank: 2960, maxRank: 3000 })
    expect(await rankRows()).toMatchObject([{ max_rank: 3000, calculated_at: new Date(T0 - DAY) }])

    // 7 days on, the rank is fetched again even though the rarity did not move.
    await sql`update indexer.nft_ranks set fetched_at = ${new Date(T0 - 7 * DAY + SEC)}`
    await s.handle(listed({ token: RANKED, price: NEAR - 3n }))
    expect(callsTo(s.fetch, nftPath(RANKED))).toBe(2)
    await sql`update indexer.nft_ranks set fetched_at = ${new Date(T0 - 7 * DAY)}`
    await s.handle(listed({ token: RANKED, price: NEAR - 4n }))
    expect(callsTo(s.fetch, nftPath(RANKED))).toBe(3)
  })

  it("a cached rank is attached to a listing above the near-floor price", async () => {
    const s = setup()
    await sql`insert into indexer.nft_ranks values (${PRTSCN}, '7', 12, ${MAX_RANK}, ${CALCULATED}, ${new Date(T0 - DAY)})`
    await s.handle(listed({ token: "7", price: 3n * FLOOR }))
    expect(s.fetch.calls).toEqual([])
    expect((await listingEvents())[0]).toMatchObject({ rank: 12, maxRank: MAX_RANK })
  })

  it("a cached rank is attached when the floor is unknown", async () => {
    await sql`delete from indexer.nft_stats`
    const s = setup({ [statsPath]: osStats(null) })
    await sql`insert into indexer.nft_ranks values (${PRTSCN}, '7', 12, ${MAX_RANK}, ${CALCULATED}, ${new Date(T0 - DAY)})`
    await s.handle(listed({ token: "7", price: 1n }))
    expect((await listingEvents())[0]).toMatchObject({ rank: 12, maxRank: MAX_RANK })
  })

  it("the floor refresh waits first, then the rank fetch, and neither is in the write transaction", async () => {
    await sql`delete from indexer.nft_stats`
    await addFloor(PRTSCN, FLOOR, T0 - 3 * HOUR)
    const s = setup({ [statsPath]: osStats(0.1), [nftPath(RANKED)]: ranked() })
    await s.handle(listed({ token: RANKED, price: NEAR }))
    expect(s.fetch.calls.map((c) => c.path)).toEqual([statsPath, nftPath(RANKED)])
    expect((await listingEvents())[0]).toMatchObject({ rank: 2960 })
    expect(s.fetch.calls.every((c) => c.headers["x-api-key"] === KEY)).toBe(true)
  })

  it("null rank stays null and is not cached", async () => {
    const s = setup({ [nftPath("7")]: unranked() })
    await s.handle(listed({ token: "7", price: NEAR }))
    expect(await rankRows()).toEqual([])
    expect((await listingEvents())[0]).toMatchObject({ rank: null, maxRank: null })
    // Asked again for the next listing: nothing was remembered.
    await s.handle(listed({ token: "7", price: NEAR - 1n }))
    expect(callsTo(s.fetch, nftPath("7"))).toBe(2)
    expect((await listingEvents())[1]).toMatchObject({ rank: null, maxRank: null })
  })

  it("no rank without the collection's max_rank, on a failed request or a budget that cannot serve it", async () => {
    const s = setup({ [nftPath(RANKED)]: ranked(), [nftPath("8")]: { status: 500 } })
    await sql`update indexer.nft_collections set max_rank = null where contract = ${PRTSCN}`
    await s.handle(listed({ token: RANKED, price: NEAR }))
    await sql`update indexer.nft_collections set max_rank = ${MAX_RANK} where contract = ${PRTSCN}`

    await s.handle(listed({ token: "8", price: NEAR }))

    takeBudget = async () => false
    const before = s.fetch.calls.length
    await s.handle(listed({ token: RANKED, price: NEAR - 1n }))
    expect(s.fetch.calls.length).toBe(before)

    expect(await rankRows()).toEqual([])
    expect((await listingEvents()).map((e) => [e.rank, e.maxRank])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ])
  })
})

describe("the event", () => {
  it("listing event has floorAt and rank fields", async () => {
    const s = setup({ [nftPath(RANKED)]: ranked() })
    const e = listed({
      token: RANKED,
      price: NEAR,
      name: "PRTSCN #489",
      image: "https://img.example/489.gif",
    })
    await s.handle(e)
    const orderHash = e.payload as { order_hash: string }
    expect(await listingEvents()).toEqual([
      {
        v: 1,
        chainId: 57073,
        contract: PRTSCN,
        source: "opensea",
        txHash: `os:list:${orderHash.order_hash}`,
        logIndex: 0,
        blockNumber: String(HEAD),
        blockTimestamp: Math.floor(T0 / SEC),
        type: "nft.listing",
        tokenId: RANKED,
        priceWei: NEAR.toString(),
        currency: "ETH",
        maker: MAKER,
        expiresAt: Math.floor((T0 + 30 * DAY) / SEC),
        orderHash: orderHash.order_hash,
        itemName: "PRTSCN #489",
        imageUrl: "https://img.example/489.gif",
        floorWei: FLOOR.toString(),
        floorAt: Math.floor((T0 - 10 * MIN) / SEC),
        rank: 2960,
        maxRank: MAX_RANK,
        sub: "",
      },
    ])
  })

  it("updates the item state, the item's name and image and the collection's last listing", async () => {
    const s = setup()
    const e = listed({ price: 900n, name: "First name", image: "https://img.example/a.png" })
    await s.handle(e)
    expect(await stateOf("1506")).toEqual({
      last_price_wei: "900",
      order_hash: (e.payload as { order_hash: string }).order_hash,
      expires_at: new Date(T0 + 30 * DAY),
    })
    const seen = () =>
      sql`select name, image_url, seen_at from indexer.nft_items_seen where contract = ${PRTSCN} and token_id = '1506'`
    expect(await seen()).toEqual([
      { name: "First name", image_url: "https://img.example/a.png", seen_at: new Date(T0) },
    ])
    expect((await collectionOf(PRTSCN)).last_listing_at).toEqual(new Date(T0))

    // The next listing refreshes them, and a listing without them keeps what is known.
    clock += HOUR
    await s.handle(listed({ price: 800n, name: null, image: "https://img.example/b.png" }))
    expect(await seen()).toEqual([
      { name: "First name", image_url: "https://img.example/b.png", seen_at: new Date(T0 + HOUR) },
    ])
    expect((await collectionOf(PRTSCN)).last_listing_at).toEqual(new Date(T0 + HOUR))

    // A dropped listing touches none of it.
    clock += HOUR
    await s.handle(listed({ price: 700n, priv: true }))
    expect((await collectionOf(PRTSCN)).last_listing_at).toEqual(new Date(T0 + HOUR))
  })

  it("every listing frame leaves the item's name and image, but never overwrites", async () => {
    const s = setup()
    const seen = () =>
      sql`select token_id::text as token_id, name, image_url from indexer.nft_items_seen order by token_id`
    // Dropped by the filter (private, 15 minutes), yet the names are kept.
    await s.handle(
      listed({ token: "1", priv: true, name: "Private #1", image: "https://img.example/1.png" }),
    )
    await s.handle(listed({ token: "2", life: 900, name: "Short #2", image: null }))
    expect(await listingEvents()).toEqual([])
    expect(await seen()).toEqual([
      { token_id: "1", name: "Private #1", image_url: "https://img.example/1.png" },
      { token_id: "2", name: "Short #2", image_url: null },
    ])

    // A later dropped frame does not replace what is known.
    await s.handle(
      listed({ token: "1", priv: true, name: "Renamed", image: "https://img.example/x.png" }),
    )
    expect((await seen())[0]).toMatchObject({ name: "Private #1" })

    // A passing listing still refreshes it.
    await s.handle(listed({ token: "1", name: "Listed #1", image: "https://img.example/y.png" }))
    expect((await seen())[0]).toMatchObject({
      name: "Listed #1",
      image_url: "https://img.example/y.png",
    })
    expect(await listingEvents()).toHaveLength(1)
  })

  it("a failing write is reported and logged, and does not reject", async () => {
    const failing = {
      writeOffchain: async () => {
        throw new Error("db down")
      },
    }
    const s = setup({}, failing)
    await expect(s.handle(listed())).resolves.toBeUndefined()
    expect(reports).toHaveLength(1)
    expect(warnings).toContain("error: listing event not handled")
    // The next event of the same item still runs.
    await expect(s.handle(listed())).resolves.toBeUndefined()
    expect(reports).toHaveLength(2)
  })
})

describe("metadata bursts", () => {
  const traitsDue = async () => {
    const c = await collectionOf(WIRED)
    return { at: c.next_traits_at as Date | null, dirty: c.verdict_dirty as boolean }
  }
  const burst = async (s: ReturnType<typeof setup>, n: number, gap: number, from = T0) => {
    for (let i = 0; i < n; i++) await s.handle(metadata(i, from + i * gap))
  }

  it("metadata burst marks traits re-check", async () => {
    await sql`update indexer.nft_collections set traits_state = 'empty' where contract = ${WIRED}`
    const s = setup()
    clock = T0 + 5 * MIN
    await burst(s, 19, 10 * SEC)
    expect(await traitsDue()).toEqual({ at: null, dirty: false })
    await s.handle(metadata(19, T0 + 190 * SEC))
    expect(await traitsDue()).toEqual({ at: new Date(clock), dirty: true })
  })

  it("20 events over more than 10 minutes are not a burst", async () => {
    const s = setup()
    await burst(s, 40, 40 * SEC)
    expect(await traitsDue()).toEqual({ at: null, dirty: false })
  })

  it("counts each collection on its own", async () => {
    const s = setup()
    for (let i = 0; i < 12; i++) {
      await s.handle(metadata(i, T0 + i * SEC))
      await s.handle({ ...metadata(i, T0 + i * SEC), contract: PRTSCN, slug: "prtscn-ink" })
    }
    expect(await traitsDue()).toEqual({ at: null, dirty: false })
    expect((await collectionOf(PRTSCN)).verdict_dirty).toBe(false)
  })

  it("marks once per burst, then again after a quiet window and another 20", async () => {
    const s = setup()
    await burst(s, 25, SEC)
    expect((await traitsDue()).at).toEqual(new Date(clock))
    await sql`update indexer.nft_collections set next_traits_at = null, verdict_dirty = false where contract = ${WIRED}`

    // The rest of the burst, inside the window, marks nothing more.
    await burst(s, 25, SEC, T0 + 30 * SEC)
    expect(await traitsDue()).toEqual({ at: null, dirty: false })

    // Later: another burst.
    clock = T0 + 30 * MIN
    await burst(s, 20, SEC, T0 + 30 * MIN)
    expect(await traitsDue()).toEqual({ at: new Date(clock), dirty: true })
  })

  it("leaves a collection whose traits passed alone", async () => {
    await sql`update indexer.nft_collections set traits_state = 'pass' where contract = ${WIRED}`
    const s = setup()
    await burst(s, 30, SEC)
    expect(await traitsDue()).toEqual({ at: null, dirty: false })
  })

  it("makes no request for a collection without max_rank", async () => {
    const s = setup({ [nftPath(RANKED)]: ranked() })
    await sql`update indexer.nft_collections set max_rank = null where contract = ${PRTSCN}`
    expect(await s.ranks.getRank(PRTSCN, RANKED, { maxWaitMs: 0 })).toBeNull()
    expect(callsTo(s.fetch, nftPath(RANKED))).toBe(0)
  })
})
