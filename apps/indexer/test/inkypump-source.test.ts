import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { NATIVE_QUOTE_ASSET, UNISWAP_V4_POOL_MANAGER } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { describe, expect, inject, it } from "vitest"
import { tradeLog } from "../../../packages/sdk/test/builders"
import { BlockNotServedError } from "../src/errors"
import type { Logger } from "../src/log"
import { HookRegistry, nativeHookRows } from "../src/sources/inkypump/hooks"
import { inkypumpSource, type KnownLaunch, processLogs } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import { createStore } from "../src/store"
import { FakeChain } from "./fake-chain"
import {
  bond,
  CREATOR,
  HOOK,
  launch,
  launchIdOf,
  PARAMS,
  TRADER,
  tokenOf,
  trade,
  xstocksHook,
} from "./scenario"

const B = 45_290_000n

function setup(known: KnownLaunch[] = []) {
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
  const logger: Logger = (level, msg, fields) => {
    if (level === "warn") warnings.push({ msg, fields })
  }
  const chain = new FakeChain(45_300_000n)
  const registry = new HookRegistry(nativeHookRows(), logger)
  const pools = new PoolRegistry()
  const run = () =>
    processLogs(chain.logsIn(0n, chain.head), {
      chain,
      registry,
      pools,
      logger,
      loadLaunches: async () => known,
    })
  return { chain, registry, pools, warnings, run }
}

const knownLaunch = (n: number, progressBps: number): KnownLaunch => ({
  token: tokenOf(n),
  hook: HOOK,
  launchId: launchIdOf(n),
  quoteAsset: NATIVE_QUOTE_ASSET,
  params: PARAMS,
  totalSupply: 10n ** 27n,
  progressBps,
})

describe("processLogs", () => {
  it("turns a launch with metadata and a buy into token, curve, trade and events", async () => {
    const { chain, run } = setup()
    launch(chain, { n: 1, block: B })
    trade(chain, { n: 1, block: B, sold: 4n * 10n ** 26n, logIndex: 2 })
    const batch = await run()

    expect(batch.tokens).toEqual([
      {
        address: tokenOf(1),
        hook: HOOK,
        launchId: launchIdOf(1),
        name: "Token 1",
        ticker: "T1",
        creator: CREATOR,
        createdBlock: B,
        createdAt: new Date(Number(B) * 1000),
        quoteAsset: NATIVE_QUOTE_ASSET,
        pairedStock: null,
        totalSupply: 10n ** 27n,
        targetRaise: PARAMS.targetRaise,
        saleSupply: PARAMS.saleSupply,
        gainBps: 0,
      },
    ])
    expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.launch", "launchpad.trade"])
    expect(batch.events[1]!.event).toMatchObject({
      progressBpsBefore: 0,
      progressBpsAfter: 5000,
      curveValue: "500000000000000000",
    })
    expect(batch.curve).toEqual([
      {
        token: tokenOf(1),
        progressBps: 5000,
        curveValue: 5n * 10n ** 17n,
        target: 10n ** 18n,
        marketCap: 10n ** 12n,
        updatedBlock: B,
      },
    ])
    expect(batch.trades).toEqual([
      {
        txHash: expect.any(String),
        logIndex: 2,
        token: tokenOf(1),
        side: "buy",
        trader: TRADER,
        amountIn: 1n,
        amountOut: 1n,
        block: B,
      },
    ])
    expect(batch.blocks).toEqual([{ number: B, hash: chain.hashOf(B) }])
    expect(chain.stateReads).toEqual([B])
  })

  it("prices a trade on a known launch without reading state", async () => {
    const { chain, run } = setup([knownLaunch(2, 1200)])
    trade(chain, { n: 2, block: B, sold: PARAMS.saleSupply })
    const batch = await run()
    expect(batch.events[0]!.event).toMatchObject({
      type: "launchpad.trade",
      progressBpsBefore: 1200,
      progressBpsAfter: 10_000,
    })
    expect(chain.stateReads).toEqual([])
  })

  it("records a bond, reads state once and warns when sold != saleSupply", async () => {
    const { chain, run, warnings } = setup([knownLaunch(3, 9000)])
    bond(chain, { n: 3, block: B, sold: PARAMS.saleSupply - 1n })
    const batch = await run()
    expect(batch.bonds).toEqual([{ token: tokenOf(3), block: B }])
    expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.bond"])
    expect(batch.curve[0]).toMatchObject({ progressBps: 10_000 })
    expect(warnings.map((w) => w.msg)).toEqual(["bond fired with sold != saleSupply"])
    expect(chain.stateReads).toEqual([B])
  })

  it("does not warn when the bond fills the curve", async () => {
    const { chain, run, warnings } = setup([knownLaunch(3, 9000)])
    bond(chain, { n: 3, block: B })
    await run()
    expect(warnings).toEqual([])
  })

  it("registers an xStocks hook from its factory and ingests a launch on it in the same span", async () => {
    const { chain, run, registry } = setup()
    const XHOOK: Address = "0x799def4ec4a0a293a59b53a6479afc5a9df76ac4"
    const WRAPPER: Address = "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171"
    chain.erc20.set(WRAPPER, { decimals: 18, symbol: "TSLAx" })
    xstocksHook(chain, { block: B - 10n, hook: XHOOK, wrapper: WRAPPER })
    launch(chain, { n: 4, block: B, hook: XHOOK })
    const batch = await run()
    expect(batch.hooks).toEqual([
      {
        address: XHOOK,
        kind: "xstocks",
        abiFamily: "xstocks",
        quoteAsset: WRAPPER,
        quoteDecimals: 18,
        quoteSymbol: "TSLAx",
        assetId: expect.any(String),
        discoveredBlock: B - 10n,
      },
    ])
    expect(batch.tokens[0]).toMatchObject({ quoteAsset: WRAPPER, pairedStock: "TSLAx" })
    expect(registry.get(XHOOK)).toBeDefined()
  })

  it("ignores InkyPump-shaped events from unknown contracts and warns once per address", async () => {
    const { chain, run, warnings } = setup()
    const FAKE: Address = "0x00000000000000000000000000000000000000ff"
    launch(chain, { n: 5, block: B, hook: FAKE })
    xstocksHook(chain, { block: B, hook: FAKE, wrapper: FAKE, factory: FAKE, logIndex: 5 })
    const batch = await run()
    expect([batch.tokens, batch.hooks, batch.events]).toEqual([[], [], []])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.fields).toMatchObject({ address: FAKE })
  })

  it("throws on a trade for a launch it has never seen", async () => {
    const { chain, run } = setup()
    trade(chain, { n: 6, block: B, sold: 1n })
    await expect(run()).rejects.toThrow(/unknown launch/)
  })

  it("throws BlockNotServedError when the block of a trade-less event is not served", async () => {
    const { chain, run } = setup([knownLaunch(1, 0)])
    bond(chain, { n: 1, block: B })
    chain.nullOnce.add(B)
    await expect(run()).rejects.toBeInstanceOf(BlockNotServedError)
  })

  it("carries soldBps from the trade's sold over the launch's sale supply", async () => {
    const { chain, run } = setup([knownLaunch(2, 0)])
    trade(chain, { n: 2, block: B, sold: 2n * 10n ** 26n, logIndex: 0 })
    trade(chain, { n: 2, block: B, sold: PARAMS.saleSupply, logIndex: 1 })
    const batch = await run()
    expect(batch.events.map((e) => (e.event as { soldBps: number }).soldBps)).toEqual([
      2500, 10_000,
    ])
  })

  it("maps a sell to amountIn = tokenAmount and amountOut = quoteAmount, and a buy the other way", async () => {
    const { chain, run } = setup([knownLaunch(2, 5000)])
    const at = (logIndex: number) => ({
      address: HOOK,
      blockNumber: B,
      transactionHash: `0x${(0xabc0 + logIndex).toString(16).padStart(64, "0")}` as const,
      logIndex,
    })
    const t = {
      launchId: BigInt(launchIdOf(2)),
      trader: TRADER,
      price: 1000n,
      sold: 4n * 10n ** 26n,
      timestamp: Number(B),
      tokenAmount: 7n,
      quoteAmount: 9n,
    }
    chain.add(tradeLog({ ...t, side: "sell" }, at(0)))
    chain.add(tradeLog({ ...t, side: "buy" }, at(1)))
    const batch = await run()
    expect(batch.trades.map((r) => [r.side, r.amountIn, r.amountOut])).toEqual([
      ["sell", 7n, 9n],
      ["buy", 9n, 7n],
    ])
  })
})

/** Curve market cap of a trade at `price` with the scenario's supply of 1e27. */
const mc = (price: bigint) => price * 10n ** 9n
const athOf = (e: { event: unknown }) => (e.event as { athMarketCap: string }).athMarketCap

describe("pools and ath", () => {
  it("bond registers its pool with the token as currency1 for a native quote", async () => {
    const { chain, run, pools } = setup([knownLaunch(3, 9000)])
    bond(chain, { n: 3, block: B })
    const batch = await run()
    const entry = {
      poolId: launchIdOf(3),
      poolManager: UNISWAP_V4_POOL_MANAGER,
      token: tokenOf(3),
      launchpad: "inkypump",
      quoteAsset: NATIVE_QUOTE_ASSET,
      tokenIsCurrency0: false,
      createdBlock: B,
    }
    expect(batch.pools).toEqual([entry])
    expect(pools.byId(launchIdOf(3))).toEqual(entry)
    expect(pools.marks(tokenOf(3))?.totalSupply).toBe(10n ** 27n)
  })

  it("curve trades carry the running ath", async () => {
    const { chain, run, pools } = setup([knownLaunch(2, 0)])
    trade(chain, { n: 2, block: B, sold: 1n, price: 1000n, logIndex: 0 })
    trade(chain, { n: 2, block: B, sold: 2n, price: 3000n, logIndex: 1 })
    trade(chain, { n: 2, block: B + 1n, sold: 3n, price: 2000n })
    const batch = await run()
    expect(batch.events.map(athOf)).toEqual([mc(1000n), mc(3000n), mc(3000n)].map(String))
    expect(batch.ath).toEqual([{ token: tokenOf(2), marketCap: mc(3000n), block: B }])
    expect(pools.marks(tokenOf(2))).toMatchObject({ ath: mc(3000n), athBlock: B })
  })

  it("a trade in the launch's span carries ath", async () => {
    const { chain, run } = setup()
    launch(chain, { n: 1, block: B })
    trade(chain, { n: 1, block: B, sold: 1n, price: 4000n, logIndex: 2 })
    const batch = await run()
    expect(athOf(batch.events[1]!)).toBe(String(mc(4000n)))
    expect(batch.ath).toEqual([{ token: tokenOf(1), marketCap: mc(4000n), block: B }])
  })

  it("ath does not fall when a later trade is lower", async () => {
    const { chain, run, pools } = setup([knownLaunch(2, 0)])
    pools.bumpAth(tokenOf(2), mc(9000n), B - 100n)
    trade(chain, { n: 2, block: B, sold: 1n, price: 1000n })
    const batch = await run()
    expect(athOf(batch.events[0]!)).toBe(String(mc(9000n)))
    expect(batch.ath).toEqual([])
    expect(pools.marks(tokenOf(2))).toMatchObject({ ath: mc(9000n), athBlock: B - 100n })
  })
})

describe("pools and ath through the database", () => {
  async function db() {
    const sql: Sql = await resetDb(inject("databaseUrl"))
    const chain = new FakeChain(B + 10n)
    const pools = new PoolRegistry()
    const source = inkypumpSource({ sql, chain, logger: () => {}, pools })
    const store = createStore(sql)
    await source.reload()
    const ingest = async (to: bigint) => {
      const batch = await source.process([chain.logsIn(0n, to)], { toBlock: to })
      await store.writeBatch([batch], [(tx) => source.write(tx, batch)], {
        cursor: { block: to, hash: chain.hashOf(to) },
        head: to,
      })
    }
    const rollback = async (fork: bigint) => {
      const prepared = await source.prepareRollback(fork)
      await store.rollback(fork, chain.hashOf(fork), [(tx) => source.rollback(tx, fork, prepared)])
      await source.reload()
    }
    return { sql, chain, pools, ingest, rollback }
  }

  it("rollback below a bond removes the pool", async () => {
    const { sql, chain, pools, ingest, rollback } = await db()
    try {
      launch(chain, { n: 1, block: B })
      bond(chain, { n: 1, block: B + 8n })
      await ingest(B + 8n)
      expect(await sql`select pool_id, token from indexer.pools`).toEqual([
        { pool_id: launchIdOf(1), token: tokenOf(1) },
      ])
      await rollback(B + 4n)
      expect(await sql`select pool_id from indexer.pools`).toEqual([])
      expect(pools.byId(launchIdOf(1))).toBeUndefined()
    } finally {
      await sql.end()
    }
  })

  it("rollback restores ath from remaining trade and swap events", async () => {
    const { sql, chain, pools, ingest, rollback } = await db()
    try {
      launch(chain, { n: 1, block: B })
      trade(chain, { n: 1, block: B + 1n, sold: 1n, price: 1000n })
      bond(chain, { n: 1, block: B + 2n })
      await ingest(B + 2n)
      await sql`
        insert into indexer.events (type, entity, payload, block, block_hash, tx_hash, log_index, confirmed)
        values ('launchpad.swap', ${tokenOf(1)},
                ${sql.json({ type: "launchpad.swap", marketCap: String(mc(2000n)) })},
                ${String(B + 3n)}, ${chain.hashOf(B + 3n)}, ${`0x${"5".repeat(64)}`}, 0, false)`
      await sql`update indexer.tokens set ath_market_cap = ${String(mc(2000n))}, ath_block = ${String(B + 3n)}`
      trade(chain, { n: 1, block: B + 6n, sold: 2n, price: 5000n })
      await ingest(B + 6n)
      expect(await sql`select ath_market_cap::text as ath, ath_block from indexer.tokens`).toEqual([
        { ath: String(mc(5000n)), ath_block: B + 6n },
      ])

      await rollback(B + 4n)
      expect(await sql`select ath_market_cap::text as ath, ath_block from indexer.tokens`).toEqual([
        { ath: String(mc(2000n)), ath_block: B + 3n },
      ])
      expect(pools.marks(tokenOf(1))).toMatchObject({ ath: mc(2000n), athBlock: B + 3n })
    } finally {
      await sql.end()
    }
  })
})
