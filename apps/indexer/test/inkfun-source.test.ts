import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  INKFUN_HOOK,
  inkfunClosingSold,
  inkfunCurveValue,
  inkfunPrice,
  NATIVE_QUOTE_ASSET,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import { describe, expect, inject, it } from "vitest"
import { swapLog } from "../../../packages/sdk/test/builders"
import { loadInkfunFixture } from "../../../packages/sdk/test/fixtures"
import { BlockNotServedError } from "../src/errors"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import { inkfunSource } from "../src/sources/inkfun/index"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import { processLogs as processSwaps, v4Source } from "../src/sources/v4/index"
import { createStore } from "../src/store"
import { FakeChain } from "./fake-chain"
import {
  CREATOR,
  CURVE_PARAMS,
  curveOf,
  inkfunBuy,
  inkfunLaunch,
  inkfunMigrate,
  inkfunSell,
  launchIdOf,
  nextTx,
  poolIdOf,
  soldFor,
  TOTAL_SUPPLY,
  tokenOf,
} from "./inkfun-scenario"

const B = 59_000_000n
const GATEWAY = "https://gw.example"
const unknownContractWarnings = <T extends { msg: string }>(w: T[]) =>
  w.filter((x) => x.msg === "ignoring ink.fun-shaped event from an unknown contract")

type Fetch = typeof fetch
const metadataFetch = (docs: Record<string, unknown>, calls: string[] = []): Fetch =>
  (async (url: string) => {
    calls.push(url)
    const doc = docs[url.replace(`${GATEWAY}/ipfs/`, "")]
    return doc === undefined ? new Response("nope", { status: 404 }) : Response.json(doc)
  }) as unknown as Fetch

async function setup(opts: { fetch?: Fetch } = {}) {
  const sql: Sql = await resetDb(inject("databaseUrl"))
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
  const logger: Logger = (level, msg, fields) => {
    if (level === "warn") warnings.push({ msg, fields })
  }
  const chain = new FakeChain(B + 100n)
  const pools = new PoolRegistry()
  const source = inkfunSource({
    sql,
    chain,
    logger,
    pools,
    ipfs: { gateway: GATEWAY, fetch: opts.fetch ?? metadataFetch({}) },
  })
  // InkyPump's rollback removes the token, trade, pool and bond rows above a fork for every launchpad.
  const inkypump = inkypumpSource({ sql, chain, logger, pools })
  const store = createStore(sql)
  await inkypump.reload()
  await source.reload()
  const batchOf = (to: bigint) =>
    source.process([chain.logsIn(0n, to)], { toBlock: to, live: false })
  const ingest = async (to: bigint) => {
    const batch = await batchOf(to)
    await store.writeBatch([batch], [(tx) => source.write(tx, batch)], {
      cursor: { block: to, hash: chain.hashOf(to) },
      head: to,
    })
    return batch
  }
  const rollback = async (fork: bigint) => {
    const base = await inkypump.prepareRollback(fork)
    const prepared = await source.prepareRollback(fork)
    await store.rollback(fork, chain.hashOf(fork), [
      (tx) => inkypump.rollback(tx, fork, base),
      (tx) => source.rollback(tx, fork, prepared),
    ])
    await inkypump.reload()
    await source.reload()
  }
  return { sql, chain, pools, source, warnings, batchOf, ingest, rollback }
}

describe("launches", () => {
  it("a launch emits launchpad.launch with metadata from IPFS", async () => {
    const calls: string[] = []
    const t = await setup({
      fetch: metadataFetch(
        {
          bafy1: {
            description: "hello",
            image: "ipfs://bafyimg",
            extensions: { twitter: "x.com/a", website: "https://a.example" },
          },
        },
        calls,
      ),
    })
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      const batch = await t.batchOf(B)
      expect(calls).toEqual([`${GATEWAY}/ipfs/bafy1`])
      expect(batch.events).toHaveLength(1)
      expect(batch.events[0]?.event).toMatchObject({
        type: "launchpad.launch",
        launchpad: "inkfun",
        token: tokenOf(1),
        launchId: launchIdOf(1),
        hook: INKFUN_HOOK,
        creator: CREATOR,
        name: "Token 1",
        ticker: "T1",
        description: "hello",
        imageUrl: `${GATEWAY}/ipfs/bafyimg`,
        links: { telegram: null, twitter: "x.com/a", website: "https://a.example" },
        targetRaise: CURVE_PARAMS.graduationTarget.toString(),
        totalSupply: TOTAL_SUPPLY.toString(),
        blockTimestamp: Number(B),
      })
      expect(batch.tokens[0]).toMatchObject({
        address: tokenOf(1),
        hook: INKFUN_HOOK,
        launchId: launchIdOf(1),
        targetRaise: CURVE_PARAMS.graduationTarget,
        saleSupply: CURVE_PARAMS.curveSupply,
        totalSupply: TOTAL_SUPPLY,
      })
    } finally {
      await t.sql.end()
    }
  })

  it("a launch whose metadata fetch fails is written text-only", async () => {
    const t = await setup({ fetch: metadataFetch({}) })
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      const batch = await t.batchOf(B)
      expect(batch.events[0]?.event).toMatchObject({
        type: "launchpad.launch",
        name: "Token 1",
        description: null,
        imageUrl: null,
        links: { telegram: null, twitter: null, website: null },
      })
    } finally {
      await t.sql.end()
    }
  })

  it("a launch with no metadataURI fetches nothing", async () => {
    const calls: string[] = []
    const t = await setup({ fetch: metadataFetch({}, calls) })
    try {
      inkfunLaunch(t.chain, { n: 1, block: B, uri: null })
      await t.batchOf(B)
      expect(calls).toEqual([])
    } finally {
      await t.sql.end()
    }
  })

  it("fetches the metadata of every launch in a span together, after reading each block's launches", async () => {
    const calls: string[] = []
    const t = await setup({ fetch: metadataFetch({ bafy1: {}, bafy2: {} }, calls) })
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunLaunch(t.chain, { n: 2, block: B + 1n })
      await t.batchOf(B + 1n)
      expect(calls.sort()).toEqual([`${GATEWAY}/ipfs/bafy1`, `${GATEWAY}/ipfs/bafy2`])
      expect(t.chain.inkfunLaunchReads.map((r) => r.block)).toEqual([B, B + 1n])
    } finally {
      await t.sql.end()
    }
  })

  it("the seed buy in the launch transaction is a trade by the creator", async () => {
    const f = loadInkfunFixture("inkfun-launch-seed-buy")
    const t = await setup()
    try {
      t.chain.head = f.blockNumber + 10n
      for (const c of f.curves) {
        t.chain.inkfunLaunches.set(c.curve, {
          curve: c.params,
          lpSupply: c.lpSupply,
          totalSupply: c.totalSupply,
          metadataURI: c.metadataURI,
        })
      }
      for (const l of f.logs) t.chain.add(l)
      const batch = await t.batchOf(f.blockNumber)
      const types = batch.events.map((e) => e.event.type)
      expect(types).toEqual(["launchpad.launch", "launchpad.trade"])
      const launch = batch.events[0]?.event
      const trade = batch.events[1]?.event
      if (launch?.type !== "launchpad.launch" || trade?.type !== "launchpad.trade")
        throw new Error("unexpected events")
      expect(trade.trader).toBe(launch.creator)
      expect(trade.side).toBe("buy")
      expect(trade.token).toBe(launch.token)
      expect(batch.trades).toHaveLength(1)
    } finally {
      await t.sql.end()
    }
  })
})

describe("curve trades", () => {
  it("trades carry progress from net quote raised", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B, sold: soldFor(9_875_000_000_000_000n), logIndex: 1 })
      const batch = await t.batchOf(B)
      const trade = batch.events[1]?.event
      if (trade?.type !== "launchpad.trade") throw new Error("expected a trade")
      expect(trade.progressBpsBefore).toBe(0)
      expect(trade.progressBpsAfter).toBe(23)
      expect(trade.soldBps).toBe(23)
      expect(trade.target).toBe(CURVE_PARAMS.graduationTarget.toString())
      expect(trade.launchId).toBe(launchIdOf(1))
    } finally {
      await t.sql.end()
    }
  })

  it("a buy's quoteAmount is the gross paid and a sell's the net paid out", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: 10n ** 24n, quoteIn: 1_000n, fee: 13n })
      inkfunSell(t.chain, { n: 1, block: B + 2n, sold: 9n * 10n ** 23n, quoteOut: 900n, fee: 11n })
      const batch = await t.batchOf(B + 2n)
      const [, buy, sell] = batch.events.map((e) => e.event)
      if (buy?.type !== "launchpad.trade" || sell?.type !== "launchpad.trade")
        throw new Error("expected trades")
      expect(buy.quoteAmount).toBe("1013")
      expect(sell.quoteAmount).toBe("900")
      expect(sell.progressBpsBefore).toBe(buy.progressBpsAfter)
      expect(batch.trades.map((r) => [r.side, r.amountIn, r.amountOut])).toEqual([
        ["buy", 1013n, 77n],
        ["sell", 50n, 900n],
      ])
    } finally {
      await t.sql.end()
    }
  })

  it("curve trades raise the shared ath", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: 2n * 10n ** 26n })
      inkfunSell(t.chain, { n: 1, block: B + 2n, sold: 10n ** 26n })
      const batch = await t.batchOf(B + 2n)
      const [, buy, sell] = batch.events.map((e) => e.event)
      if (buy?.type !== "launchpad.trade" || sell?.type !== "launchpad.trade")
        throw new Error("expected trades")
      expect(BigInt(buy.athMarketCap)).toBe(BigInt(buy.marketCap))
      expect(BigInt(sell.marketCap)).toBeLessThan(BigInt(buy.marketCap))
      expect(sell.athMarketCap).toBe(buy.athMarketCap)
      expect(batch.ath).toEqual([
        { token: tokenOf(1), marketCap: BigInt(buy.marketCap), block: B + 1n },
      ])
      expect(t.pools.marks(tokenOf(1))?.ath).toBe(BigInt(buy.marketCap))
    } finally {
      await t.sql.end()
    }
  })

  it("a Bought from an unknown contract is ignored with one warning", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      const stranger = curveOf(99)
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: 5n, address: stranger })
      inkfunBuy(t.chain, { n: 1, block: B + 2n, sold: 6n, address: stranger })
      const batch = await t.batchOf(B + 2n)
      expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.launch"])
      const warned = unknownContractWarnings(t.warnings)
      expect(warned).toHaveLength(1)
      expect(warned[0]?.fields).toMatchObject({ address: stranger })
    } finally {
      await t.sql.end()
    }
  })

  it("a LaunchCreated not from the factory is ignored", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, {
        n: 1,
        block: B,
        factory: "0x00000000000000000000000000000000000000f9",
      })
      const batch = await t.batchOf(B)
      expect(batch.events).toEqual([])
      expect(batch.tokens).toEqual([])
      expect(unknownContractWarnings(t.warnings)).toHaveLength(1)
      expect(t.chain.getBlockCalls).toEqual([])
    } finally {
      await t.sql.end()
    }
  })

  it("one getBlock per block with ink.fun logs", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B, sold: 5n, logIndex: 1 })
      inkfunBuy(t.chain, { n: 1, block: B, sold: 9n, logIndex: 2 })
      inkfunBuy(t.chain, { n: 1, block: B + 3n, sold: 12n })
      await t.batchOf(B + 3n)
      expect(t.chain.getBlockCalls).toEqual([B, B + 3n])
    } finally {
      await t.sql.end()
    }
  })

  it("throws BlockNotServedError when the block of an ink.fun log is not served", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      t.chain.nullOnce.add(B)
      await expect(t.batchOf(B)).rejects.toBeInstanceOf(BlockNotServedError)
    } finally {
      await t.sql.end()
    }
  })
})

describe("through the database", () => {
  const rows = async (sql: Sql) => ({
    tokens:
      await sql`select address, hook, launch_id, launchpad, target_raise::text, sale_supply::text,
      total_supply::text, gain_bps, quote_asset, ath_market_cap::text, ath_block, phase from indexer.tokens order by address`,
    curves: await sql`select * from indexer.inkfun_curves order by token`,
    state:
      await sql`select token, progress_bps, curve_value::text, market_cap::text, updated_block from indexer.curve_state order by token`,
    trades:
      await sql`select tx_hash, log_index, side, amount_in::text, amount_out::text, block, venue from indexer.trades order by block, log_index`,
    events:
      await sql`select type, entity, payload, block, tx_hash, log_index from indexer.events order by id`,
  })

  it("writes the token, its curve, curve state and trades", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: soldFor(10n ** 17n) })
      await t.ingest(B + 1n)
      const r = await rows(t.sql)
      expect(r.tokens).toMatchObject([
        {
          address: tokenOf(1),
          launchpad: "inkfun",
          hook: INKFUN_HOOK,
          gain_bps: null,
          phase: "curve",
        },
      ])
      expect(r.curves).toMatchObject([
        {
          token: tokenOf(1),
          curve: curveOf(1),
          virtual_quote: CURVE_PARAMS.virtualQuote.toString(),
          graduation_target: CURVE_PARAMS.graduationTarget.toString(),
        },
      ])
      expect(r.state).toMatchObject([{ token: tokenOf(1), updated_block: B + 1n }])
      expect(r.trades).toHaveLength(1)
      expect(r.trades[0]?.venue).toBe("curve")
      expect(r.events.map((e) => e.type)).toEqual(["launchpad.launch", "launchpad.trade"])
    } finally {
      await t.sql.end()
    }
  })

  it("processing the same span twice writes identical rows", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: 2n * 10n ** 26n, logIndex: 1 })
      inkfunSell(t.chain, { n: 1, block: B + 2n, sold: 10n ** 26n, logIndex: 1 })
      inkfunBuy(t.chain, { n: 1, block: B + 3n, sold: 3n * 10n ** 26n, logIndex: 1 })
      const first = await t.ingest(B + 3n)
      expect(first.ath.length).toBeGreaterThan(0)
      const before = await rows(t.sql)
      const top = first.ath.at(-1)!
      expect(before.tokens[0]?.ath_market_cap).toBe(top.marketCap.toString())
      expect(before.tokens[0]?.ath_block).toBe(top.block)
      const second = await t.ingest(B + 3n)
      expect(second.ath).toEqual([])
      expect(await rows(t.sql)).toEqual(before)
    } finally {
      await t.sql.end()
    }
  })

  it("a span written after a later one does not move curve state back", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: soldFor(10n ** 17n) })
      inkfunBuy(t.chain, { n: 1, block: B + 6n, sold: soldFor(5n * 10n ** 17n) })
      await t.ingest(B + 6n)
      const later =
        await t.sql`select progress_bps, curve_value::text, updated_block from indexer.curve_state`
      await t.ingest(B + 1n)
      expect(
        await t.sql`select progress_bps, curve_value::text, updated_block from indexer.curve_state`,
      ).toEqual(later)
      expect(later[0]?.updated_block).toBe(B + 6n)
    } finally {
      await t.sql.end()
    }
  })

  it("reload restores known curves, then a trade on a curve created in an earlier span is accepted", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      await t.ingest(B)
      await t.source.reload()
      t.warnings.length = 0
      inkfunBuy(t.chain, { n: 1, block: B + 5n, sold: soldFor(10n ** 17n) })
      const batch = await t.source.process([t.chain.logsIn(B + 5n, B + 5n)], {
        toBlock: B + 5n,
        live: false,
      })
      expect(t.warnings).toEqual([])
      expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.trade"])
      expect(batch.events[0]?.event).toMatchObject({ launchId: launchIdOf(1), token: tokenOf(1) })
      const event = batch.events[0]?.event
      if (event?.type !== "launchpad.trade") throw new Error("expected a trade")
      expect(BigInt(event.curveValue)).toBe(inkfunCurveValue(CURVE_PARAMS, soldFor(10n ** 17n)))
    } finally {
      await t.sql.end()
    }
  })

  it("rollback restores curve state from tokensSold at the fork", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: soldFor(10n ** 17n) })
      inkfunBuy(t.chain, { n: 1, block: B + 6n, sold: soldFor(5n * 10n ** 17n) })
      await t.ingest(B + 6n)
      const sold = soldFor(10n ** 17n)
      t.chain.curveSold.set(curveOf(1), sold)
      await t.rollback(B + 3n)
      expect(t.chain.curveSoldReads).toEqual([{ curves: [curveOf(1)], block: B + 3n }])
      expect(t.chain.stateReads).toEqual([])
      const [state] =
        await t.sql`select progress_bps, curve_value::text, updated_block from indexer.curve_state`
      expect(state?.updated_block).toBe(B + 3n)
      expect(BigInt(state?.curve_value)).toBe(inkfunCurveValue(CURVE_PARAMS, sold))
      expect(await t.sql`select block from indexer.trades`).toEqual([{ block: B + 1n }])
    } finally {
      await t.sql.end()
    }
  })

  it("rollback below a launch removes the token and reads nothing", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B + 4n })
      await t.ingest(B + 4n)
      await t.rollback(B + 2n)
      expect(t.chain.curveSoldReads).toEqual([])
      expect(await t.sql`select address from indexer.tokens`).toEqual([])
      expect(await t.sql`select token from indexer.inkfun_curves`).toEqual([])
    } finally {
      await t.sql.end()
    }
  })
})

describe("migration into a Uniswap v4 pool", () => {
  const BURNED_SUPPLY = TOTAL_SUPPLY - 3_000_000n * 10n ** 18n
  const Q96 = 1n << 96n
  const closing = inkfunClosingSold(CURVE_PARAMS)

  it("Migrated emits launchpad.bond and registers the pool with the supply read at its block", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: closing })
      inkfunMigrate(t.chain, { n: 1, block: B + 1n, logIndex: 2 })
      t.chain.supplies.set(tokenOf(1), BURNED_SUPPLY)
      const batch = await t.batchOf(B + 1n)
      expect(batch.events.map((e) => e.event.type)).toEqual([
        "launchpad.launch",
        "launchpad.trade",
        "launchpad.bond",
      ])
      expect(batch.events[2]?.event).toMatchObject({
        launchpad: "inkfun",
        token: tokenOf(1),
        launchId: launchIdOf(1),
        poolId: poolIdOf(1),
        poolManager: UNISWAP_V4_POOL_MANAGER,
        liquidityQuote: "4150000000000000000",
        liquidityTokens: (197_000_000n * 10n ** 18n).toString(),
        quoteAsset: NATIVE_QUOTE_ASSET,
      })
      const entry = {
        poolId: poolIdOf(1),
        poolManager: UNISWAP_V4_POOL_MANAGER,
        token: tokenOf(1),
        launchId: launchIdOf(1),
        launchpad: "inkfun",
        quoteAsset: NATIVE_QUOTE_ASSET,
        tokenIsCurrency0: false,
        createdBlock: B + 1n,
      }
      expect(batch.pools).toEqual([entry])
      expect(t.pools.byId(poolIdOf(1))).toEqual(entry)
      expect(t.pools.marks(tokenOf(1))?.totalSupply).toBe(BURNED_SUPPLY)
      expect(batch.bonds).toEqual([
        { token: tokenOf(1), block: B + 1n, totalSupply: BURNED_SUPPLY },
      ])
      expect(batch.curve.find((c) => c.token === tokenOf(1))?.progressBps).toBe(10_000)
    } finally {
      await t.sql.end()
    }
  })

  it("Migrated for an unknown token, or from another contract, is ignored", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunMigrate(t.chain, { n: 7, block: B + 1n })
      inkfunMigrate(t.chain, {
        n: 1,
        block: B + 2n,
        address: "0x00000000000000000000000000000000000000f9",
      })
      const batch = await t.batchOf(B + 2n)
      expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.launch"])
      expect(batch.pools).toEqual([])
      expect(batch.bonds).toEqual([])
      expect(unknownContractWarnings(t.warnings).length).toBeGreaterThan(0)
    } finally {
      await t.sql.end()
    }
  })

  it("a deferred graduation bonds at the later Migrated", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      // The closing buy lands without a Migrated in its transaction.
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: closing })
      const first = await t.batchOf(B + 1n)
      expect(first.events.map((e) => e.event.type)).toEqual(["launchpad.launch", "launchpad.trade"])
      expect(first.bonds).toEqual([])
      expect(first.pools).toEqual([])
      t.chain.supplies.set(tokenOf(1), BURNED_SUPPLY)
      inkfunMigrate(t.chain, { n: 1, block: B + 9n })
      const later = await t.source.process([t.chain.logsIn(B + 9n, B + 9n)], {
        toBlock: B + 9n,
        live: false,
      })
      expect(later.events.map((e) => e.event.type)).toEqual(["launchpad.bond"])
      expect(later.events[0]?.block).toBe(B + 9n)
      expect(later.bonds).toEqual([
        { token: tokenOf(1), block: B + 9n, totalSupply: BURNED_SUPPLY },
      ])
      expect(later.curve).toMatchObject([{ token: tokenOf(1), progressBps: 10_000 }])
    } finally {
      await t.sql.end()
    }
  })

  const swapIn = (
    chain: FakeChain,
    a: { n: number; block: bigint; logIndex: number; sqrtPriceX96?: bigint },
  ) => {
    const tx = nextTx()
    chain.add(
      swapLog(
        {
          poolId: poolIdOf(a.n),
          sender: CREATOR,
          amount0: -(10n ** 15n),
          amount1: 10n ** 20n,
          sqrtPriceX96: a.sqrtPriceX96 ?? Q96,
          liquidity: 10n ** 21n,
        },
        { blockNumber: a.block, transactionHash: tx, logIndex: a.logIndex },
      ),
    )
    const s = chain.senders.get(a.block) ?? { hash: chain.hashOf(a.block), senders: new Map() }
    s.senders.set(tx, CREATOR)
    chain.senders.set(a.block, s)
  }

  it("closing buy, migration and the first swap in one block", async () => {
    const sql: Sql = await resetDb(inject("databaseUrl"))
    try {
      const chain = new FakeChain(B + 100n)
      const pools = new PoolRegistry()
      const logger: Logger = () => {}
      const idx = new Indexer({
        chain,
        store: createStore(sql),
        logger,
        sources: [
          inkypumpSource({ sql, chain, logger, pools }),
          inkfunSource({
            sql,
            chain,
            logger,
            pools,
            ipfs: { gateway: GATEWAY, fetch: metadataFetch({}) },
          }),
          v4Source({ sql, chain, logger, pools }),
        ],
      })
      await idx.init()
      // The v4 source reads nothing while the registry is empty; production always has pools.
      pools.add(
        {
          poolId: poolIdOf(9),
          poolManager: UNISWAP_V4_POOL_MANAGER,
          token: tokenOf(9),
          launchId: launchIdOf(9),
          launchpad: "inkypump",
          quoteAsset: NATIVE_QUOTE_ASSET,
          tokenIsCurrency0: false,
          createdBlock: 1n,
        },
        TOTAL_SUPPLY,
      )
      inkfunLaunch(chain, { n: 1, block: B, uri: null })
      inkfunBuy(chain, { n: 1, block: B + 1n, sold: closing, logIndex: 1 })
      inkfunMigrate(chain, { n: 1, block: B + 1n, logIndex: 2 })
      swapIn(chain, { n: 1, block: B + 1n, logIndex: 3 })
      chain.supplies.set(tokenOf(1), BURNED_SUPPLY)
      await idx.backfill(B, B + 1n)
      const events =
        await sql`select type, payload, log_index from indexer.events where block = ${String(B + 1n)} order by log_index`
      expect(events.map((e) => e.type)).toEqual([
        "launchpad.trade",
        "launchpad.bond",
        "launchpad.swap",
      ])
      expect(events[0]?.payload.progressBpsAfter).toBe(10_000)
      const swap = events[2]?.payload
      expect(swap.supply).toBe(BURNED_SUPPLY.toString())
      expect(swap.launchpad).toBe("inkfun")
      expect(BigInt(swap.athMarketCap)).toBeGreaterThanOrEqual(
        BigInt(events[0]?.payload.athMarketCap),
      )
      expect(
        await sql`select count(*)::int as n from indexer.trades where venue <> 'curve'`,
      ).toEqual([{ n: 1 }])
    } finally {
      await sql.end()
    }
  })

  it("after reload, the pool's market cap still uses the post-burn supply", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: closing })
      inkfunMigrate(t.chain, { n: 1, block: B + 1n, logIndex: 2 })
      t.chain.supplies.set(tokenOf(1), BURNED_SUPPLY)
      await t.ingest(B + 1n)
      expect(await t.sql`select total_supply::text as s, phase from indexer.tokens`).toEqual([
        { s: BURNED_SUPPLY.toString(), phase: "bonded" },
      ])
      const fresh = new PoolRegistry()
      await fresh.load(t.sql)
      expect(fresh.marks(tokenOf(1))?.totalSupply).toBe(BURNED_SUPPLY)
      swapIn(t.chain, { n: 1, block: B + 2n, logIndex: 0 })
      const batch = await processSwaps(t.chain.logsIn(B + 2n, B + 2n), [], {
        chain: t.chain,
        pools: fresh,
        readDeadAt: B + 2n,
      })
      const swap = batch.events[0]?.event
      if (swap?.type !== "launchpad.swap") throw new Error("expected a swap")
      expect(swap.supply).toBe(BURNED_SUPPLY.toString())
      expect(BigInt(swap.marketCap)).toBe(BURNED_SUPPLY)
    } finally {
      await t.sql.end()
    }
  })

  it("rollback below the migration removes the pool, un-bonds the token and restores its total supply", async () => {
    const t = await setup()
    try {
      inkfunLaunch(t.chain, { n: 1, block: B })
      inkfunBuy(t.chain, { n: 1, block: B + 1n, sold: soldFor(10n ** 17n) })
      inkfunBuy(t.chain, { n: 1, block: B + 5n, sold: closing })
      inkfunMigrate(t.chain, { n: 1, block: B + 5n, logIndex: 2 })
      t.chain.supplies.set(tokenOf(1), BURNED_SUPPLY)
      await t.ingest(B + 5n)
      expect(await t.sql`select pool_id from indexer.pools`).toHaveLength(1)

      t.chain.supplies.set(tokenOf(1), TOTAL_SUPPLY)
      t.chain.curveSold.set(curveOf(1), soldFor(10n ** 17n))
      await t.rollback(B + 3n)

      expect(await t.sql`select pool_id from indexer.pools`).toEqual([])
      expect(
        await t.sql`select phase, bonded_block, total_supply::text as s from indexer.tokens`,
      ).toEqual([{ phase: "curve", bonded_block: null, s: TOTAL_SUPPLY.toString() }])
      expect(t.pools.byId(poolIdOf(1))).toBeUndefined()
      const [state] =
        await t.sql`select progress_bps, market_cap::text as mc, updated_block from indexer.curve_state`
      expect(state?.updated_block).toBe(B + 3n)
      expect(state?.progress_bps).toBeLessThan(10_000)
      expect(BigInt(state?.mc)).toBe(
        (inkfunPriceAt(soldFor(10n ** 17n)) * TOTAL_SUPPLY) / 10n ** 18n,
      )
    } finally {
      await t.sql.end()
    }
  })
})

const inkfunPriceAt = (sold: bigint) => inkfunPrice(CURVE_PARAMS, sold)
