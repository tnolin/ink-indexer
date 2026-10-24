import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { NftLaunchEvent } from "@ink-indexer/events"
import {
  CHIMERA_FACTORY,
  type ChainLog,
  decodeChimeraCampaign,
  decodeNftTransfers,
  decodeOrderFulfilled,
  NFT_TOPICS,
  SEADROP_V1,
  SEAPORT_1_5,
  SEAPORT_1_6,
  ZERO_TOPIC,
} from "@ink-indexer/sdk"
import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, pad, parseAbi } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import {
  loadChimeraCampaigns,
  loadNftFixture,
  loadSeaportRoles,
} from "../../../packages/sdk/test/fixtures"
import { Indexer } from "../src/loop"
import type { LogFilter } from "../src/rpc"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { nftSource } from "../src/sources/nft/index"
import { createCollectionsFromSales } from "../src/sources/nft/write"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const WIRED = "0x7c701c0148e0e965065aa05e008ac9341e6efc6c"
const PRTSCN = "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448"
const SWEEP_COLLECTION = "0x92808d029fdeaaeb589305e280dd0e6a10bfd016"
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address
const BOB = "0x0000000000000000000000000000000000000b0b" as Address
const NFT_A = "0x00000000000000000000000000000000000000a1" as Address

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

const lastBlock = (logs: ChainLog[]) =>
  logs.reduce((m, l) => (l.blockNumber > m ? l.blockNumber : m), 0n)
const firstBlock = (logs: ChainLog[]) =>
  logs.reduce((m, l) => (l.blockNumber < m ? l.blockNumber : m), logs[0]!.blockNumber)

/** A chain holding `logs`, an indexer with only the NFT source, and a backfill over the logs' range. */
async function ingest(logs: ChainLog[], prepare: (chain: FakeChain) => void = () => {}) {
  const chain = new FakeChain(lastBlock(logs) + 5n)
  for (const l of logs) chain.add(l)
  prepare(chain)
  const idx = new Indexer({
    chain,
    store,
    logger: () => {},
    sources: [nftSource({ sql, chain, logger: () => {} })],
  })
  await idx.init()
  await idx.backfill(firstBlock(logs), chain.head)
  return { chain, idx }
}

const count = async (table: string, where = "true") =>
  Number((await sql.unsafe(`select count(*)::int as n from indexer.${table} where ${where}`))[0]!.n)

const ORDER_ABI = parseAbi([
  "struct SpentItem { uint8 itemType; address token; uint256 identifier; uint256 amount; }",
  "struct ReceivedItem { uint8 itemType; address token; uint256 identifier; uint256 amount; address recipient; }",
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, SpentItem[] offer, ReceivedItem[] consideration)",
])
type Item = { itemType: number; token: Address; identifier: bigint; amount: bigint }

/** A synthetic OrderFulfilled: the offerer sells `nfts` for `eth` wei paid to itself. */
function orderLog(nfts: Item[], eth: bigint, logIndex = 0): ChainLog {
  const topics = encodeEventTopics({
    abi: ORDER_ABI,
    eventName: "OrderFulfilled",
    args: { offerer: ALICE, zone: "0x0000000000000000000000000000000000000000" },
  }) as Hex[]
  const data = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "address" },
      {
        type: "tuple[]",
        components: [
          { type: "uint8" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
        ],
      },
      {
        type: "tuple[]",
        components: [
          { type: "uint8" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "address" },
        ],
      },
    ],
    [
      `0x${"ab".repeat(32)}`,
      BOB,
      nfts.map((i) => [i.itemType, i.token, i.identifier, i.amount] as const),
      [[0, "0x0000000000000000000000000000000000000000", 0n, eth, ALICE] as const],
    ],
  )
  return {
    address: SEAPORT_1_6,
    topics,
    data,
    blockNumber: 58_000_000n,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"22".repeat(32)}`,
    logIndex,
  }
}
const nft1155 = (id: bigint, amount: bigint): Item => ({
  itemType: 3,
  token: NFT_A,
  identifier: id,
  amount,
})

describe("NFT source", () => {
  it("chimera fixture: five nft_launches rows; WIRED's collection is continuous on chimera before any of its mints are ingested", async () => {
    await ingest(loadChimeraCampaigns())
    expect(await count("nft_launches")).toBe(5)
    expect(await count("nft_mints")).toBe(0)
    const [wired] = await sql`select * from indexer.nft_collections where contract = ${WIRED}`
    expect(wired).toMatchObject({
      kind: "continuous",
      launchpad: "chimera",
      launch_token: "0xc7d264d906b488ef6660005af5450c979f58006c",
      first_mint_block: null,
    })
    const [launch] = await sql`select * from indexer.nft_launches where collection = ${WIRED}`
    expect(launch).toMatchObject({
      launchpad: "chimera",
      block: 58_346_281n,
      token: "0xc7d264d906b488ef6660005af5450c979f58006c",
    })
    expect(await count("nft_collections")).toBe(5)
  })

  it("chimera launch emits nft.launch with token symbol and name; a reverting symbol gives null", async () => {
    const campaigns = loadChimeraCampaigns()
    const decoded = campaigns
      .map((l) => ({ log: l, d: decodeChimeraCampaign(l)! }))
      .filter((x) => x.d !== null)
    const wired = decoded.find((x) => x.d.collection === WIRED)!
    const other = decoded.find((x) => x.d.collection !== WIRED)!
    const { chain } = await ingest(campaigns, (c) => {
      c.erc20Names.set(wired.d.token, { symbol: "WIRED", name: "Wired Token" })
      c.erc20Names.set(other.d.token, { symbol: null, name: "Other Token" })
    })

    const rows = await sql<
      { payload: NftLaunchEvent; sub: string; entity: string; block: string }[]
    >`
      select payload, sub, entity, block from indexer.events where type = 'nft.launch' order by id`
    expect(rows).toHaveLength(5)
    const w = rows.find((r) => r.entity === WIRED)!
    expect(w.sub).toBe("")
    expect(w.payload).toEqual({
      v: 1,
      chainId: 57073,
      type: "nft.launch",
      source: "chain",
      contract: WIRED,
      txHash: wired.log.transactionHash,
      logIndex: wired.log.logIndex,
      blockNumber: wired.log.blockNumber.toString(),
      blockTimestamp: Number(wired.log.blockNumber),
      launchpad: "chimera",
      campaignId: wired.d.campaignId.toString(),
      token: wired.d.token,
      tokenSymbol: "WIRED",
      tokenName: "Wired Token",
      creator: wired.d.creator,
      poolId: wired.d.poolId,
    })
    expect(BigInt(w.block)).toBe(wired.log.blockNumber)
    const o = rows.find((r) => r.entity === other.d.collection)!
    expect(o.payload).toMatchObject({ tokenSymbol: null, tokenName: "Other Token" })
    // Tokens nobody answered for revert on both.
    const bare = rows.filter(
      (r) => r.payload.token !== wired.d.token && r.payload.token !== other.d.token,
    )
    for (const r of bare) expect(r.payload).toMatchObject({ tokenSymbol: null, tokenName: null })

    // The launch creator is kept on the collection.
    const [row] =
      await sql`select creator_address from indexer.nft_collections where contract = ${WIRED}`
    expect(row!.creator_address).toBe(wired.d.creator)
    // Names are read once per batch, not once per launch.
    expect(chain.nameReads.length).toBeGreaterThan(0)
    expect(chain.nameReads.length).toBeLessThan(5)
  })

  it("a second campaign for a collection emits its own nft.launch and keeps the first creator", async () => {
    const [first] = loadChimeraCampaigns().filter((l) => l.blockNumber === 58_346_281n)
    const second = {
      ...first!,
      blockNumber: 58_346_300n,
      logIndex: 3,
      transactionHash: `0x${"33".repeat(32)}` as const,
    }
    await ingest([first!, second])
    expect(await count("events", "type = 'nft.launch'")).toBe(2)
    expect(await count("nft_launches")).toBe(1)
  })

  it("chimera launch then mint keeps the launchpad and sets the first mint", async () => {
    const wired = loadNftFixture("wired-transfers")
    await ingest([...loadChimeraCampaigns(), ...wired])
    const [row] = await sql`select * from indexer.nft_collections where contract = ${WIRED}`
    expect(row).toMatchObject({ kind: "continuous", launchpad: "chimera", standard: "erc721" })
    expect(row!.first_mint_block).not.toBeNull()
  })

  it("hornet fixture: 2,222 nft_mints rows, one collection with seadrop true and first_mint_ts of the first block", async () => {
    const logs = loadNftFixture("hornet-mints")
    await ingest(logs)
    expect(await count("nft_mints", `contract = '${HORNET}'`)).toBe(2_222)
    expect(await count("nft_collections")).toBe(1)
    const [row] = await sql`select * from indexer.nft_collections`
    const firstMint = logs.find(
      (l) =>
        l.address === HORNET && l.topics[0] === NFT_TOPICS.transfer && l.topics[1] === ZERO_TOPIC,
    )!
    expect(row).toMatchObject({
      contract: HORNET,
      standard: "erc721",
      seadrop: true,
      first_mint_block: firstMint.blockNumber,
    })
    // FakeChain gives block n the timestamp n. The SeaDrop config logs come earlier than the first mint.
    expect(new Date(row!.first_mint_ts).getTime()).toBe(Number(firstMint.blockNumber) * 1000)
    expect(await count("nft_seadrop_config", `block < ${firstMint.blockNumber}`)).toBeGreaterThan(0)
    expect(await count("nft_seadrop_mints")).toBeGreaterThan(0)
    expect(await count("events")).toBe(0)
  })

  it("erc-20 mints are ignored", async () => {
    const log: ChainLog = {
      address: "0x00000000000000000000000000000000000000e2",
      topics: [NFT_TOPICS.transfer, ZERO_TOPIC, pad(ALICE)],
      data: pad("0x64"),
      blockNumber: 58_000_000n,
      blockHash: `0x${"11".repeat(32)}`,
      transactionHash: `0x${"22".repeat(32)}`,
      logIndex: 0,
    }
    await ingest([log])
    expect(await count("nft_mints")).toBe(0)
    expect(await count("nft_collections")).toBe(0)
  })

  it("batch and single erc-1155 mints get one row per token id", async () => {
    const logs = loadNftFixture("erc1155-mints")
    await ingest(logs)
    const expected = logs.flatMap(decodeNftTransfers)
    expect(expected.length).toBeGreaterThan(0)
    expect(await count("nft_mints")).toBe(expected.length)
    expect(await sql`select distinct standard from indexer.nft_collections`).toEqual([
      { standard: "erc1155" },
    ])
  })

  it("burns are stored with their holder", async () => {
    const logs = loadNftFixture("wired-transfers")
    await ingest(logs)
    const burns = logs.flatMap((l) => decodeNftTransfers(l).filter((t) => t.kind === "burn"))
    expect(burns.length).toBeGreaterThan(0)
    expect(await count("nft_burns")).toBe(burns.length)
    expect(await count("nft_mints")).toBe(
      logs.flatMap((l) => decodeNftTransfers(l).filter((t) => t.kind === "mint")).length,
    )
  })

  it("sweep: 50 nft.sale events, distinct sub, entity is the collection contract", async () => {
    const roles = loadSeaportRoles()
    const logs = loadNftFixture("seaport-fills").filter((l) => l.transactionHash === roles.sweep)
    await ingest(logs)
    const rows = await sql<{ entity: string; sub: string; payload: Record<string, unknown> }[]>`
      select entity, sub, payload from indexer.events where type = 'nft.sale'`
    expect(rows).toHaveLength(50)
    expect(new Set(rows.map((r) => r.sub)).size).toBe(50)
    for (const r of rows) {
      expect(r.entity).toBe(SWEEP_COLLECTION)
      expect(r.sub).toBe(`sale:${r.payload.tokenId}`)
    }
    const expected = logs.flatMap(decodeOrderFulfilled)
    expect(rows[0]!.payload).toMatchObject({
      v: 1,
      chainId: 57073,
      type: "nft.sale",
      source: "chain",
      contract: SWEEP_COLLECTION,
      blockNumber: logs[0]!.blockNumber.toString(),
      blockTimestamp: Number(logs[0]!.blockNumber),
      itemName: null,
      imageUrl: null,
      rank: null,
      maxRank: null,
      floorWei: null,
    })
    expect(rows.map((r) => r.payload.priceWei).sort()).toEqual(
      expected.map((s) => s.priceWei.toString()).sort(),
    )
    expect(await count("nft_sales")).toBe(50)
  })

  it("a sale of a contract with no collection row creates the row, due for discovery", async () => {
    const roles = loadSeaportRoles()
    const logs = loadNftFixture("seaport-fills").filter((l) => l.transactionHash === roles.sweep)
    await ingest(logs)
    const rows = await sql`
      select contract, slug, first_mint_block, next_discovery_at <= now() as due
      from indexer.nft_collections`
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { contract: SWEEP_COLLECTION, slug: null, first_mint_block: null, due: true },
    ])
  })

  describe("a sale's floor", () => {
    const stat = (at: string, floor: string | null, contract = SWEEP_COLLECTION) => ({
      contract,
      at: new Date(at),
      floor_wei: floor,
      owners: 1,
      volume_24h_wei: "0",
      sales_24h: 0,
      total_supply: null,
    })
    const saleFloors = async () => {
      const roles = loadSeaportRoles()
      await ingest(loadNftFixture("seaport-fills").filter((l) => l.transactionHash === roles.sweep))
      const rows = await sql<{ payload: { floorWei: string | null } }[]>`
        select payload from indexer.events where type = 'nft.sale'`
      expect(rows).toHaveLength(50)
      return new Set(rows.map((r) => r.payload.floorWei))
    }

    it("is the collection's latest stats floor", async () => {
      await sql`insert into indexer.nft_stats ${sql([
        stat("2026-10-18T00:00:00Z", "111"),
        stat("2026-10-19T00:00:00Z", "222"),
        // Another collection's floor is not this one's.
        stat("2026-10-19T01:00:00Z", "999", NFT_A),
      ])}`
      expect(await saleFloors()).toEqual(new Set(["222"]))
    })

    it("is null when the newest stats row has no floor, whatever older rows had", async () => {
      await sql`insert into indexer.nft_stats ${sql([
        stat("2026-10-18T00:00:00Z", "111"),
        stat("2026-10-19T00:00:00Z", null),
      ])}`
      expect(await saleFloors()).toEqual(new Set([null]))
    })
  })

  describe("a sale's item", () => {
    const CALCULATED = new Date("2026-10-10T00:00:00Z")
    const DAY = 86_400_000

    it("carries the name, image and rank the listings cached, and null where the cache is not valid", async () => {
      const roles = loadSeaportRoles()
      const logs = loadNftFixture("seaport-fills").filter((l) => l.transactionHash === roles.sweep)
      const ids = [...new Set(logs.flatMap(decodeOrderFulfilled).map((x) => x.tokenId.toString()))]
      expect(ids.length).toBeGreaterThan(5)
      const [valid, rarityMoved, tooOld, nameOnly] = ids
      await sql`insert into indexer.nft_collections (contract, standard, rarity_calculated_at, max_rank)
        values (${SWEEP_COLLECTION}, 'erc721', ${CALCULATED}, 3333)`
      const recent = new Date(Date.now() - DAY)
      const rank = (id: string, calculated: Date, fetched: Date, r: number) => ({
        contract: SWEEP_COLLECTION,
        token_id: id,
        rank: r,
        max_rank: 3333,
        calculated_at: calculated,
        fetched_at: fetched,
      })
      await sql`insert into indexer.nft_ranks ${sql([
        rank(valid!, CALCULATED, recent, 12),
        rank(rarityMoved!, new Date("2026-10-01T00:00:00Z"), recent, 13),
        rank(tooOld!, CALCULATED, new Date(Date.now() - 8 * DAY), 14),
        // Another collection's row for the same id is not this one's.
        { ...rank(valid!, CALCULATED, recent, 99), contract: NFT_A },
      ])}`
      const seen = (id: string, name: string | null, image: string | null) => ({
        contract: SWEEP_COLLECTION,
        token_id: id,
        name,
        image_url: image,
        seen_at: recent,
      })
      await sql`insert into indexer.nft_items_seen ${sql([
        seen(valid!, "Valid #1", "https://img.example/1.png"),
        seen(rarityMoved!, "Moved #2", null),
        seen(nameOnly!, null, "https://img.example/4.png"),
      ])}`

      await ingest(logs)
      const rows = await sql<{ payload: Record<string, unknown> }[]>`
        select payload from indexer.events where type = 'nft.sale'`
      const byToken = new Map(rows.map((r) => [r.payload.tokenId as string, r.payload]))
      expect(byToken.get(valid!)).toMatchObject({
        itemName: "Valid #1",
        imageUrl: "https://img.example/1.png",
        rank: 12,
        maxRank: 3333,
      })
      expect(byToken.get(rarityMoved!)).toMatchObject({
        itemName: "Moved #2",
        imageUrl: null,
        rank: null,
        maxRank: null,
      })
      expect(byToken.get(tooOld!)).toMatchObject({ itemName: null, rank: null, maxRank: null })
      expect(byToken.get(nameOnly!)).toMatchObject({
        itemName: null,
        imageUrl: "https://img.example/4.png",
        rank: null,
      })
      expect(byToken.get(ids[4]!)).toMatchObject({ itemName: null, imageUrl: null, rank: null })
    })
  })

  it("an offer, a listing and a multi-order transaction each become sales; unsupported currencies none", async () => {
    const logs = loadNftFixture("seaport-fills")
    await ingest(logs)
    const expected = logs.flatMap(decodeOrderFulfilled)
    expect(await count("events", "type = 'nft.sale'")).toBe(expected.length)
    expect(await count("nft_sales")).toBe(expected.length)
  })

  it("an erc-1155 line of several units is priced per unit", async () => {
    await ingest([orderLog([nft1155(7n, 4n)], 4_000n)])
    const [e] = await sql<
      { payload: Record<string, unknown> }[]
    >`select payload from indexer.events`
    expect(e!.payload).toMatchObject({ tokenId: "7", priceWei: "1000", currency: "ETH" })
    const [s] = await sql`select qty, price_wei from indexer.nft_sales`
    expect(s).toMatchObject({ qty: "4", price_wei: "1000" })
  })

  it("two lines of one token in an order become one sale instead of colliding", async () => {
    await ingest([orderLog([nft1155(7n, 1n), nft1155(7n, 3n), nft1155(8n, 1n)], 6_000n)])
    const rows = await sql<{ sub: string; payload: Record<string, unknown> }[]>`
      select sub, payload from indexer.events order by sub`
    expect(rows.map((r) => [r.sub, r.payload.priceWei])).toEqual([
      ["sale:7", "1000"],
      ["sale:8", "2000"],
    ])
    expect(await count("nft_sales")).toBe(2)
  })

  it("two contracts selling the same token id in one order both get a sale", async () => {
    const other = "0x00000000000000000000000000000000000000b2" as Address
    const item = (token: Address): Item => ({ itemType: 2, token, identifier: 5n, amount: 1n })
    await ingest([orderLog([item(NFT_A), item(other)], 2_000n)])
    const rows = await sql<{ sub: string; entity: string; payload: Record<string, unknown> }[]>`
      select sub, entity, payload from indexer.events order by sub`
    expect(rows.map((r) => [r.sub, r.entity, r.payload.priceWei])).toEqual([
      ["sale:5", NFT_A, "1000"],
      [`sale:5:${other}`, other, "1000"],
    ])
    const sales = await sql`select contract, token_id from indexer.nft_sales order by contract`
    expect(sales.map((r) => [r.contract, r.token_id])).toEqual([
      [NFT_A, "5"],
      [other, "5"],
    ])
  })

  it("a matched offer and listing in one transaction is one sale with the buyer, seller and price of the offer", async () => {
    const logs = loadNftFixture("seaport-matched")
    await ingest(logs)
    const rows = await sql<{ entity: string; sub: string; payload: Record<string, unknown> }[]>`
      select entity, sub, payload from indexer.events`
    expect(rows).toHaveLength(1)
    const buyerOrder = logs.find(
      (l) => l.topics[1] === pad("0x5ca2ccb0a103821195b3d1712a7941a2ab89e58f"),
    )!
    expect(rows[0]).toMatchObject({
      entity: "0x47da169e2e85825d3ef9bc73151b39b7af7ef40c",
      sub: "sale:101",
      payload: {
        type: "nft.sale",
        tokenId: "101",
        buyer: "0x5ca2ccb0a103821195b3d1712a7941a2ab89e58f",
        seller: "0x505f8ec6e6d832d4ef620a963bc4ff501e7b78ae",
        priceWei: "100000000000000",
        currency: "WETH",
        txHash: buyerOrder.transactionHash,
        logIndex: buyerOrder.logIndex,
      },
    })
    expect(await count("nft_sales")).toBe(1)
    const [sale] = await sql`select buyer, seller, price_wei from indexer.nft_sales`
    expect(sale).toMatchObject({
      buyer: "0x5ca2ccb0a103821195b3d1712a7941a2ab89e58f",
      seller: "0x505f8ec6e6d832d4ef620a963bc4ff501e7b78ae",
      price_wei: "100000000000000",
    })
  })

  it("a second campaign for a collection keeps the first launch token", async () => {
    const [first] = loadChimeraCampaigns().filter((l) => l.blockNumber === 58_346_281n)
    const second = {
      ...first!,
      blockNumber: 58_346_300n,
      logIndex: 3,
      transactionHash: `0x${"33".repeat(32)}` as const,
      // Same collection, another token (the token is the first word of the data).
      data: `0x${"0".repeat(24)}${"ab".repeat(20)}${first!.data.slice(66)}` as `0x${string}`,
    }
    await ingest([first!, second])
    expect(await count("nft_launches")).toBe(1)
    const [row] =
      await sql`select launch_token from indexer.nft_collections where contract = ${WIRED}`
    const [launch] = await sql`select token from indexer.nft_launches`
    expect(row!.launch_token).toBe(launch!.token)
  })

  it("listing state for a sold item is deleted", async () => {
    const roles = loadSeaportRoles()
    const logs = loadNftFixture("seaport-fills").filter((l) => l.transactionHash === roles.sweep)
    const sold = logs.flatMap(decodeOrderFulfilled)
    const expires = new Date("2030-01-01T00:00:00Z")
    await sql`insert into indexer.nft_listing_state (contract, token_id, last_price_wei, order_hash, expires_at) values
      (${sold[0]!.contract}, ${sold[0]!.tokenId.toString()}, 5, ${"0x" + "01".repeat(32)}, ${expires}),
      (${sold[1]!.contract}, ${sold[1]!.tokenId.toString()}, 5, ${"0x" + "02".repeat(32)}, ${expires}),
      (${sold[1]!.contract}, 99999999, 5, ${"0x" + "03".repeat(32)}, ${expires})`
    await ingest(logs)
    const left = await sql<{ token_id: string }[]>`select token_id from indexer.nft_listing_state`
    expect(left.map((r) => r.token_id)).toEqual(["99999999"])
  })

  it("reorg deletes raw rows above the fork and keeps rows below", async () => {
    const logs = loadNftFixture("prtscn-mints")
    const first = firstBlock(logs)
    const chain = new FakeChain(lastBlock(logs) + 5n)
    for (const l of logs) chain.add(l)
    const idx = new Indexer({
      chain,
      store,
      logger: () => {},
      sources: [nftSource({ sql, chain, logger: () => {} })],
    })
    await idx.init()
    await store.writeBatch([], [], {
      cursor: { block: first - 1n, hash: chain.hashOf(first - 1n) },
      head: chain.head,
    })
    await idx.trigger()
    const total = await count("nft_mints")
    expect(total).toBe(4_440)

    // Fork in the middle of the recording: the block of a mint near the middle is the first one to change.
    const blocks = [...new Set(logs.map((l) => l.blockNumber))].sort((a, b) => (a < b ? -1 : 1))
    const forkFrom = blocks[Math.floor(blocks.length / 2)]!
    const kept = logs.filter((l) => l.blockNumber < forkFrom).length
    chain.reorg(forkFrom)
    await idx.trigger()

    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(total)
    expect(await count("nft_mints", `block >= ${forkFrom}`)).toBe(0)
    expect(await count("nft_mints")).toBe(kept)
    const [row] =
      await sql`select first_mint_block from indexer.nft_collections where contract = ${PRTSCN}`
    expect(row!.first_mint_block).toBe(first)
  })

  it("reorg of the first mint resets first_mint and of a campaign clears the launchpad", async () => {
    const campaign = loadChimeraCampaigns().find((l) => l.blockNumber === 58_346_281n)!
    // A short stretch of WIRED, so the block hashes of the whole recording stay among the 128 stored.
    const wired = loadNftFixture("wired-transfers").filter((l) => l.blockNumber < 58_434_800n)
    const logs = [campaign, ...wired]
    const first = firstBlock(logs)
    const chain = new FakeChain(lastBlock(logs) + 5n)
    for (const l of logs) chain.add(l)
    const idx = new Indexer({
      chain,
      store,
      logger: () => {},
      sources: [nftSource({ sql, chain, logger: () => {} })],
    })
    await idx.init()
    await store.writeBatch([], [], {
      cursor: { block: first - 1n, hash: chain.hashOf(first - 1n) },
      head: chain.head,
    })
    await idx.trigger()
    expect(await count("nft_launches")).toBe(1)
    const [before] = await sql`select * from indexer.nft_collections where contract = ${WIRED}`
    expect(before!.first_mint_block).not.toBeNull()

    chain.reorg(first)
    await idx.trigger()

    expect(await count("nft_launches")).toBe(0)
    expect(await count("nft_mints")).toBe(0)
    const [after] = await sql`select * from indexer.nft_collections where contract = ${WIRED}`
    expect(after).toMatchObject({
      launchpad: null,
      launch_token: null,
      creator_address: null,
      first_mint_block: null,
      first_mint_ts: null,
    })
    expect(before!.creator_address).not.toBeNull()
    expect(await count("events", "type = 'nft.launch'")).toBe(0)
  })

  it("reorg removes the rows of every raw table above the fork", async () => {
    const roles = loadSeaportRoles()
    const burst = loadNftFixture("burst-mints")
    // The sweep, moved next to the burst so the stored block hashes cover both.
    const sweep = loadNftFixture("seaport-fills")
      .filter((l) => l.transactionHash === roles.sweep)
      .map((l) => ({ ...l, blockNumber: lastBlock(burst) + 10n }))
    // A recorded burn, moved next to the burst too.
    const burn = loadNftFixture("wired-transfers")
      .filter((l) => decodeNftTransfers(l).some((x) => x.kind === "burn"))
      .slice(0, 1)
      .map((l) => ({ ...l, blockNumber: lastBlock(burst) + 5n }))
    const logs = [...burst, ...burn, ...sweep]
    const first = firstBlock(logs)
    const chain = new FakeChain(lastBlock(logs) + 5n)
    for (const l of logs) chain.add(l)
    const idx = new Indexer({
      chain,
      store,
      logger: () => {},
      sources: [nftSource({ sql, chain, logger: () => {} })],
    })
    await idx.init()
    await store.writeBatch([], [], {
      cursor: { block: first - 1n, hash: chain.hashOf(first - 1n) },
      head: chain.head,
    })
    await idx.trigger()
    for (const table of [
      "nft_mints",
      "nft_burns",
      "nft_seadrop_mints",
      "nft_seadrop_config",
      "nft_sales",
    ])
      expect(await count(table), table).toBeGreaterThan(0)

    chain.reorg(first)
    await idx.trigger()

    for (const table of [
      "nft_mints",
      "nft_burns",
      "nft_seadrop_mints",
      "nft_seadrop_config",
      "nft_sales",
      "events",
    ])
      expect(await count(table), table).toBe(0)
  })

  it("re-scanning a range adds no rows and does not duplicate events", async () => {
    const roles = loadSeaportRoles()
    const logs = loadNftFixture("seaport-fills").filter((l) => l.transactionHash === roles.sweep)
    const { idx } = await ingest(logs)
    await idx.backfill(firstBlock(logs), lastBlock(logs))
    expect(await count("nft_sales")).toBe(50)
    expect(await count("events")).toBe(50)
  })

  it("reads each block timestamp at most once per batch", async () => {
    const roles = loadSeaportRoles()
    const logs = loadNftFixture("seaport-fills").filter((l) => l.transactionHash === roles.sweep)
    const chain = new FakeChain(lastBlock(logs) + 5n)
    for (const l of logs) chain.add(l)
    const reads: bigint[] = []
    const getBlock = chain.getBlock.bind(chain)
    chain.getBlock = async (n) => {
      reads.push(n)
      return getBlock(n)
    }
    const idx = new Indexer({
      chain,
      store,
      logger: () => {},
      sources: [nftSource({ sql, chain, logger: () => {} })],
    })
    await idx.init()
    await idx.backfill(firstBlock(logs), chain.head)
    // 50 sales in one block: one read, not 50.
    expect(reads.filter((n) => n === logs[0]!.blockNumber)).toHaveLength(1)
  })

  it("a backfill of some sources reads only their filters", async () => {
    const logs = [...loadChimeraCampaigns(), orderLog([nft1155(1n, 1n)], 10n ** 18n)]
    const chain = new FakeChain(lastBlock(logs) + 5n)
    chain.maxSpan = 10n ** 9n
    for (const l of logs) chain.add(l)
    const asked: LogFilter[] = []
    const getLogs = chain.getLogs.bind(chain)
    chain.getLogs = (from, to, filter) => {
      asked.push(filter)
      return getLogs(from, to, filter)
    }
    const sources = [
      inkypumpSource({ sql, chain, logger: () => {} }),
      nftSource({ sql, chain, logger: () => {} }),
    ]
    const idx = new Indexer({ chain, store, logger: () => {}, sources })
    await idx.init()
    const from = firstBlock(logs)

    await idx.backfill(from, chain.head, ["nft-launches"])
    expect(asked.map((f) => f.address)).toEqual([CHIMERA_FACTORY])
    expect(await count("nft_launches")).toBe(5)
    expect(await count("nft_sales")).toBe(0)

    asked.length = 0
    await idx.backfill(from, chain.head, ["nft-sales"])
    expect(asked.map((f) => f.address)).toEqual([[SEAPORT_1_6, SEAPORT_1_5]])
    expect(await count("nft_sales")).toBe(1)

    asked.length = 0
    await idx.backfill(from, chain.head, ["nft-mints"])
    // Mints, burns and ERC-1155 mints and burns are 3 requests, SeaDrop the 4th.
    expect(asked).toHaveLength(4)
    expect(asked.at(-1)?.address).toBe(SEADROP_V1)

    // A source with none of its filters picked is left out entirely.
    asked.length = 0
    await idx.backfill(from, chain.head, ["inkypump"])
    expect(asked).toHaveLength(1)
    expect(sources[1]!.filters(["inkypump"])).toEqual(Array(7).fill(null))
    expect(sources[0]!.filters(["nft-sales"])).toEqual([null])

    // No list: every filter of every source, as the live loop reads them.
    asked.length = 0
    await idx.backfill(from, chain.head)
    expect(asked).toHaveLength(5)
    expect(await store.getCursor()).toBeNull()
  })
})

describe("collections from sales", () => {
  const sale = (contract: string, logIndex: number) => ({
    tx_hash: `0x${"22".repeat(32)}`,
    log_index: logIndex,
    token_id: "1",
    contract,
    qty: "1",
    price_wei: "1000",
    currency: "ETH",
    buyer: BOB,
    seller: ALICE,
    order_hash: `0x${"ab".repeat(32)}`,
    block: "58000000",
  })

  it("creates a row due for discovery for each contract with sales and no row, and counts them", async () => {
    await sql`insert into indexer.nft_collections ${sql({ contract: HORNET, slug: "hornet", next_discovery_at: null })}`
    await sql`insert into indexer.nft_sales ${sql([sale(PRTSCN, 0), sale(PRTSCN, 1), sale(SWEEP_COLLECTION, 2), sale(HORNET, 3)])}`
    expect(await createCollectionsFromSales(sql)).toBe(2)
    const rows = await sql`
      select contract, slug, next_discovery_at <= now() as due
      from indexer.nft_collections order by contract`
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { contract: PRTSCN, slug: null, due: true },
      { contract: HORNET, slug: "hornet", due: null },
      { contract: SWEEP_COLLECTION, slug: null, due: true },
    ])
    expect(await createCollectionsFromSales(sql)).toBe(0)
  })
})
