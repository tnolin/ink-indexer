import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  type ChainLog,
  NFTX_LISTINGS,
  NFTX_LOCKER,
  NFTX_ROYALTY_GATE,
  NFTX_ZAPS,
  nftxOrderHash,
} from "@ink-indexer/sdk"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { NftxFixtureName } from "../../../packages/sdk/test/fixtures"
import { createStore, type Store } from "../src/store"
import { nftxHarness, seedPools, stubListings, synthLog, ZERO } from "./nftx-harness"

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

const POOL = "0x97630aa70ab14ed9883b41dafccbc11349723043" as Address
const ZAP = NFTX_ZAPS[1] as Address
const BUYER = "0xdab629a638974c6e5c34c9a17d4f4e5caca15f63"
const LISTER = "0xd7bba3d47e8b612c09f14c9efcacd7c6fe6466f2"
const ZAP_BUY = "0x14d1baad8aec01d8641fa26c5b7e1010547670c2a967afdaf58bc44d6a09e511" as const
const ZAP_BLOCK = 26129909n
const NO_ZAP_TX = "0xd9a9ce3e6aaa649a4789bcd1321dd80b6b4fab3cec969eb2d57d9425ed89349f" as const
const RELIST_TX = "0x6d98a9245d60f1b428696a457b44fa92ce2f5a0052b5a3f7707992ea0fb909d6" as const
// Spot prices (wei per NFT) from the pool prices recorded with each transaction.
const SPOT_IN_ZAP_BUY = 10_954_193_811_602_080n
const SPOT_IN_NO_ZAP = 718_917_621_927_873_673n
const SPOT_BEFORE_RELIST = 261_739_850_963_615_528n

/** Runs recorded transactions through the NFTX source with their pools open and their listings readable. */
async function run(
  names: NftxFixtureName[],
  edit: (t: ReturnType<typeof nftxHarness>) => unknown = () => {},
  opts: { both?: boolean } = {},
) {
  const t = nftxHarness(sql, store, names, opts)
  for (const f of t.loaded) {
    await seedPools(sql, f)
    stubListings(t.chain, f)
  }
  await edit(t)
  await t.live()
  return t
}

const sales = () =>
  sql<
    {
      tx_hash: string
      log_index: number
      contract: string
      token_id: string
      price_wei: string
      currency: string
      buyer: string
      seller: string
      order_hash: string
      block: string
      market: string | null
      qty: string
    }[]
  >`
    select tx_hash, log_index, contract, token_id::text, price_wei::text, currency, buyer, seller,
      order_hash, block::text, market, qty::text
    from indexer.nft_sales order by log_index, token_id::numeric`
const saleEvents = () =>
  sql<{ payload: Record<string, unknown>; sub: string; log_index: number; tx_hash: string }[]>`
    select payload, sub, log_index, tx_hash from indexer.events where type = 'nft.sale'
    order by log_index, sub`

type Harness = ReturnType<typeof nftxHarness>

/** Removes the logs that match, so a test can put its own in their place. */
function dropLogs(t: Harness, drop: (l: ChainLog) => boolean) {
  t.chain.logs = t.chain.logs.filter((l) => !drop(l))
}

/**
 * Replaces the Zap buy's own withdrawal, fill and Zap logs with a buy of `ids` (one fill, in
 * `groups` when given) whose listings read `tokens` each. A `total` adds the Zap's NFTBoughtWithETH.
 */
function buyOf(
  t: Harness,
  ids: bigint[],
  opts: { total?: bigint; tokens?: (bigint | null)[]; groups?: bigint[][] },
) {
  const f = t.loaded[0]!
  const withdrawal = f.logs.find((l) => l.logIndex === 1446)!
  const filled = f.logs.find((l) => l.logIndex === 1455)!
  dropLogs(t, (l) => [1446, 1455, 1458].includes(l.logIndex))
  for (const [i, id] of ids.entries())
    t.chain.add(
      synthLog(
        withdrawal,
        "TokenWithdrawal",
        { _collection: POOL, _tokenId: id, _sender: NFTX_LISTINGS, _recipient: BUYER },
        { address: NFTX_LOCKER, logIndex: 1446 + i },
      ),
    )
  t.chain.add(
    synthLog(
      filled,
      "ListingsFilled",
      { _collection: POOL, _tokenIds: opts.groups ?? [ids], _recipient: ZAP },
      { address: NFTX_LISTINGS, logIndex: 1455 },
    ),
  )
  if (opts.total !== undefined)
    t.chain.add(
      synthLog(
        filled,
        "NFTBoughtWithETH",
        { collection: POOL, nftCount: BigInt(ids.length), ethSpent: opts.total, buyer: BUYER },
        { address: ZAP, logIndex: 1458 },
      ),
    )
  const read = f.listings.before[0]!.read!
  for (const [i, id] of ids.entries())
    t.chain.nftxListings.set(`${POOL}:${id}`, () => ({
      ...read,
      priceTokens: opts.tokens?.[i] ?? null,
    }))
}

const E18 = 10n ** 18n
const at = (l: ChainLog) => ({ address: l.address, logIndex: l.logIndex })

describe("listing fills", () => {
  it("the Ethereum Zap buy gives one listing sale of 29317 by the TokenWithdrawal recipient at the NFTBoughtWithETH ethSpent", async () => {
    await run(["eth-zap-buy"])
    expect(await sales()).toEqual([
      {
        tx_hash: ZAP_BUY,
        log_index: 1455,
        contract: POOL,
        token_id: "29317",
        price_wei: "12587756629698255",
        currency: "ETH",
        buyer: BUYER,
        seller: LISTER,
        order_hash: nftxOrderHash(ZAP_BUY, 1455, 29317n),
        block: ZAP_BLOCK.toString(),
        market: "nftx",
        qty: "1",
      },
    ])
    const [e] = await saleEvents()
    expect(e).toMatchObject({ sub: "sale:29317", log_index: 1455, tx_hash: ZAP_BUY })
    expect(e?.payload).toMatchObject({
      type: "nft.sale",
      market: "nftx",
      via: "listing",
      tokenId: "29317",
      priceWei: "12587756629698255",
      currency: "ETH",
      buyer: BUYER,
      seller: LISTER,
      orderHash: nftxOrderHash(ZAP_BUY, 1455, 29317n),
      blockNumber: ZAP_BLOCK.toString(),
    })
    expect(e?.payload).not.toHaveProperty("toPool")
  })

  it("the second Zap buy gives one sale of 23346", async () => {
    await run(["eth-zap-buy-2"])
    const rows = await sales()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      token_id: "23346",
      price_wei: "12521739789689095",
      buyer: BUYER,
      seller: LISTER,
    })
  })

  it("a fill without a Zap prices getListingPrice at block − 1 times the spot at the fill", async () => {
    const t = await run(["eth-fill-no-zap"])
    const rows = await sales()
    expect(rows).toHaveLength(1)
    // The swap at log 486 is after the fill at 466 and does not move the price.
    expect(rows[0]).toMatchObject({
      tx_hash: NO_ZAP_TX,
      log_index: 466,
      token_id: "1687",
      price_wei: SPOT_IN_NO_ZAP.toString(),
      buyer: "0x50c3820ebf26a94ed05753acaa634935057aa019",
      seller: "0x053e6294400a9268e35df445624f58087c7f388f",
    })
    expect(t.chain.nftxListingReads.map((r) => r.block)).toContain(26435423n)
  })

  it("a listing priced at 1.5 floor tokens sells for 1.5 times the spot (synthetic)", async () => {
    await run(["eth-fill-no-zap"], (t) => {
      const f = t.loaded[0]!
      const read = f.listings.before[0]!.read!
      t.chain.nftxListings.set(`${f.listings.before[0]!.collection}:1687`, () => ({
        ...read,
        priceTokens: 1_500_000_000_000_000_000n,
      }))
    })
    expect((await sales())[0]?.price_wei).toBe(((SPOT_IN_NO_ZAP * 3n) / 2n).toString())
  })

  it("a listing created earlier in the same block, in another transaction, is the listing that is filled (synthetic)", async () => {
    const NEWLISTER = "0x2222222222222222222222222222222222222222" as Address
    const t = await run(["eth-fill-no-zap"], (x) => {
      const f = x.loaded[0]!
      const coll = f.listings.before[0]!.collection
      const read = f.listings.before[0]!.read!
      const fill = f.logs.find((l) => l.logIndex === 466)!
      // Nothing is listed at the block before; the listing is created in this block, ahead of the fill.
      x.chain.nftxListings.set(`${coll}:1687`, (block) =>
        block < f.blockNumber ? { ...read, owner: ZERO, priceTokens: null } : read,
      )
      x.chain.add({
        ...synthLog(
          fill,
          "ListingsCreated",
          {
            _collection: coll,
            _tokenIds: [1687n],
            _listing: { owner: NEWLISTER, created: 1, duration: 3600, floorMultiple: 150 },
            _listingType: 1,
            _tokensRequired: 0n,
            _taxRequired: 0n,
            _sender: NEWLISTER,
          },
          { address: NFTX_LISTINGS, logIndex: 400 },
        ),
        transactionHash: `0x${"ab".repeat(32)}`,
      })
    })
    expect(t.warnings).toEqual([])
    expect(await sales()).toHaveLength(1)
    expect((await sales())[0]).toMatchObject({
      log_index: 466,
      seller: NEWLISTER,
      price_wei: ((SPOT_IN_NO_ZAP * 3n) / 2n).toString(),
    })
    expect((await saleEvents())[0]?.payload).toMatchObject({ via: "listing", seller: NEWLISTER })
  })

  it("a relist earlier in the same block, in another transaction, names the seller of a later Zap buy (synthetic)", async () => {
    const NEWOWNER = "0x3333333333333333333333333333333333333333" as Address
    const t = await run(["eth-zap-buy"], (x) => {
      const filled = x.loaded[0]!.logs.find((l) => l.logIndex === 1455)!
      x.chain.add({
        ...synthLog(
          filled,
          "ListingRelisted",
          {
            _collection: POOL,
            _tokenId: 29317n,
            _listing: { owner: NEWOWNER, created: 1, duration: 3600, floorMultiple: 120 },
          },
          { address: NFTX_LISTINGS, logIndex: 1400 },
        ),
        transactionHash: `0x${"cd".repeat(32)}`,
      })
    })
    const rows = (await sales()).filter((r) => r.log_index === 1455)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      seller: NEWOWNER,
      buyer: BUYER,
      price_wei: "12587756629698255",
    })
    expect(t.warnings.filter((w) => w.msg.includes("fill"))).toEqual([])
  })

  it("a fill with no TokenWithdrawal for its id is skipped with one warning (synthetic)", async () => {
    const t = await run(["eth-zap-buy"], (x) => dropLogs(x, (l) => l.logIndex === 1446))
    expect(await sales()).toEqual([])
    expect(t.warnings.filter((w) => w.msg.includes("no withdrawal"))).toHaveLength(1)
  })

  it("a Zap buy of floor items gives instant buys sold by the Locker (synthetic)", async () => {
    await run(["eth-zap-buy"], (t) => {
      const read = t.loaded[0]!.listings.before[0]!.read!
      t.chain.nftxListings.set(`${POOL}:29317`, () => ({ ...read, owner: ZERO }))
    })
    expect((await sales())[0]).toMatchObject({
      seller: NFTX_LOCKER,
      buyer: BUYER,
      price_wei: "12587756629698255",
    })
    expect((await saleEvents())[0]?.payload).toMatchObject({
      via: "instant_buy",
      seller: NFTX_LOCKER,
    })
  })

  it("a three-item buy's prices add up to ethSpent, split by listing price (synthetic)", async () => {
    const total = 1_000_000_000_000_000_001n
    const t = await run(["eth-zap-buy"], (x) =>
      buyOf(x, [1n, 2n, 3n], {
        total,
        tokens: [1n * E18, 2n * E18, 3n * E18],
        groups: [[1n, 2n], [3n]],
      }),
    )
    expect(t.warnings).toEqual([])
    const rows = await sales()
    const parts = rows.map((r) => BigInt(r.price_wei))
    // Rounded down per item in proportion to 1 : 2 : 3; the last item takes the remainder.
    expect(parts).toEqual([total / 6n, (total * 2n) / 6n, total - total / 6n - (total * 2n) / 6n])
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(total)
    expect(rows.map((r) => r.token_id)).toEqual(["1", "2", "3"])
    expect(new Set(rows.map((r) => r.order_hash)).size).toBe(3)
    expect((await saleEvents()).map((e) => e.sub)).toEqual(["sale:1", "sale:2", "sale:3"])
  })

  it("never two sales for one item in one transaction (synthetic)", async () => {
    await run(["eth-zap-buy"], (t) => {
      const filled = t.loaded[0]!.logs.find((l) => l.logIndex === 1455)!
      // The same fill logged again: the first log in the transaction wins.
      t.chain.add({ ...filled, logIndex: 1456 })
    })
    const rows = await sales()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.log_index).toBe(1455)
    expect(await saleEvents()).toHaveLength(1)
  })

  it("an item filled and then relisted in one transaction is sold once, at the first log (synthetic)", async () => {
    await run(["eth-zap-buy"], (t) => {
      const filled = t.loaded[0]!.logs.find((l) => l.logIndex === 1455)!
      t.chain.add(
        synthLog(
          filled,
          "ListingRelisted",
          {
            _collection: POOL,
            _tokenId: 29317n,
            _listing: { owner: BUYER, created: 1, duration: 3600, floorMultiple: 110 },
          },
          { address: NFTX_LISTINGS, logIndex: 1460 },
        ),
      )
    })
    expect((await sales()).map((r) => r.log_index)).toEqual([1455])
  })

  describe("a fill whose listing read reverts", () => {
    it("is split evenly from NFTBoughtWithETH when its price read reverts (synthetic)", async () => {
      const total = 1_000_000_000_000_000_001n
      const t = await run(["eth-zap-buy"], (x) => buyOf(x, [1n, 2n], { total }))
      expect(t.warnings).toEqual([])
      expect((await sales()).map((r) => BigInt(r.price_wei))).toEqual([
        total / 2n,
        total - total / 2n,
      ])
    })

    it("an unreadable item stays in the split: the other item of a two-item buy gets half the total, not all of it (synthetic)", async () => {
      const total = 1_000_000_000_000_000_001n
      const t = await run(["eth-zap-buy"], (x) => {
        buyOf(x, [1n, 2n], { total, tokens: [E18, E18] })
        x.chain.nftxListings.set(`${POOL}:2`, null)
      })
      const rows = await sales()
      expect(rows.map((r) => [r.token_id, BigInt(r.price_wei)])).toEqual([["1", total / 2n]])
      expect(t.warnings.filter((w) => w.msg.includes("listing read"))).toHaveLength(1)
    })

    it("is skipped with one warning without a Zap buy (synthetic)", async () => {
      const t = await run(["eth-zap-buy"], (x) => buyOf(x, [1n], {}))
      expect(await sales()).toEqual([])
      expect(t.warnings.filter((w) => w.msg.includes("listing read"))).toHaveLength(1)
    })

    it("is skipped with one warning when the listing itself cannot be read (synthetic)", async () => {
      const t = await run(["eth-zap-buy"], (x) => x.chain.nftxListings.set(`${POOL}:29317`, null))
      expect(await sales()).toEqual([])
      expect(t.warnings.filter((w) => w.msg.includes("listing read"))).toHaveLength(1)
    })
  })
})

describe("after CollectionSunset", () => {
  it("a sale in a block after the sunset gives no sale row and no event (synthetic)", async () => {
    await run(["eth-zap-buy"], async () => {
      await sql`update indexer.nftx_collections set sunset_block = ${(ZAP_BLOCK - 1n).toString()}`
    })
    expect(await sales()).toEqual([])
    expect(await saleEvents()).toEqual([])
  })

  it("a sale in the sunset's own block, before its log, still counts (synthetic)", async () => {
    await run(["eth-zap-buy"], async () => {
      await sql`update indexer.nftx_collections set sunset_block = ${ZAP_BLOCK.toString()}`
    })
    expect(await sales()).toHaveLength(1)
  })
})

describe("relists", () => {
  it("the recorded relist of 19758 is a relist of a floor item and gives no sale", async () => {
    const t = await run(["eth-relist"])
    expect(await sales()).toEqual([])
    expect(t.warnings).toEqual([])
  })

  it("a relist from an owner sells to the new listing's owner, via listing, at getListingPrice times the spot (synthetic)", async () => {
    const OLD = "0x1111111111111111111111111111111111111111"
    const NEW = "0x498e93bc04955fcbac04bcf1a3ba792f01dbaa96"
    const coll = "0x524cab2ec69124574082676e6f654a18df49a048"
    await sql`insert into indexer.nft_listing_state ${sql({
      contract: coll,
      token_id: "19758",
      last_price_wei: "1",
      order_hash: RELIST_TX,
      expires_at: new Date("2099-01-01"),
    })}`
    await run(["eth-relist"], (t) => {
      const read = t.loaded[0]!.listings.before[0]!.read!
      t.chain.nftxListings.set(`${coll}:19758`, () => ({
        ...read,
        owner: OLD as Address,
        priceTokens: (11n * E18) / 10n,
      }))
    })
    const [row] = await sales()
    expect(row).toMatchObject({
      tx_hash: RELIST_TX,
      log_index: 545,
      contract: coll,
      token_id: "19758",
      price_wei: ((((11n * E18) / 10n) * SPOT_BEFORE_RELIST) / E18).toString(),
      buyer: NEW,
      seller: OLD,
      market: "nftx",
    })
    expect((await saleEvents())[0]?.payload).toMatchObject({ via: "listing", market: "nftx" })
    expect(await sql`select 1 from indexer.nft_listing_state`).toHaveLength(0)
  })
})

describe("instant trades", () => {
  it("NFTSoldForETH gives instant sells bought by the Locker", async () => {
    await run(["eth-sold-for-eth"])
    expect(await sales()).toEqual([
      expect.objectContaining({
        log_index: 67,
        token_id: "3430",
        price_wei: "10150412504793657",
        seller: "0xc8f04c44bd4a6ac2858c85dd237357b6244c88b3",
        buyer: NFTX_LOCKER,
        market: "nftx",
        currency: "ETH",
      }),
    ])
    expect((await saleEvents())[0]?.payload).toMatchObject({
      via: "instant_sell",
      buyer: NFTX_LOCKER,
    })
  })

  it("NFTSoldForETH splits ethReceived across its items, the remainder on the last (synthetic)", async () => {
    await run(["eth-sold-for-eth"], (t) => {
      const sold = t.loaded[0]!.logs.find((l) => l.logIndex === 67)!
      dropLogs(t, (l) => l.logIndex === 67)
      t.chain.add(
        synthLog(
          sold,
          "NFTSoldForETH",
          {
            collection: "0x06f97e756f5c7ac0db75411101bd09e17f63aba7",
            tokenIds: [10n, 11n, 12n],
            ethReceived: 100n,
            seller: "0xc8f04c44bd4a6ac2858c85dd237357b6244c88b3",
          },
          at(sold),
        ),
      )
    })
    expect((await sales()).map((r) => r.price_wei)).toEqual(["33", "33", "34"])
  })

  it("FloorRedeemedWithETH gives instant buys sold by the Locker", async () => {
    await run(["eth-floor-redeemed"])
    expect(await sales()).toEqual([
      expect.objectContaining({
        log_index: 33,
        token_id: "1700",
        price_wei: "699598868589792183",
        seller: NFTX_LOCKER,
        buyer: "0x9fa7f0702246b8e510869cebfe5b8d3ecb124918",
        market: "nftx",
      }),
    ])
    expect((await saleEvents())[0]?.payload).toMatchObject({
      via: "instant_buy",
      seller: NFTX_LOCKER,
    })
  })

  it("FloorRedeemedWithETH splits ethSpent across its items, the remainder on the last (synthetic)", async () => {
    await run(["eth-floor-redeemed"], (t) => {
      const redeemed = t.loaded[0]!.logs.find((l) => l.logIndex === 33)!
      dropLogs(t, (l) => l.logIndex === 33)
      t.chain.add(
        synthLog(
          redeemed,
          "FloorRedeemedWithETH",
          {
            collection: "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
            tokenIds: [10n, 11n, 12n],
            ethSpent: 100n,
            redeemer: "0x9fa7f0702246b8e510869cebfe5b8d3ecb124918",
          },
          at(redeemed),
        ),
      )
    })
    expect((await sales()).map((r) => r.price_wei)).toEqual(["33", "33", "34"])
  })

  it.each([
    ["after", 70],
    ["before", 60],
  ])(
    "a GatedSale logged %s the Zap's NFTSoldForETH for the same ids books one sale, at the seller and net price the GatedSale names (synthetic)",
    async (_where, logIndex) => {
      const SELLER = "0x2222222222222222222222222222222222222222"
      const net = 9_000_000_000_000_000n
      await run(["eth-sold-for-eth"], (t) => {
        const sold = t.loaded[0]!.logs.find((l) => l.logIndex === 67)!
        t.chain.add(
          synthLog(
            sold,
            "GatedSale",
            {
              _collection: "0x06f97e756f5c7ac0db75411101bd09e17f63aba7",
              _tokenIds: [3430n],
              _seller: SELLER,
              _ethReceived: net,
              _royalty: 1n,
            },
            { address: NFTX_ROYALTY_GATE, logIndex },
          ),
        )
      })
      const rows = await sales()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ token_id: "3430", seller: SELLER, price_wei: net.toString() })
      expect(await saleEvents()).toHaveLength(1)
    },
  )

  it("GatedSale gives instant sells (synthetic)", async () => {
    await run(["eth-sold-for-eth"], (t) => {
      const sold = t.loaded[0]!.logs.find((l) => l.logIndex === 67)!
      dropLogs(t, (l) => l.logIndex === 67)
      t.chain.add(
        synthLog(
          sold,
          "GatedSale",
          {
            _collection: "0x06f97e756f5c7ac0db75411101bd09e17f63aba7",
            _tokenIds: [3430n],
            _seller: "0xc8f04c44bd4a6ac2858c85dd237357b6244c88b3",
            _ethReceived: 10_150_412_504_793_657n,
            _royalty: 1n,
          },
          { address: NFTX_ROYALTY_GATE, logIndex: 67 },
        ),
      )
    })
    expect(await sales()).toEqual([
      expect.objectContaining({
        token_id: "3430",
        price_wei: "10150412504793657",
        buyer: NFTX_LOCKER,
        seller: "0xc8f04c44bd4a6ac2858c85dd237357b6244c88b3",
      }),
    ])
    expect((await saleEvents())[0]?.payload).toMatchObject({ via: "instant_sell" })
  })

  it("a trade in a collection with no NFTX pool gives no sale", async () => {
    const t = nftxHarness(sql, store, ["eth-floor-redeemed"])
    await t.live()
    expect(await sales()).toEqual([])
  })
})

describe("arbitrage", () => {
  it("the arbitrage transaction gives no NFTX sale", async () => {
    await run(["arbitrage-lildudes"], () => {}, { both: true })
    expect(await sql`select 1 from indexer.nft_sales where market = 'nftx'`).toHaveLength(0)
    // Its Seaport sale is still the nft source's own, marked as bound for the pool.
    expect((await saleEvents()).map((e) => e.payload.market)).toEqual([undefined])
    expect((await saleEvents())[0]?.payload).toMatchObject({ toPool: true })
  })
})

describe("closed listings", () => {
  const state = (id: string) => ({
    contract: POOL,
    token_id: id,
    last_price_wei: "1",
    order_hash: ZAP_BUY,
    expires_at: new Date("2099-01-01"),
  })

  it("a fill removes the item's nft_listing_state", async () => {
    await sql`insert into indexer.nft_listing_state ${sql([state("29317"), state("5")])}`
    await run(["eth-zap-buy"])
    expect(
      (await sql`select token_id::text from indexer.nft_listing_state`).map((r) => r.token_id),
    ).toEqual(["5"])
  })

  it("a cancel and a stale close remove the item's nft_listing_state (synthetic)", async () => {
    await sql`insert into indexer.nft_listing_state ${sql(["7", "8", "9", "10"].map(state))}`
    await run(["eth-zap-buy"], (t) => {
      const like = t.loaded[0]!.logs.find((l) => l.logIndex === 1455)!
      t.chain.add(
        synthLog(
          like,
          "ListingsCancelled",
          { _collection: POOL, _tokenIds: [7n, 8n] },
          { address: NFTX_LISTINGS, logIndex: 1500 },
        ),
      )
      t.chain.add(
        synthLog(
          like,
          "ListingClosedAsStale",
          { _collection: POOL, _tokenId: 9n, _owner: LISTER, _feesCaptured: 0n, _refunded: 0n },
          { address: NFTX_LISTINGS, logIndex: 1501 },
        ),
      )
    })
    expect(
      (await sql`select token_id::text from indexer.nft_listing_state`).map((r) => r.token_id),
    ).toEqual(["10"])
  })
})

describe("sale events", () => {
  it("a sale with no OpenSea data has the NFTX floor and null item name", async () => {
    await run(["eth-zap-buy"])
    expect((await saleEvents())[0]?.payload).toMatchObject({
      floorWei: SPOT_IN_ZAP_BUY.toString(),
      itemName: null,
      imageUrl: null,
      rank: null,
      maxRank: null,
      nftxSlug: null,
    })
  })

  it("a sale takes the item's name, image and rank from what listings cached, and the lower of the OpenSea and NFTX floors", async () => {
    const CALCULATED = new Date("2026-11-01T00:00:00Z")
    await sql`insert into indexer.nft_collections ${sql({
      contract: POOL,
      rarity_calculated_at: CALCULATED,
      nftx_slug: "cool-things",
    })}`
    await sql`insert into indexer.nft_items_seen ${sql({
      contract: POOL,
      token_id: "29317",
      name: "Thing #29317",
      image_url: "https://img.example/29317.png",
      seen_at: new Date(),
    })}`
    await sql`insert into indexer.nft_ranks ${sql({
      contract: POOL,
      token_id: "29317",
      rank: 12,
      max_rank: 1000,
      calculated_at: CALCULATED,
      fetched_at: new Date(),
    })}`
    // OpenSea's floor is below the pool's.
    await sql`insert into indexer.nft_stats ${sql({
      contract: POOL,
      at: new Date(Date.now() - 60_000),
      floor_wei: (SPOT_IN_ZAP_BUY / 2n).toString(),
    })}`
    await run(["eth-zap-buy"])
    expect((await saleEvents())[0]?.payload).toMatchObject({
      itemName: "Thing #29317",
      imageUrl: "https://img.example/29317.png",
      rank: 12,
      maxRank: 1000,
      floorWei: (SPOT_IN_ZAP_BUY / 2n).toString(),
      nftxSlug: "cool-things",
    })
  })
})

describe("rolling back sales", () => {
  it("rollback removes the NFTX sales and their events", async () => {
    const t = await run(["eth-zap-buy"])
    expect(await sales()).toHaveLength(1)
    t.chain.reorg(ZAP_BLOCK)
    await t.idx.trigger()
    expect(await sales()).toEqual([])
    expect(await saleEvents()).toEqual([])
  })
})
