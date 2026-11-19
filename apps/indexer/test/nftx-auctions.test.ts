import { connect, type Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  type AuctionCheckpoint,
  CCA_TOPICS,
  type CcaLog,
  type ChainLog,
  ccaConfigParameter,
  decodeCcaLog,
  NFTX_LOCKER,
  NFTX_TOPICS,
} from "@ink-indexer/sdk"
import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  type Hash,
  type Hex,
  pad,
} from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { loadNftxAuctionFixture } from "../../../packages/sdk/test/fixtures"
import { applyAuctionLink, parseAuctionLink } from "../src/auction-cli"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import {
  duePhases,
  type KeptAuction,
  keepAuction,
  type StoredAuction,
} from "../src/sources/nftx/auctions"
import { nftxSource } from "../src/sources/nftx/index"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import { synthLog, ZERO } from "./nftx-harness"

const fx = loadNftxAuctionFixture()
const made = decodeCcaLog(fx.created) as Extract<CcaLog, { kind: "auctionCreated" }>
const AUCTION = fx.auction
const TOKEN = made.token
const COLLECTION = "0x00000000000000000000000000000000000c0111" as Address
const OWNER = "0x00000000000000000000000000000000000a0001" as Address
const STRANGER = "0x00000000000000000000000000000000000a0002" as Address
const CREATED = 60_337_822n
const START = 60_385_189n
const END = 60_471_589n
const FLOOR_WEI = "99999999999999"
/** A floor-token supply that INKTRONS' 1100 tokens are half of or more. */
const HALF = 2000n * 10n ** 18n
const E18 = 10n ** 18n

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

const bidLogs = fx.logs.filter((l) => l.topics[0] === CCA_TOPICS.BidSubmitted)
const bidsUpTo = (block: bigint, logIndex = Number.MAX_SAFE_INTEGER) =>
  new Set(
    bidLogs
      .filter((l) => l.blockNumber < block || (l.blockNumber === block && l.logIndex <= logIndex))
      .map((l) => (decodeCcaLog(l) as Extract<CcaLog, { kind: "bid" }>).owner),
  ).size

type Opts = {
  /** The collection of the floor token: stored before the run; the creator is the auction's sender unless named. */
  collection?: false | { creator?: Address; slug?: string }
  /** The floor token's total supply at creation. */
  supply?: bigint
  head?: bigint
  /** What `owner()` of the collection answers. */
  owner?: Address | null
  launchpad?: Address | null
  /** The checkpoint multicall; the fixture's at the blocks it recorded. */
  checkpoint?: (block: bigint) => AuctionCheckpoint | null
  /** Replaces the auction's logs. */
  logs?: (logs: ChainLog[]) => ChainLog[]
}

const checkpointOfFixture = (block: bigint): AuctionCheckpoint | null =>
  fx.checkpoints.find((c) => c.block === block)?.read ?? {
    clearingPriceQ96: made.config.floorPrice,
    currencyRaised: 7n,
    totalCleared: 0n,
    graduated: true,
  }

/** A chain over the INKTRONS auction's recorded logs and an indexer running the NFTX source. */
async function setup(opts: Opts = {}) {
  const warnings: string[] = []
  const logger: Logger = (level, msg) => {
    if (level === "warn") warnings.push(msg)
  }
  const chain = new FakeChain(opts.head ?? 60_472_142n)
  chain.maxSpan = 10_000_000n
  const all = [fx.created, ...(opts.logs ? opts.logs(fx.logs) : fx.logs)]
  for (const l of all) chain.add(l)
  const tx = fx.created.transactionHash
  chain.senders.set(CREATED, {
    hash: chain.hashOf(CREATED),
    senders: new Map([[tx, fx.from]]),
    targets: new Map([[tx, fx.to]]),
    timestamp: fx.blockTimes[String(CREATED)],
  })
  for (const [block, time] of Object.entries(fx.blockTimes))
    chain.blockTimes.set(BigInt(block), BigInt(time))
  chain.supplies.set(TOKEN, opts.supply ?? fx.tokenSupplyAtCreation)
  chain.owners.set(COLLECTION, opts.owner ?? null)
  chain.auctionCheckpoints.set(AUCTION, opts.checkpoint ?? checkpointOfFixture)
  if (opts.collection !== false) await seedCollection(opts.collection)
  const source = nftxSource({
    sql,
    chain,
    logger,
    fetch: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
    launchpad: opts.launchpad ?? null,
  })
  const idx = new Indexer({ chain, store, logger, sources: [source] })
  const first = CREATED
  const backfill = async (from = first, to = chain.head) => {
    await idx.init()
    await idx.backfill(from, to)
  }
  const live = async () => {
    await idx.init()
    await store.writeBatch([], [], {
      cursor: { block: first - 1n, hash: chain.hashOf(first - 1n) },
      head: chain.head,
    })
    await idx.trigger()
  }
  return { chain, idx, source, warnings, backfill, live, all }
}

async function seedCollection(c: { creator?: Address; slug?: string } = {}) {
  await sql`
    insert into indexer.nftx_collections ${sql({
      collection: COLLECTION,
      floor_token: TOKEN,
      creator: c.creator ?? fx.from,
      created_block: "59000000",
    })}`
  await sql`
    insert into indexer.nft_collections ${sql({
      contract: COLLECTION,
      standard: "erc721",
      launchpad: "nftx",
      launch_token: TOKEN,
      nftx_slug: c.slug ?? null,
    })}`
}

type Row = { payload: Record<string, unknown>; block: string; tx_hash: string; log_index: number }
const auctionEvents = async () =>
  (
    await sql<(Omit<Row, "block"> & { block: bigint })[]>`
      select payload, block, tx_hash, log_index from indexer.events where type = 'nft.auction'
      order by id`
  ).map((r) => ({ ...r, block: String(r.block) }))
const phase = async (name: string) =>
  (await auctionEvents()).filter((e) => e.payload.phase === name)
const auctionRow = async () =>
  (
    await sql<Record<string, unknown>[]>`
      select * from indexer.nftx_auctions where auction = ${AUCTION}`
  )[0]!
const id = (p: string, block: bigint | number, logIndex?: number) =>
  `nftx:auction:${AUCTION}:${p}:${block}${logIndex === undefined ? "" : `:${logIndex}`}`

/** A `ClearingPriceUpdated` of the auction at a position, with a payload block and price. */
function clearingPrice(block: bigint, logIndex: number, payloadBlock: bigint): ChainLog {
  const like = fx.logs.find((l) => l.topics[0] === CCA_TOPICS.ClearingPriceUpdated)!
  return {
    ...like,
    blockNumber: block,
    logIndex,
    transactionHash: pad(`0x${logIndex.toString(16)}${block.toString(16)}`, { size: 32 }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [payloadBlock, made.config.floorPrice],
    ),
  }
}

const stored = (over: Partial<StoredAuction> = {}): StoredAuction => ({
  auction: AUCTION,
  token: TOKEN,
  currency: made.config.currency,
  startBlock: made.config.startBlock,
  endBlock: made.config.endBlock,
  claimBlock: made.config.claimBlock,
  floorPriceQ96: made.config.floorPrice,
  requiredRaise: made.config.requiredCurrencyRaised,
  amount: made.amount,
  totalSupply: null,
  sender: fx.from,
  txTo: fx.to,
  createdBlock: CREATED,
  createdLogIndex: fx.created.logIndex,
  collection: null,
  kept: false,
  keptBlock: null,
  manual: false,
  tokensReceivedBlock: null,
  createdEmittedBlock: null,
  liveBlock: null,
  endedBlock: null,
  ...over,
})
const context = (over: Partial<Parameters<typeof keepAuction>[1]> = {}) => ({
  collection: { collection: COLLECTION, floorToken: TOKEN, creator: fx.from },
  owner: null,
  floorSupply: HALF,
  launchpad: null,
  alreadyKept: false,
  ...over,
})

describe("keepAuction", () => {
  it("keeps an auction of the floor token sent by the collection's creator that sells half the supply or more", () => {
    expect(keepAuction(stored(), context())).toBe(true)
    expect(keepAuction(stored(), context({ floorSupply: 2200n * E18 }))).toBe(true)
  })

  it("INKTRONS is not kept: it sells 1100 of 2222 tokens", () => {
    expect(keepAuction(stored(), context({ floorSupply: fx.tokenSupplyAtCreation }))).toBe(false)
    expect(keepAuction(stored(), context({ floorSupply: null }))).toBe(false)
  })

  it("an auction is not kept when its token is not a floor token, its sender is not the creator, owner or launchpad, its currency is not ETH, or it is the second one", () => {
    expect(keepAuction(stored({ token: STRANGER }), context())).toBe(false)
    expect(keepAuction(stored(), context({ collection: null }))).toBe(false)
    expect(keepAuction(stored({ sender: STRANGER }), context())).toBe(false)
    expect(keepAuction(stored({ currency: STRANGER }), context())).toBe(false)
    expect(keepAuction(stored(), context({ alreadyKept: true }))).toBe(false)
  })

  it("the collection's owner() and the launchpad also count as the sender", () => {
    expect(keepAuction(stored({ sender: OWNER }), context({ owner: OWNER }))).toBe(true)
    expect(keepAuction(stored({ sender: OWNER }), context({ owner: STRANGER }))).toBe(false)
    expect(keepAuction(stored({ sender: STRANGER }), context({ launchpad: STRANGER }))).toBe(true)
    // The launchpad may be the transaction's target rather than its sender.
    expect(
      keepAuction(stored({ sender: STRANGER, txTo: OWNER }), context({ launchpad: OWNER })),
    ).toBe(true)
    expect(keepAuction(stored({ sender: STRANGER }), context({ launchpad: OWNER }))).toBe(false)
  })
})

describe("duePhases", () => {
  const kept = (over: Partial<KeptAuction> = {}): KeptAuction => ({
    ...stored({ tokensReceivedBlock: CREATED }),
    kept: true,
    collection: COLLECTION,
    ...over,
  })

  it("live is due at the start block once the tokens have arrived, and ended at the end block", () => {
    expect(duePhases(kept(), START - 1n)).toEqual({ live: null, ended: null })
    expect(duePhases(kept(), START)).toEqual({ live: START, ended: null })
    expect(duePhases(kept(), END)).toEqual({ live: START, ended: END })
  })

  it("live waits for the tokens and takes the later of the start block and their arrival", () => {
    expect(duePhases(kept({ tokensReceivedBlock: null }), END)).toEqual({ live: null, ended: END })
    expect(duePhases(kept({ tokensReceivedBlock: 60_390_000n }), 60_389_999n).live).toBeNull()
    expect(duePhases(kept({ tokensReceivedBlock: 60_390_000n }), 60_390_000n).live).toBe(
      60_390_000n,
    )
  })

  it("a phase already emitted is not due again", () => {
    expect(duePhases(kept({ liveBlock: START, endedBlock: END }), END + 100n)).toEqual({
      live: null,
      ended: null,
    })
  })
})

describe("storing auctions", () => {
  it("INKTRONS is stored and not kept: it sells 1100 of 2222 tokens", async () => {
    const t = await setup()
    await t.backfill()
    expect(await auctionRow()).toMatchObject({
      auction: AUCTION,
      token: TOKEN,
      currency: ZERO,
      start_block: START,
      end_block: END,
      claim_block: 60_471_889n,
      floor_price_q96: "7922816251426433759354300",
      required_raise: "0",
      amount: (1100n * E18).toString(),
      total_supply: (1100n * E18).toString(),
      sender: fx.from,
      tx_to: fx.to,
      created_block: CREATED,
      created_log_index: 48,
      collection: null,
      kept: false,
      manual: false,
      tokens_received_block: CREATED,
      created_emitted_block: null,
      live_block: null,
      ended_block: null,
    })
    expect(await auctionEvents()).toEqual([])
    const bids = await sql<{ owner: string }[]>`
      select owner from indexer.nftx_auction_bids where kind = 'bid'`
    expect(bids).toHaveLength(12)
    expect(new Set(bids.map((b) => b.owner)).size).toBe(11)
  })

  it("stores an auction of a token that is not a floor token, with its bids, and emits nothing", async () => {
    const t = await setup({ collection: false })
    await t.backfill()
    expect((await auctionRow()).kept).toBe(false)
    expect(await auctionEvents()).toEqual([])
    expect(await sql`select 1 from indexer.nftx_auction_bids`).toHaveLength(12)
  })

  it("an auction sent by a stranger is stored, not kept", async () => {
    const t = await setup({ supply: HALF, collection: { creator: STRANGER } })
    await t.backfill()
    expect((await auctionRow()).kept).toBe(false)
    expect(await auctionEvents()).toEqual([])
    // The collection's owner() was asked for at the creating block.
    expect(t.chain.ownerReads).toEqual([{ contracts: [COLLECTION], block: CREATED }])
  })

  it("the collection's owner keeps an auction its creator did not send (synthetic)", async () => {
    const t = await setup({ supply: HALF, collection: { creator: STRANGER }, owner: fx.from })
    await t.backfill()
    expect((await auctionRow()).kept).toBe(true)
  })

  it("the launchpad's transaction keeps an auction (synthetic)", async () => {
    const t = await setup({
      supply: HALF,
      collection: { creator: STRANGER },
      launchpad: fx.to as Address,
    })
    await t.backfill()
    expect((await auctionRow()).kept).toBe(true)
  })

  it("an ERC-20 currency keeps no auction and is stored as its address (synthetic)", async () => {
    const [amount, configData] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes" }],
      fx.created.data,
    )
    const [config] = decodeAbiParameters([ccaConfigParameter], configData)
    const odd = {
      ...fx.created,
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "bytes" }],
        [amount, encodeAbiParameters([ccaConfigParameter], [{ ...config, currency: STRANGER }])],
      ),
    } as ChainLog
    const t = await setup({ supply: HALF })
    t.chain.logs = t.chain.logs.map((l) => (l === fx.created ? odd : l))
    await t.backfill()
    const row = await auctionRow()
    expect(row.currency).toBe(STRANGER)
    expect(row.kept).toBe(false)
  })

  it("an auction logged by an address other than the factory is ignored (synthetic)", async () => {
    const t = await setup({ supply: HALF })
    await t.idx.init()
    const out = await t.source.process([[], [{ ...fx.created, address: STRANGER }], []], {
      toBlock: CREATED,
      live: false,
    })
    expect(out.events).toEqual([])
    expect(await sql`select 1 from indexer.nftx_auctions`).toHaveLength(0)
  })

  it("a BidSubmitted from an address the factory did not create is ignored (synthetic)", async () => {
    const t = await setup({ supply: HALF })
    const stray = { ...bidLogs[0]!, address: STRANGER, logIndex: 90 }
    t.chain.add(stray)
    await t.backfill()
    const rows = await sql<{ auction: string }[]>`select auction from indexer.nftx_auction_bids`
    expect(rows.map((r) => r.auction)).not.toContain(STRANGER)
    expect(rows).toHaveLength(12)
    expect((await phase("ended"))[0]!.payload.bidders).toBe(11)
  })
})

/** A CollectionCreated at `block` whose floor token is INKTRONS' token, created by the auction's sender. */
function collectionCreated(t: { chain: FakeChain }, block: bigint) {
  const like = {
    address: NFTX_LOCKER,
    topics: [] as Hex[],
    data: "0x" as Hex,
    blockNumber: block,
    blockHash: pad("0x01", { size: 32 }),
    transactionHash: pad("0x77", { size: 32 }),
    logIndex: 0,
  } as ChainLog
  const log = synthLog(
    like,
    "CollectionCreated",
    {
      _collection: COLLECTION,
      _collectionToken: TOKEN,
      _name: "Thinkers",
      _symbol: "THINK",
      _creator: fx.from,
    },
    { address: NFTX_LOCKER, logIndex: 0 },
  )
  t.chain.add(log)
  t.chain.senders.set(block, {
    hash: t.chain.hashOf(block),
    senders: new Map([[log.transactionHash, fx.from]]),
    targets: new Map([[log.transactionHash, NFTX_LOCKER]]),
  })
}

describe("keeping a stored auction later", () => {
  it("a later CollectionCreated keeps a stored one (synthetic supply)", async () => {
    const t = await setup({ collection: false, supply: HALF })
    await t.backfill(CREATED, 60_400_000n)
    expect((await auctionRow()).kept).toBe(false)
    expect(await auctionEvents()).toEqual([])
    collectionCreated(t, 60_300_000n)
    await t.idx.backfill(60_299_000n, 60_337_821n)
    const row = await auctionRow()
    expect(row).toMatchObject({ kept: true, collection: COLLECTION, kept_block: CREATED })
    // The span that kept it ends at 60337821: the keep is announced at the span's last block.
    const events = await auctionEvents()
    expect(events.map((e) => e.tx_hash)).toEqual([id("created", 60_337_821n)])
    expect(events[0]!.payload).toMatchObject({
      phase: "created",
      contract: COLLECTION,
      blockNumber: "60337821",
      clearingPriceWei: FLOOR_WEI,
      bidders: bidsUpTo(60_337_821n),
    })
  })

  it("an auction created in the same span as its collection is kept at its AuctionCreated log (synthetic supply)", async () => {
    const t = await setup({ collection: false, supply: HALF })
    collectionCreated(t, 60_300_000n)
    await t.idx.init()
    await t.idx.backfill(60_299_000n, 60_340_000n)
    expect((await phase("created")).map((e) => e.tx_hash)).toEqual([id("created", CREATED, 48)])
  })

  it("a second auction of the same floor token is not kept (synthetic)", async () => {
    const t = await setup({ supply: HALF })
    const hash = pad("0x5151", { size: 32 }) as Hash
    const second = {
      ...fx.created,
      topics: [
        fx.created.topics[0]!,
        pad("0x00000000000000000000000000000000000000b2", { size: 32 }),
        fx.created.topics[2]!,
      ],
      logIndex: 60,
      transactionHash: hash,
    } as ChainLog
    t.chain.add(second)
    const prior = t.chain.senders.get(CREATED)!
    prior.senders.set(hash, fx.from)
    prior.targets?.set(hash, fx.to)
    await t.backfill()
    const rows = await sql<{ auction: string; kept: boolean }[]>`
      select auction, kept from indexer.nftx_auctions order by created_log_index`
    expect(rows.map((r) => r.kept)).toEqual([true, false])
    expect((await phase("created")).map((e) => e.payload.auction)).toEqual([AUCTION])
  })

  it("a source already loaded and processing batches emits created at the next batch's toBlock after applyAuctionLink runs from another connection, with no reload", async () => {
    const t = await setup({ head: 60_400_000n })
    await t.live()
    expect(await auctionEvents()).toEqual([])
    const other = connect(inject("databaseUrl"))
    try {
      await applyAuctionLink(other, { auction: AUCTION, contract: COLLECTION })
    } finally {
      await other.end()
    }
    t.chain.head = 60_400_010n
    await t.idx.trigger()
    const events = await auctionEvents()
    // Created at the batch's last block, then the phase that block has already passed. The price
    // log the first batch read before the link is not announced.
    expect(events.map((e) => e.tx_hash)).toEqual([id("live", START), id("created", 60_400_010n)])
    expect(await auctionRow()).toMatchObject({ kept: true, manual: true, kept_block: null })
  })
})

describe("phases", () => {
  it("created has clearingPriceWei equal to minBidWei 99999999999999, raisedWei 0, supply 1100 and requiredRaiseWei 0", async () => {
    const t = await setup({ supply: HALF })
    await t.backfill()
    const [created, ...rest] = await phase("created")
    expect(rest).toEqual([])
    expect(created).toMatchObject({
      tx_hash: id("created", CREATED, 48),
      log_index: 48,
      block: String(CREATED),
    })
    expect(created!.payload).toEqual({
      v: 2,
      chainId: 57073,
      type: "nft.auction",
      contract: COLLECTION,
      source: "chain",
      txHash: id("created", CREATED, 48),
      logIndex: 48,
      blockNumber: String(CREATED),
      blockTimestamp: 1793836233,
      phase: "created",
      auction: AUCTION,
      token: TOKEN,
      currency: "ETH",
      startBlock: "60385189",
      endBlock: "60471589",
      claimBlock: "60471889",
      startsAt: 1793883600,
      endsAt: 1793970000,
      claimsAt: 1793970300,
      supply: "1100",
      minBidWei: FLOOR_WEI,
      clearingPriceWei: FLOOR_WEI,
      raisedWei: "0",
      requiredRaiseWei: "0",
      bidders: 0,
      graduated: null,
      cleared: null,
      nftxSlug: null,
    })
  })

  it("carries the collection's NFTX slug", async () => {
    const t = await setup({ supply: HALF, collection: { slug: "thinkers" } })
    await t.backfill()
    for (const e of await auctionEvents()) expect(e.payload.nftxSlug).toBe("thinkers")
  })

  it("live is emitted at 60385189, after TokensReceived, and reads the checkpoint there", async () => {
    const t = await setup({ supply: HALF })
    await t.backfill()
    const [live, ...rest] = await phase("live")
    expect(rest).toEqual([])
    expect(live).toMatchObject({ tx_hash: id("live", START), log_index: 0, block: String(START) })
    expect(live!.payload).toMatchObject({
      blockNumber: String(START),
      blockTimestamp: 1793883600,
      startsAt: 1793883600,
      endsAt: 1793970000,
      clearingPriceWei: FLOOR_WEI,
      raisedWei: "0",
      bidders: 0,
      graduated: null,
      cleared: null,
    })
    expect(t.chain.auctionCheckpointReads).toContainEqual({ auction: AUCTION, block: START })
    expect((await auctionRow()).live_block).toBe(START)
  })

  it("live waits for TokensReceived (synthetic)", async () => {
    const t = await setup({
      supply: HALF,
      logs: (logs) =>
        logs.map((l) =>
          l.topics[0] === CCA_TOPICS.TokensReceived
            ? { ...l, blockNumber: 60_390_000n, logIndex: 3 }
            : l,
        ),
    })
    await t.backfill(CREATED, 60_385_300n)
    expect((await auctionEvents()).map((e) => e.payload.phase)).not.toContain("live")
    expect((await auctionRow()).live_block).toBeNull()
    await t.idx.backfill(60_385_301n, t.chain.head)
    expect((await phase("live")).map((e) => e.tx_hash)).toEqual([id("live", 60_390_000n)])
  })

  it("the constructor's ClearingPriceUpdated gives no price phase", async () => {
    const t = await setup({ supply: HALF })
    await t.backfill()
    const prices = await phase("price")
    expect(prices.map((e) => e.block)).not.toContain(String(CREATED))
  })

  it("the one at 60385228 gives price with bidders counted so far", async () => {
    const t = await setup({ supply: HALF })
    await t.backfill()
    const [price, ...rest] = await phase("price")
    expect(rest).toEqual([])
    expect(price).toMatchObject({
      tx_hash: id("price", 60_385_228n, 31),
      log_index: 31,
      block: "60385228",
    })
    expect(price!.payload).toMatchObject({
      clearingPriceWei: FLOOR_WEI,
      // The checkpoint multicall at the log's block, not the log's own price alone.
      raisedWei: "0",
      // The first bid comes after the price log in the same block.
      bidders: 0,
      blockTimestamp: 1793883639,
      graduated: null,
      cleared: null,
    })
    expect(t.chain.auctionCheckpointReads).toContainEqual({ auction: AUCTION, block: 60_385_228n })
  })

  it("price counts the bids before its log and takes raisedWei from the checkpoint at its block (synthetic)", async () => {
    const at = { block: 60_438_300n, index: 7 }
    const t = await setup({
      supply: HALF,
      logs: (logs) => [...logs, clearingPrice(at.block, at.index, at.block)],
      checkpoint: (b) =>
        b === at.block
          ? {
              clearingPriceQ96: made.config.floorPrice,
              currencyRaised: 4_000_000_000_000_000n,
              totalCleared: 0n,
              graduated: true,
            }
          : checkpointOfFixture(b),
    })
    await t.backfill()
    const found = (await phase("price")).find((e) => e.block === String(at.block))!
    expect(found.payload.raisedWei).toBe("4000000000000000")
    const expected = bidsUpTo(at.block, at.index)
    expect(expected).toBeGreaterThan(3)
    expect(expected).toBeLessThan(11)
    expect(found.payload.bidders).toBe(expected)
  })

  it("a ClearingPriceUpdated dated after endBlock gives no price phase (synthetic)", async () => {
    const t = await setup({
      supply: HALF,
      logs: (logs) => [
        ...logs,
        clearingPrice(60_472_000n, 5, END + 1n),
        clearingPrice(60_385_300n, 5, START - 1n),
      ],
    })
    await t.backfill()
    const blocks = (await phase("price")).map((e) => e.block)
    expect(blocks).toEqual(["60385228"])
  })

  it("a ClearingPriceUpdated dated at the first and the last block of the auction gives price (synthetic)", async () => {
    const t = await setup({
      supply: HALF,
      logs: (logs) => [
        ...logs,
        clearingPrice(60_385_190n, 5, START),
        clearingPrice(60_471_590n, 5, END),
      ],
    })
    await t.backfill()
    expect((await phase("price")).map((e) => e.block)).toEqual(["60385190", "60385228", "60471590"])
  })

  it("ended reads raisedWei 10171999999999999, cleared 101, graduated true, bidders 11 from the checkpoint multicall at 60471589", async () => {
    const t = await setup({ supply: HALF })
    await t.backfill()
    const [ended, ...rest] = await phase("ended")
    expect(rest).toEqual([])
    expect(ended).toMatchObject({ tx_hash: id("ended", END), log_index: 0, block: String(END) })
    expect(ended!.payload).toMatchObject({
      blockNumber: String(END),
      blockTimestamp: 1793970000,
      raisedWei: "10171999999999999",
      cleared: "101",
      graduated: true,
      bidders: 11,
      clearingPriceWei: FLOOR_WEI,
      minBidWei: FLOOR_WEI,
      supply: "1100",
      requiredRaiseWei: "0",
      endsAt: 1793970000,
      claimsAt: 1793970300,
    })
    expect(t.chain.auctionCheckpointReads).toContainEqual({ auction: AUCTION, block: END })
    expect((await auctionRow()).ended_block).toBe(END)
  })

  it("the plain reads at 60471589 differ", async () => {
    const t = await setup({ supply: HALF })
    await t.backfill()
    const ended = (await phase("ended"))[0]!.payload
    expect(ended.raisedWei).not.toBe(fx.plainAtEnd.currencyRaised.toString())
    expect(fx.plainAtEnd.currencyRaised.toString()).toBe("5718586445766492")
    expect(ended.cleared).not.toBe("57")
  })

  it("a failed auction gives ended with graduated false (synthetic)", async () => {
    const t = await setup({
      supply: HALF,
      checkpoint: (b) =>
        b === END
          ? {
              clearingPriceQ96: made.config.floorPrice,
              currencyRaised: 3_000_000_000_000_000n,
              totalCleared: 30n * E18,
              graduated: false,
            }
          : checkpointOfFixture(b),
    })
    await t.backfill()
    expect((await phase("ended"))[0]!.payload).toMatchObject({
      graduated: false,
      raisedWei: "3000000000000000",
      // Nothing is sold when an auction does not graduate: the bids are refunded.
      cleared: "0",
    })
  })

  it("an auction that never received tokens ends with graduated false, raised 0 and cleared 0 (synthetic)", async () => {
    const t = await setup({
      supply: HALF,
      // Nothing happens in an auction that never opened except its constructor's price log.
      logs: (logs) =>
        logs.filter(
          (l) => l.blockNumber === CREATED && l.topics[0] === CCA_TOPICS.ClearingPriceUpdated,
        ),
      checkpoint: () => null,
    })
    await t.backfill()
    const names = (await auctionEvents()).map((e) => e.payload.phase)
    expect(names).toEqual(["created", "ended"])
    expect((await phase("created"))[0]!.payload.supply).toBe("1100")
    expect((await phase("ended"))[0]!.payload).toMatchObject({
      graduated: false,
      raisedWei: "0",
      cleared: "0",
      clearingPriceWei: FLOOR_WEI,
    })
  })

  it("live reads a reverting checkpoint as the minimum bid and nothing raised (synthetic)", async () => {
    const t = await setup({
      supply: HALF,
      checkpoint: (b) => (b === START ? null : checkpointOfFixture(b)),
    })
    await t.backfill()
    expect((await phase("live"))[0]!.payload).toMatchObject({
      clearingPriceWei: FLOOR_WEI,
      raisedWei: "0",
    })
  })

  it("live and ended are emitted once across two batches", async () => {
    const t = await setup({ supply: HALF })
    await t.backfill(CREATED, 60_400_000n)
    expect((await auctionEvents()).map((e) => e.payload.phase)).toEqual([
      "created",
      "live",
      "price",
    ])
    await t.idx.backfill(60_400_001n, t.chain.head)
    expect((await auctionEvents()).map((e) => e.payload.phase)).toEqual([
      "created",
      "live",
      "price",
      "ended",
    ])
    await t.idx.backfill(60_400_001n, t.chain.head)
    expect(await auctionEvents()).toHaveLength(4)
  })

  it("the same span twice emits each phase once", async () => {
    const t = await setup({ supply: HALF })
    await t.backfill()
    const first = (await auctionEvents()).map((e) => e.tx_hash)
    await t.idx.backfill(CREATED, t.chain.head)
    expect((await auctionEvents()).map((e) => e.tx_hash)).toEqual(first)
    expect(await sql`select 1 from indexer.nftx_auction_bids`).toHaveLength(12)
    expect(await sql`select 1 from indexer.nftx_auctions`).toHaveLength(1)
  })
})

describe("failed reads", () => {
  it("a checkpoint read that reverts at endBlock after tokens arrived fails the span and writes nothing", async () => {
    const t = await setup({
      supply: HALF,
      checkpoint: (b) => (b === END ? null : checkpointOfFixture(b)),
    })
    await expect(t.backfill()).rejects.toThrow(AUCTION)
    expect(await sql`select 1 from indexer.nftx_auctions`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nftx_auction_bids`).toHaveLength(0)
    expect(await auctionEvents()).toEqual([])
  })

  it("a price whose checkpoint reverts fails the span (synthetic)", async () => {
    const t = await setup({
      supply: HALF,
      checkpoint: (b) => (b === 60_385_228n ? null : checkpointOfFixture(b)),
    })
    await expect(t.backfill()).rejects.toThrow(AUCTION)
    expect(await auctionEvents()).toEqual([])
  })

  it("a transport error from readAuctionCheckpoint fails the span", async () => {
    const t = await setup({ supply: HALF })
    t.chain.readAuctionCheckpoint = async () => {
      throw new Error("socket hang up")
    }
    await expect(t.backfill()).rejects.toThrow("socket hang up")
    expect(await sql`select 1 from indexer.nftx_auctions`).toHaveLength(0)
  })
})

describe("rollback", () => {
  const restore = (t: Awaited<ReturnType<typeof setup>>, from: bigint) => {
    for (const l of t.all) if (l.blockNumber >= from) t.chain.add(l)
  }

  it("rollback removes the auction, its bids and its phases", async () => {
    const t = await setup({ supply: HALF })
    await t.live()
    expect((await auctionEvents()).length).toBeGreaterThan(0)
    t.chain.reorg(CREATED)
    await t.idx.trigger()
    expect(await sql`select 1 from indexer.nftx_auctions`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nftx_auction_bids`).toHaveLength(0)
    expect(await auctionEvents()).toEqual([])
  })

  it("a rollback below the start block after live nulls live_block, and replay emits live once with the same id", async () => {
    let raised = 0n
    const t = await setup({
      supply: HALF,
      head: 60_450_000n,
      checkpoint: (b) =>
        b === START
          ? {
              clearingPriceQ96: made.config.floorPrice,
              currencyRaised: raised,
              totalCleared: 0n,
              graduated: true,
            }
          : checkpointOfFixture(b),
    })
    await t.live()
    expect((await phase("live")).map((e) => e.tx_hash)).toEqual([id("live", START)])
    expect((await phase("live"))[0]!.payload.raisedWei).toBe("0")
    // The same block replayed on the other fork reads another checkpoint.
    raised = 5n
    t.chain.reorg(START)
    restore(t, START)
    await t.idx.trigger()
    const live = await phase("live")
    expect(live.map((e) => e.tx_hash)).toEqual([id("live", START)])
    expect(live[0]!.payload.raisedWei).toBe("5")
    expect((await phase("created")).map((e) => e.tx_hash)).toEqual([id("created", CREATED, 48)])
    expect((await auctionRow()).live_block).toBe(START)
  })

  it("a rollback between live and ended keeps live and emits ended once on replay", async () => {
    const t = await setup({ supply: HALF, head: 60_450_000n })
    await t.live()
    t.chain.reorg(60_440_000n)
    restore(t, 60_440_000n)
    t.chain.head = 60_472_142n
    await t.idx.trigger()
    expect((await phase("live")).map((e) => e.tx_hash)).toEqual([id("live", START)])
    expect((await phase("ended")).map((e) => e.tx_hash)).toEqual([id("ended", END)])
    expect((await auctionRow()).live_block).toBe(START)
  })

  it("a rollback below TokensReceived clears the supply, and replay stores what the new fork says (synthetic)", async () => {
    const t = await setup({
      supply: HALF,
      head: 60_345_000n,
      logs: (logs) =>
        logs.map((l) =>
          l.topics[0] === CCA_TOPICS.TokensReceived
            ? { ...l, blockNumber: 60_340_000n, logIndex: 3 }
            : l,
        ),
    })
    await t.live()
    expect(await auctionRow()).toMatchObject({
      tokens_received_block: 60_340_000n,
      total_supply: (1100n * E18).toString(),
    })
    t.chain.reorg(60_340_000n)
    for (const l of t.all)
      if (l.blockNumber >= 60_340_000n)
        t.chain.add({
          ...l,
          data:
            l.topics[0] === CCA_TOPICS.TokensReceived
              ? encodeAbiParameters([{ type: "uint128" }], [1000n * E18])
              : l.data,
          blockNumber: l.topics[0] === CCA_TOPICS.TokensReceived ? 60_341_000n : l.blockNumber,
        })
    await t.idx.trigger()
    expect(await auctionRow()).toMatchObject({
      tokens_received_block: 60_341_000n,
      total_supply: (1000n * E18).toString(),
    })
  })

  it("rolling back below the collection's creation unkeeps the auction, and the keep is announced again on replay (synthetic)", async () => {
    const t = await setup({ collection: false, supply: HALF, head: 60_345_000n })
    await t.live()
    expect((await auctionRow()).kept).toBe(false)
    collectionCreated(t, 60_350_000n)
    t.chain.head = 60_360_000n
    await t.idx.trigger()
    expect(await auctionRow()).toMatchObject({
      kept: true,
      kept_block: 60_350_000n,
      created_emitted_block: 60_360_000n,
    })
    expect((await phase("created")).map((e) => e.tx_hash)).toEqual([id("created", 60_360_000n)])
    t.chain.reorg(60_350_000n)
    await t.idx.trigger()
    expect(await auctionRow()).toMatchObject({
      kept: false,
      collection: null,
      kept_block: null,
      created_emitted_block: null,
    })
    expect(await auctionEvents()).toEqual([])
    collectionCreated(t, 60_360_500n)
    t.chain.head = 60_361_000n
    await t.idx.trigger()
    expect((await phase("created")).map((e) => e.tx_hash)).toEqual([id("created", 60_361_000n)])
  })

  it("a link made by hand stays kept through a rollback, and is announced again", async () => {
    const t = await setup({ head: 60_345_000n })
    await t.live()
    expect(await auctionEvents()).toEqual([])
    await applyAuctionLink(sql, { auction: AUCTION, contract: COLLECTION })
    t.chain.head = 60_345_005n
    await t.idx.trigger()
    expect((await phase("created")).map((e) => e.tx_hash)).toEqual([id("created", 60_345_005n)])
    t.chain.reorg(60_345_001n)
    t.chain.head = 60_345_007n
    await t.idx.trigger()
    expect(await auctionRow()).toMatchObject({ kept: true, manual: true })
    expect((await phase("created")).map((e) => e.tx_hash)).toEqual([id("created", 60_345_007n)])
  })
})

describe("nft:auction", () => {
  const A = "0xf74d83a782aa45ec00d4f425714c028749a03563"
  const C = "0x0000000000000000000000000000000000000c0c"

  it("parseAuctionLink refuses one argument, three, and a non-address", () => {
    expect(parseAuctionLink([A, C])).toEqual({ ok: true, auction: A, contract: C })
    expect(parseAuctionLink([A.toUpperCase().replace("0X", "0x"), C])).toMatchObject({
      auction: A,
    })
    for (const args of [[], [A], [A, C, C], [A, "0x1234"], ["nope", C], [A, C.slice(2)]])
      expect(parseAuctionLink(args), args.join(" ")).toMatchObject({
        ok: false,
        usage: "usage: nft:auction <auction> <contract>",
      })
  })

  it("applyAuctionLink errors when the auction is not stored or the contract has no collection row", async () => {
    await expect(applyAuctionLink(sql, { auction: AUCTION, contract: COLLECTION })).rejects.toThrow(
      /not stored/,
    )
    const t = await setup({ collection: false })
    await t.backfill()
    await expect(applyAuctionLink(sql, { auction: AUCTION, contract: COLLECTION })).rejects.toThrow(
      /no collection/,
    )
    expect((await auctionRow()).kept).toBe(false)
  })

  it("applyAuctionLink sets the collection and keeps the auction by hand", async () => {
    const t = await setup({ collection: false })
    await t.backfill()
    await sql`insert into indexer.nft_collections ${sql({ contract: COLLECTION, standard: "erc721" })}`
    await applyAuctionLink(sql, { auction: AUCTION, contract: COLLECTION })
    expect(await auctionRow()).toMatchObject({
      collection: COLLECTION,
      kept: true,
      manual: true,
      kept_block: null,
    })
  })
})
