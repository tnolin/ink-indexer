import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { NFTX_LISTINGS, type NftxLog, nftxOrderHash } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { NftxFixtureName } from "../../../packages/sdk/test/fixtures"
import { nftxSource } from "../src/sources/nftx/index"
import { listingDrafts } from "../src/sources/nftx/listings"
import { createStore, type Store } from "../src/store"
import { nftxHarness, seedPools, stubListings, synthLog } from "./nftx-harness"

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

const COLLECTION = "0x4a8b01e437c65fa8612e8b699266c0e0a98ff65c" as Address
const LISTER = "0xd7bba3d47e8b612c09f14c9efcacd7c6fe6466f2" as Address
const CREATED_TX = "0x6b1e86e611a92de048fb04d5f2cde9b86c33c1e263ad6dbb8f8ed8b5828b5bd4" as const
const CREATED_TIME = 1785327371
const WEEK = 604800
// Spot prices (wei per NFT) from the pool prices recorded with each transaction.
const SPOT_CREATED = 3_906_249_999_999_999n
const SPOT_RELIST = 261_739_850_963_615_528n

type Opts = Parameters<typeof nftxHarness>[3]
type Harness = ReturnType<typeof nftxHarness>

async function run(
  names: NftxFixtureName[],
  edit: (t: Harness) => void | Promise<void> = () => {},
  opts: Opts = {},
  how: "live" | "backfill" = "live",
) {
  const t = nftxHarness(sql, store, names, opts)
  for (const f of t.loaded) {
    await seedPools(sql, f)
    stubListings(t.chain, f)
  }
  await edit(t)
  await t[how]()
  return t
}

const listings = () =>
  sql<{ payload: Record<string, unknown>; sub: string; log_index: number; tx_hash: string }[]>`
    select payload, sub, log_index, tx_hash from indexer.events where type = 'nft.listing'
    order by log_index, sub`

/** Replaces the recorded `ListingsCreated` with one built from its ABI. */
function created(t: Harness, over: { multiple?: number; duration?: number; type?: 0 | 1 }) {
  const log = t.loaded[0]!.logs.find((l) => l.logIndex === 1163)!
  t.chain.logs = t.chain.logs.filter((l) => l.logIndex !== 1163)
  t.chain.add(
    synthLog(
      log,
      "ListingsCreated",
      {
        _collection: COLLECTION,
        _tokenIds: [24375n],
        _listing: {
          owner: LISTER,
          created: CREATED_TIME,
          duration: over.duration ?? WEEK,
          floorMultiple: over.multiple ?? 120,
        },
        _listingType: over.type ?? 1,
        _tokensRequired: 1n,
        _taxRequired: 1n,
        _sender: LISTER,
      },
      { address: NFTX_LISTINGS, logIndex: 1163 },
    ),
  )
}

/** Replaces the recorded `ListingsCreated` with a floor-multiple update of the same item. */
function updated(t: Harness, multiple: number) {
  const log = t.loaded[0]!.logs.find((l) => l.logIndex === 1163)!
  t.chain.logs = t.chain.logs.filter((l) => l.logIndex !== 1163)
  t.chain.add(
    synthLog(
      log,
      "ListingFloorMultipleUpdated",
      {
        _collection: COLLECTION,
        _tokenId: 24375n,
        _oldFloorMultiple: 120,
        _newFloorMultiple: multiple,
      },
      { address: NFTX_LISTINGS, logIndex: 1163 },
    ),
  )
}

describe("liquid and dutch listings", () => {
  it("the liquid ListingsCreated gives a listing at 1.20x the spot with listingType liquid", async () => {
    await run(["eth-listing-created"])
    const [e] = await listings()
    expect(e).toMatchObject({ sub: "list:24375", log_index: 1163, tx_hash: CREATED_TX })
    expect(e?.payload).toMatchObject({
      type: "nft.listing",
      market: "nftx",
      currency: "ETH",
      tokenId: "24375",
      priceWei: ((120n * SPOT_CREATED) / 100n).toString(),
      maker: LISTER,
      expiresAt: CREATED_TIME + WEEK,
      orderHash: nftxOrderHash(CREATED_TX, 1163, 24375n),
      floorMultiple: 120,
      listingType: "liquid",
      // No OpenSea data: the pool's price is the floor, as of the listing.
      floorWei: SPOT_CREATED.toString(),
      floorAt: CREATED_TIME,
      nftxSlug: null,
      itemName: null,
      rank: null,
      maxRank: null,
    })
  })

  it("a Dutch listing gives listingType dutch (synthetic)", async () => {
    await run(["eth-listing-created"], (t) => created(t, { type: 0 }))
    expect((await listings())[0]?.payload).toMatchObject({
      listingType: "dutch",
      floorMultiple: 120,
    })
  })

  it("the relist gives a listing at 1.10x (the type is read from the Listings contract)", async () => {
    await run(["eth-relist"])
    const [e] = await listings()
    expect(e).toMatchObject({ sub: "list:19758", log_index: 545 })
    expect(e?.payload).toMatchObject({
      market: "nftx",
      priceWei: ((110n * SPOT_RELIST) / 100n).toString(),
      maker: "0x498e93bc04955fcbac04bcf1a3ba792f01dbaa96",
      listingType: "liquid",
      floorMultiple: 110,
      expiresAt: 1791452939 + WEEK,
    })
  })

  it("a floor-multiple update re-prices the listing, with the owner and times read at the block (synthetic)", async () => {
    await run(["eth-listing-created"], (t) => updated(t, 150))
    expect((await listings())[0]?.payload).toMatchObject({
      priceWei: ((150n * SPOT_CREATED) / 100n).toString(),
      floorMultiple: 150,
      maker: LISTER,
      listingType: "liquid",
      expiresAt: CREATED_TIME + WEEK,
    })
  })

  it("an update of a listing that is gone by the end of the block gives no event (synthetic)", async () => {
    await run(["eth-listing-created"], (t) => {
      updated(t, 150)
      const read = t.loaded[0]!.listings.at[0]!.read!
      t.chain.nftxListings.set(`${COLLECTION}:24375`, () => ({
        ...read,
        owner: "0x0000000000000000000000000000000000000000",
      }))
    })
    expect(await listings()).toEqual([])
  })
})

describe("one event per listing", () => {
  it("a ListingsCreated of several ids gives a listing for each id, once (synthetic)", async () => {
    await run(["eth-listing-created"], (t) => {
      const log = t.loaded[0]!.logs.find((l) => l.logIndex === 1163)!
      t.chain.logs = t.chain.logs.filter((l) => l.logIndex !== 1163)
      t.chain.add(
        synthLog(
          log,
          "ListingsCreated",
          {
            _collection: COLLECTION,
            _tokenIds: [3n, 4n, 4n, 5n],
            _listing: { owner: LISTER, created: CREATED_TIME, duration: WEEK, floorMultiple: 120 },
            _listingType: 1,
            _tokensRequired: 1n,
            _taxRequired: 1n,
            _sender: LISTER,
          },
          { address: NFTX_LISTINGS, logIndex: 1163 },
        ),
      )
    })
    expect((await listings()).map((e) => e.sub)).toEqual(["list:3", "list:4", "list:5"])
  })
})

describe("floor", () => {
  it("a listing above a lower OpenSea floor carries OpenSea's floor and its time (synthetic)", async () => {
    const osAt = new Date((CREATED_TIME - 600) * 1000)
    await sql`insert into indexer.nft_stats ${sql({
      contract: COLLECTION,
      at: osAt,
      floor_wei: (SPOT_CREATED / 2n).toString(),
    })}`
    await run(["eth-listing-created"])
    expect((await listings())[0]?.payload).toMatchObject({
      floorWei: (SPOT_CREATED / 2n).toString(),
      floorAt: CREATED_TIME - 600,
    })
  })
})

describe("listing logs that are not read", () => {
  const EXTENDED = "0x978b110b1e258411462d703b173c821999f16cfdb075a8053cd8abaa567b8954"
  const TRANSFERRED = "0x82b30eba1c9622f3eaae428f942ee1ebcbb088e48b8abfae893854138dcd327c"
  const word = (n: bigint | string) => n.toString(16).padStart(64, "0")
  const collectionTopic = `0x${word(COLLECTION.slice(2))}` as const

  it("no filter asks for ListingExtended or ListingTransferred", () => {
    const t = nftxHarness(sql, store, ["eth-listing-created"], {})
    const source = nftxSource({ sql, chain: t.chain, logger: () => {}, launchpad: null })
    const topics = JSON.stringify(source.filters(undefined))
    expect(topics).not.toContain(EXTENDED)
    expect(topics).not.toContain(TRANSFERRED)
  })

  it("ListingExtended and ListingTransferred logs from the Listings contract change nothing", async () => {
    const snapshot = async () => ({
      events: await sql`select id, type, sub, log_index, payload from indexer.events order by id`,
      state: await sql`select * from indexer.nft_listing_state order by 1, 2`,
    })
    await run(["eth-listing-created"])
    const baseline = await snapshot()
    expect(baseline.events).toHaveLength(1)

    await sql.end()
    sql = await resetDb(inject("databaseUrl"))
    store = createStore(sql)
    await run(["eth-listing-created"], (t) => {
      const like = t.loaded[0]!.logs.find((l) => l.logIndex === 1163)!
      t.chain.add({
        ...like,
        address: NFTX_LISTINGS,
        topics: [EXTENDED, collectionTopic],
        data: `0x${word(24375n)}${word(604800n)}${word(1209600n)}`,
        logIndex: 1164,
      })
      t.chain.add({
        ...like,
        address: NFTX_LISTINGS,
        topics: [TRANSFERRED, collectionTopic],
        data: `0x${word(24375n)}${word(LISTER.slice(2))}${word(LISTER.slice(2))}`,
        logIndex: 1165,
      })
    })
    expect(await snapshot()).toEqual(baseline)
  })
})

describe("short life", () => {
  it("a listing that expires 20 minutes after it is posted is announced (synthetic)", async () => {
    await run(["eth-listing-created"], (t) => created(t, { duration: 20 * 60 }))
    expect(await listings()).toHaveLength(1)
  })

  it("a listing with under an hour left is announced (synthetic)", async () => {
    await run(["eth-listing-created"], (t) => created(t, { duration: 3599 }))
    expect(await listings()).toHaveLength(1)
  })

  it("a listing with exactly an hour left is announced (synthetic)", async () => {
    await run(["eth-listing-created"], (t) => created(t, { duration: 3600 }))
    expect(await listings()).toHaveLength(1)
  })
})

describe("rank", () => {
  const getRank = (calls: string[]) => ({
    current: {
      getRank: async (contract: string, tokenId: string) => {
        calls.push(`${contract}:${tokenId}`)
        return { rank: 5, maxRank: 100 }
      },
    },
  })

  it("a listing within 1.1x of the combined floor asks for a rank (synthetic)", async () => {
    const near: string[] = []
    await run(["eth-listing-created"], (t) => updated(t, 105), { ranks: getRank(near) })
    expect(near).toEqual([`${COLLECTION}:24375`])
    expect((await listings())[0]?.payload).toMatchObject({ rank: 5, maxRank: 100 })
  })

  it("a listing above 1.1x of the combined floor asks for no rank", async () => {
    const calls: string[] = []
    await run(["eth-listing-created"], () => {}, { ranks: getRank(calls) })
    expect(calls).toEqual([])
    expect((await listings())[0]?.payload).toMatchObject({ rank: null })
  })

  it("exactly 1.1x of the floor asks for a rank (synthetic)", async () => {
    const calls: string[] = []
    await run(
      ["eth-listing-created"],
      async (t) => {
        updated(t, 110)
        await sql`update indexer.nftx_prices set price_wei = 1000000000000000`
      },
      { ranks: getRank(calls) },
    )
    expect(calls).toHaveLength(1)
  })

  it("a backfill asks for no rank and carries the cached one (synthetic)", async () => {
    const calls: string[] = []
    await run(
      ["eth-listing-created"],
      (t) => updated(t, 105),
      { ranks: getRank(calls) },
      "backfill",
    )
    expect(calls).toEqual([])
    expect((await listings())[0]?.payload).toMatchObject({ rank: null })
  })

  it("without OpenSea services cached ranks are used (synthetic)", async () => {
    const CALCULATED = new Date("2026-11-01T00:00:00Z")
    await sql`insert into indexer.nft_collections ${sql({ contract: COLLECTION, rarity_calculated_at: CALCULATED })}`
    await sql`insert into indexer.nft_ranks ${sql({
      contract: COLLECTION,
      token_id: "24375",
      rank: 7,
      max_rank: 90,
      calculated_at: CALCULATED,
      fetched_at: new Date(),
    })}`
    await run(["eth-listing-created"], () => {}, { ranks: { current: null } })
    expect((await listings())[0]?.payload).toMatchObject({ rank: 7, maxRank: 90 })
  })
})

describe("revert and price floor", () => {
  it("a listing whose read reverts gives no event and one warning (synthetic)", async () => {
    const t = await run(["eth-relist"], (x) => {
      x.chain.nftxListings.set("0x524cab2ec69124574082676e6f654a18df49a048:19758", null)
    })
    expect(await listings()).toEqual([])
    expect(t.warnings.filter((w) => w.msg.includes("relisting"))).toHaveLength(1)
  })

  it("an update whose read reverts gives no event and one warning (synthetic)", async () => {
    const t = await run(["eth-listing-created"], (x) => {
      updated(x, 150)
      x.chain.nftxListings.set(`${COLLECTION}:24375`, null)
    })
    expect(await listings()).toEqual([])
    expect(t.warnings.filter((w) => w.msg.includes("listing read"))).toHaveLength(1)
  })

  it("a collection with no NFTX pool gives no listing", async () => {
    const t = nftxHarness(sql, store, ["eth-listing-created"])
    await t.live()
    expect(await listings()).toEqual([])
  })

  it("an NFTX listing is never under the combined floor (multiple of 101 or more against the same spot)", () => {
    const log = (multiple: number): { block: bigint; logIndex: number; d: NftxLog } => ({
      block: 10n,
      logIndex: 1,
      d: {
        kind: "listingsCreated",
        collection: COLLECTION,
        tokenIds: [1n],
        listing: { owner: LISTER, created: 0, duration: 10 * WEEK, floorMultiple: multiple },
        listingType: "liquid",
        tokensRequired: 0n,
        taxRequired: 0n,
        sender: LISTER,
      },
    })
    for (const spot of [1n, 99n, 100n, 101n, 3_906_250_000_000_000n, 10n ** 21n + 7n])
      for (const multiple of [101, 102, 150, 1000]) {
        const [draft] = listingDrafts([log(multiple)], {
          at: new Map(),
          spotAt: () => spot,
          timestamp: () => 0,
          warn: () => {},
        })
        expect(draft!.priceWei).toBeGreaterThanOrEqual(spot)
      }
  })

  it("a pool without a price gives no listing (synthetic)", () => {
    const drafts = listingDrafts(
      [
        {
          block: 10n,
          logIndex: 1,
          d: {
            kind: "listingsCreated",
            collection: COLLECTION,
            tokenIds: [1n],
            listing: { owner: LISTER, created: 0, duration: 10 * WEEK, floorMultiple: 120 },
            listingType: "liquid",
            tokensRequired: 0n,
            taxRequired: 0n,
            sender: LISTER,
          },
        },
      ],
      { at: new Map(), spotAt: () => null, timestamp: () => 0, warn: () => {} },
    )
    expect(drafts).toEqual([])
  })
})

describe("after CollectionSunset", () => {
  it("a listing in a block after the sunset gives no event (synthetic)", async () => {
    await run(["eth-listing-created"], async () => {
      await sql`update indexer.nftx_collections set sunset_block = 1`
    })
    expect(await listings()).toEqual([])
  })
})
