import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  type CcaLog,
  type ChainLog,
  ccaConfigParameter,
  decodeCcaLog,
  NFTX_LAUNCHPAD,
  NFTX_LOCKER,
} from "@ink-indexer/sdk"
import { type Address, decodeAbiParameters, encodeAbiParameters, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { loadNftxAuctionFixture } from "../../../packages/sdk/test/fixtures"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import { nftxSource } from "../src/sources/nftx/index"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import { synthLog } from "./nftx-harness"

// A launch as the launchpad makes it: one transaction creates the collection, starts the auction of
// the claim token and logs LaunchCreated. The auction's own logs are the recorded INKTRONS
// auction's, with its creation log rewritten to sell the claim token. That auction predates the
// second Locker, so the collection is created in the first.

const fx = loadNftxAuctionFixture()
const made = decodeCcaLog(fx.created) as Extract<CcaLog, { kind: "auctionCreated" }>
const AUCTION = fx.auction
const CREATED = 60_337_822n
const LAUNCHPAD = NFTX_LAUNCHPAD as Address
const COLLECTION = "0x00000000000000000000000000000000000c0111" as Address
const FLOOR_TOKEN = "0x00000000000000000000000000000000000f1001" as Address
const CLAIM_TOKEN = "0x00000000000000000000000000000000000c1a10" as Address
const CREATOR = "0x00000000000000000000000000000000000a0001" as Address
const USDC = "0x00000000000000000000000000000000000d0c01" as Address

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

type Opts = {
  /** The token the factory log names. */
  auctionToken?: Address
  currency?: Address
  /** Who logs LaunchCreated. */
  emitter?: Address
  /** The transaction's sender and target. */
  from?: Address
  to?: Address
  /** Drops LaunchCreated. */
  noLaunch?: boolean
}

function setup(opts: Opts = {}) {
  const logger: Logger = () => {}
  const chain = new FakeChain(60_472_142n)
  chain.maxSpan = 10_000_000n
  const [amount, configData] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes" }],
    fx.created.data,
  )
  const [config] = decodeAbiParameters([ccaConfigParameter], configData)
  const topics = [...fx.created.topics] as Hex[]
  topics[2] = `0x${(opts.auctionToken ?? CLAIM_TOKEN).slice(2).padStart(64, "0")}`
  const created = {
    ...fx.created,
    topics,
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes" }],
      [
        amount,
        encodeAbiParameters(
          [ccaConfigParameter],
          [{ ...config, currency: opts.currency ?? config.currency }],
        ),
      ],
    ),
  } as ChainLog
  for (const l of fx.logs) chain.add(l)
  chain.add(created)
  const collection = synthLog(
    created,
    "CollectionCreated",
    {
      _collection: COLLECTION,
      _collectionToken: FLOOR_TOKEN,
      _name: "Thinkers",
      _symbol: "THINK",
      _creator: LAUNCHPAD,
    },
    { address: NFTX_LOCKER, logIndex: 40 },
  )
  chain.add(collection)
  const launchLog = () =>
    synthLog(
      created,
      "LaunchCreated",
      {
        _launchId: 1n,
        _collection: COLLECTION,
        _creator: CREATOR,
        _vToken: FLOOR_TOKEN,
        _claimToken: CLAIM_TOKEN,
        _auction: AUCTION,
        _teamEscrow: CREATOR,
        _gate: CREATOR,
      },
      { address: opts.emitter ?? LAUNCHPAD, logIndex: 200 },
    )
  if (!opts.noLaunch) chain.add(launchLog())
  const tx = created.transactionHash
  chain.senders.set(CREATED, {
    hash: chain.hashOf(CREATED),
    senders: new Map([[tx, opts.from ?? CREATOR]]),
    targets: new Map([[tx, opts.to ?? LAUNCHPAD]]),
    timestamp: fx.blockTimes[String(CREATED)],
  })
  for (const [block, time] of Object.entries(fx.blockTimes))
    chain.blockTimes.set(BigInt(block), BigInt(time))
  chain.auctionCheckpoints.set(AUCTION, () => ({
    clearingPriceQ96: made.config.floorPrice,
    currencyRaised: 7n,
    totalCleared: 0n,
    graduated: true,
  }))
  const source = nftxSource({
    sql,
    chain,
    logger,
    fetch: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
  })
  const idx = new Indexer({ chain, store, logger, sources: [source] })
  const backfill = async () => {
    await idx.init()
    await idx.backfill(CREATED, chain.head)
  }
  return { chain, backfill, launchLog }
}

const auctionRow = async () =>
  (
    await sql<Record<string, unknown>[]>`
      select * from indexer.nftx_auctions where auction = ${AUCTION}`
  )[0]
const auctionEvents = () =>
  sql<{ payload: Record<string, unknown> }[]>`
    select payload from indexer.events where type = 'nft.auction' order by id`

describe("launchpad auctions", () => {
  it("keeps an auction that an earlier read stored before its LaunchCreated was seen (synthetic)", async () => {
    const t = setup({ noLaunch: true })
    await t.backfill()
    expect((await auctionRow())?.kept).toBe(false)
    t.chain.add(t.launchLog())
    await t.backfill()
    expect(await auctionRow()).toMatchObject({ kept: true, collection: COLLECTION })
  })

  it("keeps the auction of the claim token for the launch's collection, with no floor-token check (synthetic)", async () => {
    await setup().backfill()
    expect(await auctionRow()).toMatchObject({
      token: CLAIM_TOKEN,
      collection: COLLECTION,
      kept: true,
      manual: false,
    })
    const [created] = await auctionEvents()
    expect(created?.payload).toMatchObject({
      phase: "created",
      contract: COLLECTION,
      auction: AUCTION,
      token: CLAIM_TOKEN,
      currency: "ETH",
    })
  })

  it("announces the launch's phases, live and ended (synthetic)", async () => {
    await setup().backfill()
    const phases = (await auctionEvents()).map((e) => e.payload.phase)
    expect(phases).toContain("created")
    expect(phases).toContain("live")
    expect(phases.at(-1)).toBe("ended")
  })

  it("stores the collection as launchpad-created and real, whoever sent the transaction (synthetic)", async () => {
    await setup({ from: USDC, to: USDC }).backfill()
    expect(
      (
        await sql`select launchpad_created from indexer.nftx_collections where collection = ${COLLECTION}`
      )[0],
    ).toEqual({ launchpad_created: true })
    expect(
      (
        await sql`select verdict, note from indexer.nft_overrides where contract = ${COLLECTION}`
      )[0],
    ).toEqual({ verdict: "real", note: "nftx-launchpad" })
  })

  it("an ERC-20 currency is announced as its address (synthetic)", async () => {
    await setup({ currency: USDC }).backfill()
    expect((await auctionRow())?.kept).toBe(true)
    const [created] = await auctionEvents()
    expect(created?.payload.currency).toBe(USDC)
  })

  it("a LaunchCreated logged by another address keeps nothing (synthetic)", async () => {
    await setup({ emitter: CREATOR }).backfill()
    expect((await auctionRow())?.kept).toBe(false)
    expect(await auctionEvents()).toEqual([])
  })

  it("an auction that does not sell the launch's claim token is not kept (synthetic)", async () => {
    await setup({ auctionToken: USDC }).backfill()
    expect((await auctionRow())?.kept).toBe(false)
    expect(await auctionEvents()).toEqual([])
  })

  it("without a LaunchCreated the auction of an unrelated token is stored, not kept (synthetic)", async () => {
    await setup({ noLaunch: true }).backfill()
    expect((await auctionRow())?.kept).toBe(false)
  })
})
