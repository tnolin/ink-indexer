import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type {
  BondEvent,
  IndexerEvent,
  LaunchEvent,
  SwapEvent,
  TradeEvent,
} from "@ink-indexer/events"
import {
  type ChainLog,
  classicCurveOf,
  decodeHookitLog,
  HOOKIT_BONDING_FACTORY,
  HOOKIT_GRADUATED_FEE_HOOK,
  HOOKIT_MASTER_FACTORIES,
  HOOKIT_TOPICS,
  poolIdOf,
  poolMarketCap,
  SWAP_TOPIC,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import { type Address, encodeAbiParameters, type Hash, pad, toHex } from "viem"
import { describe, expect, inject, it } from "vitest"
import {
  type HookitFixtureName,
  loadHookitFixture,
  loadHookitHistory,
  loadHookitPoolKey,
} from "../../../packages/sdk/test/fixtures"
import type { Logger } from "../src/log"
import { hookitSource } from "../src/sources/hookit/index"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import { v4Source } from "../src/sources/v4/index"
import { createStore } from "../src/store"
import { FakeChain } from "./fake-chain"
import { addFixture } from "./hookit-scenario"

const GATEWAY = "https://gw.example"
const ETH: Address = "0x0000000000000000000000000000000000000000"
const recorded = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../packages/sdk/test/fixtures", name), "utf8"),
  )

/** The recorded metadata documents, by the CID the launch's `metadataURI()` names. */
const cidOf = (name: HookitFixtureName) =>
  loadHookitFixture(name).tokens[0]!.metadataURI.replace("ipfs://", "")
const DOCS: Record<string, unknown> = {
  [cidOf("hookit-hkt-launch")]: recorded("hookit-metadata-hkt.json"),
  [cidOf("hookit-hmu-launch")]: recorded("hookit-metadata-hmu.json"),
  [cidOf("hookit-qcard-launch")]: recorded("hookit-metadata-qcard.json"),
}

type Fetch = typeof fetch
const metadataFetch = (docs: Record<string, unknown> = DOCS, calls: string[] = []): Fetch =>
  (async (url: string) => {
    calls.push(url)
    const doc = docs[url.replace(`${GATEWAY}/ipfs/`, "")]
    return doc === undefined ? new Response("nope", { status: 404 }) : Response.json(doc)
  }) as unknown as Fetch

const NAMES: Record<string, { name: string; symbol: string }> = {
  "hookit-hkt-launch": { name: "HOOKIT", symbol: "HKT" },
  "hookit-hmu-launch": { name: "HMU", symbol: "HMU" },
  "hookit-inky-launch": { name: "INKY", symbol: "INKY" },
  "hookit-qcard-launch": { name: "QCARD", symbol: "QCARD" },
  "hookit-hooc-launch": { name: "HOOC", symbol: "HOOC" },
}

const UNKNOWN_WARNING = "ignoring Hookit-shaped launch from an unknown contract"

async function setup(opts: { fetch?: Fetch; live?: boolean } = {}) {
  const live = opts.live ?? false
  const sql: Sql = await resetDb(inject("databaseUrl"))
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
  const logger: Logger = (level, msg, fields) => {
    if (level === "warn") warnings.push({ msg, fields })
  }
  const chain = new FakeChain(61_000_000n)
  const pools = new PoolRegistry()
  const source = hookitSource({
    sql,
    chain,
    logger,
    pools,
    ipfs: { gateway: GATEWAY, fetch: opts.fetch ?? metadataFetch() },
  })
  // InkyPump's rollback removes the token, trade, pool and ath rows above a fork for every launchpad.
  const inkypump = inkypumpSource({ sql, chain, logger, pools })
  const v4 = v4Source({ sql, chain, logger, pools })
  const store = createStore(sql)
  await inkypump.reload()
  await source.reload()

  /** A recorded launch transaction with the reads that answer for its tokens at its block. */
  const seed = (name: HookitFixtureName) => {
    const f = loadHookitFixture(name)
    addFixture(chain, f)
    for (const t of f.tokens) {
      chain.supplies.set(t.token, t.totalSupply)
      chain.metadataUris.set(t.token, t.metadataURI)
      chain.erc20Names.set(t.token, NAMES[name] ?? { name: "Token", symbol: "TKN" })
    }
    for (const c of f.classic) chain.classicLaunches.set(c.id, c.at)
    return f
  }
  /** HOOC's recorded events up to a block, each trader sending its own transaction. */
  const addHistory = (upTo: bigint) => {
    const h = loadHookitHistory()
    const senders = new Map<bigint, Map<Hash, Address>>()
    for (const l of h.logs) {
      if (l.blockNumber > upTo) continue
      chain.add({ ...l })
      const d = decodeHookitLog(l)
      const who = d?.kind === "bought" ? d.buyer : d?.kind === "sold" ? d.seller : null
      const m = senders.get(l.blockNumber) ?? new Map<Hash, Address>()
      if (who) m.set(l.transactionHash, who)
      senders.set(l.blockNumber, m)
    }
    for (const [n, m] of senders) chain.senders.set(n, { hash: chain.hashOf(n), senders: m })
    const launch = h.logs.map((l) => decodeHookitLog(l)).find((d) => d?.kind === "classicLaunched")
    if (launch?.kind !== "classicLaunched") throw new Error("fixture")
    chain.supplies.set(launch.token, 10n ** 27n)
    chain.classicLaunches.set(1n, h.state)
    return h
  }
  const batchOf = (to: bigint, from = 0n) =>
    source.process([chain.logsIn(from, to)], { toBlock: to, live })
  const ingest = async (to: bigint, from = 0n) => {
    const batch = await batchOf(to, from)
    await store.writeBatch([batch], [(tx) => source.write(tx, batch)], {
      cursor: { block: to, hash: chain.hashOf(to) },
      head: to,
    })
    return batch
  }
  /** One span as `main.ts` runs it: the swap request is built before the Hookit source registers a pool. */
  const span = async (to: bigint, from = 0n) => {
    const filters = v4.filters()
    const hookit = await source.process([chain.logsIn(from, to)], { toBlock: to, live })
    const swaps = await v4.process(
      filters.map((f) => (f ? chain.logsIn(from, to, f) : [])),
      { toBlock: to, live },
    )
    return { hookit, swaps }
  }
  const rollback = async (fork: bigint) => {
    const base = await inkypump.prepareRollback(fork)
    const prepared = await source.prepareRollback(fork)
    const dead = await v4.prepareRollback(fork)
    await store.rollback(fork, chain.hashOf(fork), [
      (tx) => inkypump.rollback(tx, fork, base),
      (tx) => source.rollback(tx, fork, prepared),
      (tx) => v4.rollback(tx, fork, dead),
    ])
    await inkypump.reload()
    await source.reload()
  }
  return {
    sql,
    chain,
    pools,
    source,
    inkypump,
    addHistory,
    warnings,
    seed,
    batchOf,
    ingest,
    span,
    rollback,
  }
}

const eventsOf = <T extends IndexerEvent>(
  batch: { events: { event: IndexerEvent }[] },
  type: T["type"],
) => batch.events.map((e) => e.event).filter((e): e is T => e.type === type)
const launchesOf = (b: { events: { event: IndexerEvent }[] }) =>
  eventsOf<LaunchEvent>(b, "launchpad.launch")

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x), 1)

describe("Hookit Master launches", () => {
  it("$HKT's launch emits launchpad.launch with startsInPool, the hook, customHook false and five modules, and registers its pool with ticks", async () => {
    const t = await setup({ fetch: metadataFetch() })
    try {
      const f = t.seed("hookit-hkt-launch")
      const batch = await t.ingest(f.blockNumber)
      const [launch] = launchesOf(batch)
      expect(launch).toMatchObject({
        launchpad: "hookit",
        token: f.tokens[0]!.token,
        startsInPool: true,
        customHook: false,
        targetRaise: null,
        name: "HOOKIT",
        ticker: "HKT",
        description: "Hold one, get all",
        totalSupply: f.tokens[0]!.totalSupply.toString(),
        poolManager: UNISWAP_V4_POOL_MANAGER,
        quoteAsset: ETH,
      })
      expect(launch!.hookModules).toEqual([
        "Anti-Snipe",
        "Anti-MEV",
        "Auto-Burn",
        "Deepen LPs",
        "Creator → Hook",
      ])
      expect(launch!.imageUrl).toContain("QmTQYPvhm6A9gTwwrQUnHqvuRFkcvfaiGRN49BnTSawzoH")
      const [pool] = batch.pools
      expect(batch.pools).toHaveLength(1)
      expect(pool).toMatchObject({
        poolId: launch!.poolId,
        launchpad: "hookit",
        hook: launch!.hook,
        tickLower: -887220,
        tickUpper: 201240,
        // ETH is the lower currency, so the token is currency1.
        tokenIsCurrency0: false,
        quoteAsset: ETH,
      })
      expect(t.pools.byId(pool!.poolId)).toEqual(pool)
      const [row] = await t.sql`
        select hook, launch_id, target_raise, sale_supply, total_supply_block::text, phase, launchpad
        from indexer.tokens where address = ${f.tokens[0]!.token}`
      expect(row).toMatchObject({
        hook: launch!.hook,
        launch_id: launch!.launchId,
        target_raise: null,
        sale_supply: null,
        total_supply_block: f.blockNumber.toString(),
        launchpad: "hookit",
      })
      const [stored] = await t.sql`select tick_lower, tick_upper, hook from indexer.pools`
      expect(stored).toMatchObject({ tick_lower: -887220, tick_upper: 201240, hook: launch!.hook })
    } finally {
      await t.sql.end()
    }
  })

  it("HMU's launch registers five pools and carries markets in order", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-hmu-launch")
      const batch = await t.ingest(f.blockNumber)
      const [launch] = launchesOf(batch)
      const markets = f.logs
        .map((l) => decodeHookitLog(l))
        .flatMap((d) => (d?.kind === "market" ? [d] : []))
        .sort((a, b) => a.index - b.index)
      expect(markets).toHaveLength(5)
      expect(launch!.markets).toEqual(
        markets.map((m) => ({ quoteAsset: m.quote, poolId: m.poolId })),
      )
      expect(batch.pools.map((p) => p.poolId)).toEqual(markets.map((m) => m.poolId))
      expect(launch!.poolId).toBe(markets[0]!.poolId)
      expect(t.pools.marketCount(launch!.token)).toBe(5)
      for (const [i, p] of batch.pools.entries()) {
        expect(p).toMatchObject({
          quoteAsset: markets[i]!.quote,
          tickLower: markets[i]!.tickLower,
          tickUpper: markets[i]!.tickUpper,
          tokenIsCurrency0: launch!.token < markets[i]!.quote,
        })
      }
      expect(await t.sql`select 1 from indexer.pools`).toHaveLength(5)
    } finally {
      await t.sql.end()
    }
  })

  it("INKY's markets start with USDG", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-inky-launch")
      const batch = await t.ingest(f.blockNumber)
      const [launch] = launchesOf(batch)
      expect(launch!.markets).toHaveLength(3)
      expect(launch!.quoteAsset).toBe(launch!.markets![0]!.quoteAsset)
      const configured = f.logs.map((l) => decodeHookitLog(l)).find((d) => d?.kind === "configured")
      expect(configured?.kind === "configured" && configured.quote).toBe(launch!.quoteAsset)
      // USDG sorts below the token here, so the token is currency1 in its pool.
      expect(batch.pools[0]!.quoteAsset).toBe(launch!.quoteAsset)
    } finally {
      await t.sql.end()
    }
  })

  it("launches in two transactions with the same launch id keep their own configuration (synthetic)", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-hkt-launch")
      const second = f.blockNumber + 1n
      const other: Hash = `0x${"5e".repeat(32)}`
      const token: Address = "0x00000000000000000000000000000000000000b2"
      for (const l of [...t.chain.logs]) {
        const d = decodeHookitLog(l)
        if (d?.kind !== "configured" && d?.kind !== "masterLaunched") continue
        t.chain.add({
          ...l,
          blockNumber: second,
          transactionHash: other,
          // A configuration with no modules, and another token.
          data:
            d.kind === "configured" ? (`0x${"0".repeat(64)}${l.data.slice(66)}` as Hash) : l.data,
          topics:
            d.kind === "masterLaunched"
              ? [
                  l.topics[0]!,
                  l.topics[1]!,
                  `0x${"0".repeat(24)}${token.slice(2)}` as Hash,
                  l.topics[3]!,
                ]
              : l.topics,
        })
      }
      t.chain.senders.set(second, { hash: t.chain.hashOf(second), senders: new Map() })
      const launches = launchesOf(await t.ingest(second))
      expect(launches.map((l) => l.hookModules?.length)).toEqual([5, 0])
    } finally {
      await t.sql.end()
    }
  })

  it("QCARD's launch carries supply 4,444", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-qcard-launch")
      const batch = await t.ingest(f.blockNumber)
      const [launch] = launchesOf(batch)
      expect(launch!.totalSupply).toBe((4_444n * 10n ** 18n).toString())
      expect(launch!.hookModules).toEqual(["Hook → Creator", "Fixed Fees"])
      expect(launch!.links.website).toBe("https://qcard.fun/")
      expect(t.pools.marks(launch!.token)?.totalSupply).toBe(4_444n * 10n ** 18n)
      expect(t.pools.marks(launch!.token)?.supplyBlock).toBe(f.blockNumber)
    } finally {
      await t.sql.end()
    }
  })

  it("QUILL's inline metadata is decoded without a fetch", async () => {
    const calls: string[] = []
    const t = await setup({ fetch: metadataFetch(DOCS, calls) })
    try {
      const f = t.seed("hookit-quill-launch")
      const [launch] = launchesOf(await t.ingest(f.blockNumber))
      expect(launch!.imageUrl).toContain(
        "bafybeielfywpazmeiexmxoucohsso3m5b2ajscvo4pux4tdq5zd7paeaay",
      )
      expect(calls).toEqual([])
    } finally {
      await t.sql.end()
    }
  })

  it("C21's dev-buy swap has the creator as trader although tx.from differs", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-bloop-launch")
      const { hookit, swaps } = await t.span(f.blockNumber)
      const [launch] = launchesOf(hookit)
      expect(launch!.creator).not.toBe(f.sender)
      const userSwaps = eventsOf<SwapEvent>(swaps, "launchpad.swap")
      expect(userSwaps.length).toBeGreaterThan(0)
      // Only the swap the emitting factory made is the dev buy; other swaps keep the sender.
      const factory = f.logs.find((l) => decodeHookitLog(l)?.kind === "masterLaunched")!.address
      const bySender = new Map(
        f.logs
          .filter((l) => l.topics[0] === SWAP_TOPIC)
          .map((l) => [l.logIndex, `0x${l.topics[2]!.slice(26)}`]),
      )
      const devBuys = userSwaps.filter((s) => bySender.get(s.logIndex) === factory)
      expect(devBuys.length).toBeGreaterThan(0)
      for (const s of devBuys) expect(s.trader).toBe(launch!.creator)
      for (const s of userSwaps.filter((s) => !devBuys.includes(s))) expect(s.trader).toBe(f.sender)
    } finally {
      await t.sql.end()
    }
  })

  it("the dev-buy trader is dropped from the registry once the next span starts", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-bloop-launch")
      const factory = f.logs.find((l) => decodeHookitLog(l)?.kind === "masterLaunched")!.address
      await t.span(f.blockNumber)
      expect(t.pools.traderOf(f.txHash, factory)).toBeDefined()
      await t.batchOf(f.blockNumber + 1n, f.blockNumber + 1n)
      expect(t.pools.traderOf(f.txHash, factory)).toBeUndefined()
    } finally {
      await t.sql.end()
    }
  })

  it("an unseen hook gets an indexer.hooks row (synthetic)", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-qcard-launch")
      const hook = (
        decodeHookitLog(f.logs.find((l) => decodeHookitLog(l)?.kind === "masterLaunched")!) as {
          hooks: Address
        }
      ).hooks
      await t.sql`delete from indexer.hooks where address = ${hook}`
      await t.source.reload()
      const batch = await t.ingest(f.blockNumber)
      expect(batch.hooks).toEqual([{ address: hook, discoveredBlock: f.blockNumber }])
      const [row] = await t.sql`
        select launchpad, kind, abi_family, discovered_block::text from indexer.hooks where address = ${hook}`
      expect(row).toMatchObject({
        launchpad: "hookit",
        kind: "hookit",
        abi_family: "hookit",
        discovered_block: f.blockNumber.toString(),
      })
      // A seeded hook needs no row.
      const t2 = t.seed("hookit-hkt-launch")
      expect((await t.batchOf(t2.blockNumber, t2.blockNumber)).hooks).toEqual([])
    } finally {
      await t.sql.end()
    }
  })

  it("a custom-hook launch is written with customHook true (synthetic)", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-hkt-launch")
      // customHook is the third data word of TokenLaunched.
      const i = t.chain.logs.findIndex((l) => decodeHookitLog(l)?.kind === "masterLaunched")
      const log = t.chain.logs[i]!
      const data = `0x${log.data.slice(2, 2 + 128)}${"0".repeat(63)}1${log.data.slice(2 + 192)}`
      t.chain.logs[i] = { ...log, data: data as Hash }
      const [launch] = launchesOf(await t.ingest(f.blockNumber))
      expect(launch!.customHook).toBe(true)
    } finally {
      await t.sql.end()
    }
  })

  it("a launch whose metadata fetch fails is written text-only", async () => {
    const t = await setup({ fetch: metadataFetch({}) })
    try {
      const f = t.seed("hookit-hkt-launch")
      const [launch] = launchesOf(await t.ingest(f.blockNumber))
      expect(launch).toMatchObject({
        name: "HOOKIT",
        ticker: "HKT",
        description: null,
        imageUrl: null,
      })
      expect(launch!.links).toEqual({ telegram: null, twitter: null, website: null })
      expect(t.warnings.some((w) => w.msg === "token metadata not fetched")).toBe(true)
    } finally {
      await t.sql.end()
    }
  })

  it("a launch whose metadataURI call reverts is written text-only without a fetch", async () => {
    const calls: string[] = []
    const t = await setup({ fetch: metadataFetch(DOCS, calls) })
    try {
      const f = t.seed("hookit-hkt-launch")
      t.chain.metadataUris.clear()
      const [launch] = launchesOf(await t.ingest(f.blockNumber))
      expect(launch!.description).toBeNull()
      expect(calls).toEqual([])
    } finally {
      await t.sql.end()
    }
  })
})

describe("Hookit Classic curves", () => {
  it("HOOC's launch, then its creator's Bought, in that order, with progress from the read state", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-hooc-launch")
      const batch = await t.ingest(f.blockNumber)
      expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.launch", "launchpad.trade"])
      const [launch] = launchesOf(batch)
      const [trade] = eventsOf<TradeEvent>(batch, "launchpad.trade")
      expect(launch).toMatchObject({
        startsInPool: false,
        hook: HOOKIT_GRADUATED_FEE_HOOK,
        targetRaise: "4200000000000000000",
        hookModules: null,
        name: "HOOC",
      })
      expect(trade).toMatchObject({
        side: "buy",
        trader: f.sender,
        progressBpsBefore: 0,
        target: "4200000000000000000",
      })
      expect(trade!.progressBpsAfter).toBeGreaterThan(0)
      // The derived state after the seed buy is what launches(1) read at the block.
      const at = f.classic[0]!.at
      expect(trade!.curveValue).toBe(at.realQuote.toString())
      const [curve] = await t.sql`
        select tokens_sold::text, launch_number::text, virtual_quote::text, virtual_tokens::text, curve_supply::text
        from indexer.hookit_curves`
      expect(curve).toMatchObject({
        tokens_sold: at.tokensSold.toString(),
        launch_number: "1",
        curve_supply: at.curveSupply.toString(),
      })
      const [state] = await t.sql`select progress_bps, curve_value::text from indexer.curve_state`
      expect(state).toMatchObject({
        progress_bps: trade!.progressBpsAfter,
        curve_value: at.realQuote.toString(),
      })
      const [token] = await t.sql`
        select hook, target_raise::text, sale_supply::text from indexer.tokens`
      expect(token).toMatchObject({
        hook: HOOKIT_GRADUATED_FEE_HOOK,
        target_raise: "4200000000000000000",
        sale_supply: at.curveSupply.toString(),
      })
      expect(await t.sql`select trader from indexer.trades`).toEqual([{ trader: f.sender }])
    } finally {
      await t.sql.end()
    }
  })

  it("a drop before a Sold moves the curve and writes no trade", async () => {
    const t = await setup()
    try {
      const f = loadHookitFixture("hookit-drop-sold")
      t.addHistory(f.blockNumber)
      const batch = await t.ingest(f.blockNumber)
      const mine = batch.trades.filter((tr) => tr.txHash === f.txHash)
      // The transaction holds a drop and a sell; only the sell is a trade.
      expect(mine.map((tr) => tr.side)).toEqual(["sell"])
      const [trade] = eventsOf<TradeEvent>(batch, "launchpad.trade").filter(
        (e) => e.txHash === f.txHash,
      )
      // The sell's state includes the drop's tokens, which the sell read at the block reflects.
      const at = f.classic[0]!.at
      expect(Number(BigInt(trade!.curveValue) - at.realQuote)).toBeLessThan(100)
      const [row] = await t.sql`select tokens_sold::text from indexer.hookit_curves`
      expect(row!.tokens_sold).toBe(at.tokensSold.toString())
    } finally {
      await t.sql.end()
    }
  })

  it("the trader is the transaction's sender, not the event's buyer (synthetic)", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-hooc-launch")
      const router: Address = "0x00000000000000000000000000000000000000a9"
      t.chain.senders.get(f.blockNumber)!.senders.set(f.txHash, router)
      const [trade] = eventsOf<TradeEvent>(await t.ingest(f.blockNumber), "launchpad.trade")
      expect(trade!.trader).toBe(router)
      expect((await t.sql`select trader from indexer.trades`)[0]!.trader).toBe(router)
    } finally {
      await t.sql.end()
    }
  })

  it("HOOC's whole history ends at the state launches(1) reports", async () => {
    const t = await setup()
    try {
      const h = t.addHistory(loadHookitHistory().blockNumber)
      const batch = await t.ingest(h.blockNumber)
      const [row] = await t.sql`select tokens_sold::text from indexer.hookit_curves`
      expect(row!.tokens_sold).toBe(h.state.tokensSold.toString())
      const [state] = await t.sql`select curve_value::text from indexer.curve_state`
      // The contract rounds each trade's reserves, so the quote side is within a few wei.
      expect(Number(BigInt(state!.curve_value) - h.state.realQuote)).toBeLessThan(100)
      // Drops are not trades.
      expect(batch.trades).toHaveLength(34 + 25)
    } finally {
      await t.sql.end()
    }
  })

  it("a reload restores the curves, and a later trade continues from them", async () => {
    const t = await setup()
    try {
      const launch = t.seed("hookit-hooc-launch")
      await t.ingest(launch.blockNumber)
      const f = loadHookitFixture("hookit-drop-sold")
      addFixture(t.chain, f)
      await t.source.reload()
      const second = await t.ingest(f.blockNumber, launch.blockNumber + 1n)
      const [row] = await t.sql`select tokens_sold::text from indexer.hookit_curves`
      const curve = launch.classic[0]!.at
      const drop = f.logs.map((l) => decodeHookitLog(l)).find((d) => d?.kind === "drop")!
      const sold = f.logs.map((l) => decodeHookitLog(l)).find((d) => d?.kind === "sold")!
      if (drop.kind !== "drop" || sold.kind !== "sold") throw new Error("fixture")
      const after = curve.tokensSold + drop.tokensOut
      expect(row!.tokens_sold).toBe((after > sold.tokensIn ? after - sold.tokensIn : 0n).toString())
      expect(second.trades).toHaveLength(1)
    } finally {
      await t.sql.end()
    }
  })

  it("a span replayed after a reload does not count its trades twice", async () => {
    const t = await setup()
    try {
      const h = t.addHistory(loadHookitHistory().blockNumber)
      const launchBlock = h.logs.find(
        (l) => decodeHookitLog(l)?.kind === "classicLaunched",
      )!.blockNumber
      await t.ingest(launchBlock)
      await t.ingest(h.blockNumber, launchBlock + 1n)
      const read = async () =>
        (
          await t.sql`
            select h.tokens_sold::text, c.progress_bps
            from indexer.hookit_curves h, indexer.curve_state c`
        )[0]!
      const once = await read()
      expect(once.tokens_sold).toBe(h.state.tokensSold.toString())
      await t.source.reload()
      await t.ingest(h.blockNumber, launchBlock + 1n)
      expect(await read()).toEqual(once)
    } finally {
      await t.sql.end()
    }
  })

  it("a rollback restores the curve state read at the fork", async () => {
    const t = await setup()
    try {
      const launch = t.seed("hookit-hooc-launch")
      await t.ingest(launch.blockNumber)
      const f = loadHookitFixture("hookit-drop-sold")
      addFixture(t.chain, f)
      await t.ingest(f.blockNumber, launch.blockNumber + 1n)
      const at = launch.classic[0]!.at
      t.chain.classicLaunches.set(1n, at)
      await t.rollback(launch.blockNumber)
      const [row] =
        await t.sql`select tokens_sold::text, updated_block::text from indexer.hookit_curves`
      expect(row).toMatchObject({
        tokens_sold: at.tokensSold.toString(),
        updated_block: launch.blockNumber.toString(),
      })
      expect(t.chain.classicLaunchReads.at(-1)).toEqual({ ids: [1n], block: launch.blockNumber })
      const [state] = await t.sql`select curve_value::text from indexer.curve_state`
      expect(state!.curve_value).toBe(at.realQuote.toString())
    } finally {
      await t.sql.end()
    }
  })

  it("after a rollback, the rolled-back span replays onto the restored curve exactly once", async () => {
    const t = await setup()
    try {
      const launch = t.seed("hookit-hooc-launch")
      await t.ingest(launch.blockNumber)
      const f = loadHookitFixture("hookit-drop-sold")
      addFixture(t.chain, f)
      await t.ingest(f.blockNumber, launch.blockNumber + 1n)
      const sold = async () =>
        (await t.sql`select tokens_sold::text from indexer.hookit_curves`)[0]!
      const first = await sold()
      t.chain.classicLaunches.set(1n, launch.classic[0]!.at)
      await t.rollback(launch.blockNumber)
      await t.ingest(f.blockNumber, launch.blockNumber + 1n)
      expect(await sold()).toEqual(first)
    } finally {
      await t.sql.end()
    }
  })

  it("a rollback below a launch removes the token and its curve and reads nothing", async () => {
    const t = await setup()
    try {
      const launch = t.seed("hookit-hooc-launch")
      await t.ingest(launch.blockNumber)
      await t.rollback(launch.blockNumber - 1n)
      expect(await t.sql`select 1 from indexer.hookit_curves`).toEqual([])
      expect(await t.sql`select 1 from indexer.tokens`).toEqual([])
      expect(t.chain.classicLaunchReads.filter((r) => r.block === launch.blockNumber - 1n)).toEqual(
        [],
      )
    } finally {
      await t.sql.end()
    }
  })
})

/** A graduation no chain has produced yet, so every test built on it is synthetic. */
const GRADUATION_BLOCK_AFTER_LAUNCH = 5n
const GRADUATED_SUPPLY = 9n * 10n ** 26n
const SWAP_SENDER: Address = "0x00000000000000000000000000000000000000a9"

function graduationOf(t: Awaited<ReturnType<typeof setup>>) {
  const launch = t.seed("hookit-hooc-launch")
  const { poolKey } = loadHookitPoolKey()
  const token = poolKey.currency1
  const poolId = poolIdOf(poolKey)
  const block = launch.blockNumber + GRADUATION_BLOCK_AFTER_LAUNCH
  const txHash = pad(toHex(0x9ad), { size: 32 }) as Hash
  const log = (over: Partial<ChainLog> = {}): ChainLog => ({
    address: HOOKIT_BONDING_FACTORY,
    topics: [HOOKIT_TOPICS.graduated, pad(toHex(1n), { size: 32 }), poolId],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }],
      [4_200n * 10n ** 15n, 2n * 10n ** 26n, 5n * 10n ** 21n],
    ),
    blockNumber: block,
    blockHash: t.chain.hashOf(block),
    transactionHash: txHash,
    logIndex: 3,
    ...over,
  })
  t.chain.senders.set(block, {
    hash: t.chain.hashOf(block),
    senders: new Map([[txHash, SWAP_SENDER]]),
  })
  t.chain.supplies.set(token, (b) => (b >= block ? GRADUATED_SUPPLY : 10n ** 27n))
  return { launch, token, poolId, poolKey, block, txHash, log }
}

describe("Hookit Classic graduation (synthetic: no launch has graduated yet)", () => {
  it("a synthetic graduation bonds the token and registers a full-range pool whose id hashes from poolKeyOf", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      t.chain.add(g.log())
      await t.ingest(g.launch.blockNumber)
      const batch = await t.ingest(g.block, g.launch.blockNumber + 1n)
      const [bond] = eventsOf<BondEvent>(batch, "launchpad.bond")
      expect(bond).toMatchObject({
        poolId: g.poolId,
        poolManager: UNISWAP_V4_POOL_MANAGER,
        liquidityQuote: "4200000000000000000",
        liquidityTokens: "200000000000000000000000000",
        launchId: pad(g.token, { size: 32 }),
      })
      expect(t.chain.supplyReads.at(-1)).toEqual({ tokens: [g.token], block: g.block })
      const [pool] = await t.sql`
        select pool_id, pool_manager, hook, token_is_currency0, tick_lower, tick_upper, quote_asset, launchpad
        from indexer.pools`
      expect(pool).toEqual({
        pool_id: g.poolId,
        pool_manager: UNISWAP_V4_POOL_MANAGER,
        hook: HOOKIT_GRADUATED_FEE_HOOK,
        token_is_currency0: false,
        tick_lower: null,
        tick_upper: null,
        quote_asset: ETH,
        launchpad: "hookit",
      })
      const [token] = await t.sql`
        select phase, bonded_block::text, total_supply::text, total_supply_block::text from indexer.tokens`
      expect(token).toEqual({
        phase: "bonded",
        bonded_block: g.block.toString(),
        total_supply: GRADUATED_SUPPLY.toString(),
        total_supply_block: g.block.toString(),
      })
      const [state] = await t.sql`select progress_bps from indexer.curve_state`
      expect(state!.progress_bps).toBe(10_000)
      expect(t.pools.byId(g.poolId)?.hook).toBe(HOOKIT_GRADUATED_FEE_HOOK)
    } finally {
      await t.sql.end()
    }
  })

  it("the pool's first swap in the same span is indexed with the graduation supply (synthetic)", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      t.chain.add(g.log())
      await t.ingest(g.launch.blockNumber)
      const sqrtPriceX96 = 2n ** 96n / 1000n
      const swapTx = pad(toHex(0x9ae), { size: 32 }) as Hash
      t.chain.senders.get(g.block)!.senders.set(swapTx, SWAP_SENDER)
      t.chain.add({
        address: UNISWAP_V4_POOL_MANAGER,
        topics: [SWAP_TOPIC, g.poolId, pad(SWAP_SENDER, { size: 32 })],
        data: encodeAbiParameters(
          [
            { type: "int128" },
            { type: "int128" },
            { type: "uint160" },
            { type: "uint128" },
            { type: "int24" },
            { type: "uint24" },
          ],
          [-(10n ** 15n), 10n ** 21n, sqrtPriceX96, 5n * 10n ** 21n, -69_000, 0],
        ),
        blockNumber: g.block,
        blockHash: t.chain.hashOf(g.block),
        transactionHash: swapTx,
        logIndex: 4,
      })
      const { hookit, swaps } = await t.span(g.block, g.launch.blockNumber + 1n)
      expect(eventsOf(hookit, "launchpad.bond")).toHaveLength(1)
      const [swap] = eventsOf<SwapEvent>(swaps, "launchpad.swap")
      expect(swap).toMatchObject({ side: "buy", trader: SWAP_SENDER })
      expect(swap!.marketCap).toBe(poolMarketCap(sqrtPriceX96, false, GRADUATED_SUPPLY).toString())
    } finally {
      await t.sql.end()
    }
  })

  it("a rollback below a synthetic graduation un-bonds the token and removes the pool", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      t.chain.add(g.log())
      await t.ingest(g.launch.blockNumber)
      await t.ingest(g.block, g.launch.blockNumber + 1n)
      t.chain.classicLaunches.set(1n, g.launch.classic[0]!.at)
      await t.rollback(g.block - 1n)
      expect(await t.sql`select 1 from indexer.pools`).toEqual([])
      expect(await t.sql`select 1 from indexer.events where type = 'launchpad.bond'`).toEqual([])
      const [token] = await t.sql`
        select phase, bonded_block, total_supply::text from indexer.tokens`
      expect(token).toEqual({
        phase: "curve",
        bonded_block: null,
        total_supply: (10n ** 27n).toString(),
      })
      const [state] = await t.sql`select progress_bps from indexer.curve_state`
      expect(state!.progress_bps).toBeLessThan(10_000)
      expect(t.pools.poolIds()).toEqual([])
    } finally {
      await t.sql.end()
    }
  })

  it("a synthetic graduation span ingested twice gives identical rows", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      t.chain.add(g.log())
      await t.ingest(g.launch.blockNumber)
      const rows = async () => ({
        tokens:
          await t.sql`select phase, bonded_block::text, total_supply::text, total_supply_block::text from indexer.tokens`,
        pools: await t.sql`select * from indexer.pools`,
        curve: await t.sql`select * from indexer.curve_state`,
        events: await t.sql`select type, payload from indexer.events order by block, log_index`,
      })
      await t.ingest(g.block, g.launch.blockNumber + 1n)
      const once = await rows()
      await t.ingest(g.block, g.launch.blockNumber + 1n)
      expect(await rows()).toEqual(once)
    } finally {
      await t.sql.end()
    }
  })

  it("a synthetic graduation replayed over a newer burn keeps the newer supply", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      t.chain.add(g.log())
      await t.ingest(g.launch.blockNumber)
      await t.ingest(g.block, g.launch.blockNumber + 1n)
      await t.sql`
        update indexer.tokens set total_supply = ${(GRADUATED_SUPPLY - 1n).toString()}, total_supply_block = ${(g.block + 3n).toString()}`
      await t.ingest(g.block, g.launch.blockNumber + 1n)
      const [token] = await t.sql`
        select phase, total_supply::text, total_supply_block::text from indexer.tokens`
      expect(token).toEqual({
        phase: "bonded",
        total_supply: (GRADUATED_SUPPLY - 1n).toString(),
        total_supply_block: (g.block + 3n).toString(),
      })
    } finally {
      await t.sql.end()
    }
  })

  it("a synthetic graduation in the launch's own block leaves the curve constants intact", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      // The graduation is a log of the launch transaction's block, after the seed buy.
      t.chain.add(
        g.log({
          blockNumber: g.launch.blockNumber,
          blockHash: t.chain.hashOf(g.launch.blockNumber),
          transactionHash: g.launch.txHash,
          logIndex: 900,
        }),
      )
      const batch = await t.ingest(g.launch.blockNumber)
      expect(eventsOf(batch, "launchpad.bond")).toHaveLength(1)
      const curve = classicCurveOf(g.launch.classic[0]!.at)
      const [row] = await t.sql`
        select virtual_quote::text, virtual_tokens::text, curve_supply::text from indexer.hookit_curves`
      expect(row).toEqual({
        virtual_quote: curve.vQ0.toString(),
        virtual_tokens: curve.vT0.toString(),
        curve_supply: curve.curveSupply.toString(),
      })
      expect((await t.sql`select progress_bps from indexer.curve_state`)[0]!.progress_bps).toBe(
        10_000,
      )
    } finally {
      await t.sql.end()
    }
  })

  it("a synthetic Graduated for a launch the source has not seen is skipped with the unknown-launch warning", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      t.chain.add(g.log())
      const batch = await t.ingest(g.block, g.launch.blockNumber + 1n)
      expect(batch.events).toEqual([])
      expect(batch.pools).toEqual([])
      expect(t.warnings.map((w) => w.msg)).toEqual([
        "ignoring Hookit curve event for an unknown launch",
      ])
    } finally {
      await t.sql.end()
    }
  })

  it("a synthetic Graduated from another emitter is ignored", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      t.chain.add(g.log({ address: "0x00000000000000000000000000000000000bad01" }))
      await t.ingest(g.launch.blockNumber)
      const batch = await t.ingest(g.block, g.launch.blockNumber + 1n)
      expect(batch.events).toEqual([])
      expect(batch.pools).toEqual([])
      expect(t.warnings.filter((w) => w.msg !== "token metadata not fetched")).toEqual([])
      expect((await t.sql`select phase from indexer.tokens`)[0]!.phase).toBe("curve")
    } finally {
      await t.sql.end()
    }
  })

  it("a synthetic Graduated with truncated data is skipped", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      t.chain.add(g.log({ data: g.log().data.slice(0, 66) as Hash }))
      await t.ingest(g.launch.blockNumber)
      const batch = await t.ingest(g.block, g.launch.blockNumber + 1n)
      expect(batch.events).toEqual([])
      expect(batch.pools).toEqual([])
      expect((await t.sql`select phase from indexer.tokens`)[0]!.phase).toBe("curve")
    } finally {
      await t.sql.end()
    }
  })

  it("a synthetic Graduated whose pool id does not hash from its key still registers the id it names, with a warning", async () => {
    const t = await setup()
    try {
      const g = graduationOf(t)
      const other = pad(toHex(0xabc), { size: 32 }) as Hash
      t.chain.add(g.log({ topics: [HOOKIT_TOPICS.graduated, pad(toHex(1n), { size: 32 }), other] }))
      await t.ingest(g.launch.blockNumber)
      await t.ingest(g.block, g.launch.blockNumber + 1n)
      expect((await t.sql`select pool_id from indexer.pools`)[0]!.pool_id).toBe(other)
      expect(
        t.warnings.map((w) => w.msg).filter((m) => m !== "token metadata not fetched"),
      ).toEqual(["Hookit graduation pool id does not match its pool key"])
    } finally {
      await t.sql.end()
    }
  })
})

describe("Hookit trust and malformed input", () => {
  const retarget = (log: ChainLog, address: Address, logIndex: number): ChainLog => ({
    ...log,
    address,
    logIndex,
    transactionHash: `0x${logIndex.toString(16).padStart(64, "0")}` as Hash,
  })
  const UNKNOWN: Address = "0x00000000000000000000000000000000000bad01"

  it("a TokenLaunched from an unknown contract is ignored with one warning", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-hkt-launch")
      const fake = t.chain.logs.filter((l) => l.address === [...HOOKIT_MASTER_FACTORIES][0])
      t.chain.logs = fake.flatMap((l, i) => [
        retarget(l, UNKNOWN, 100 + 2 * i),
        retarget(l, UNKNOWN, 101 + 2 * i),
      ])
      const batch = await t.ingest(f.blockNumber)
      expect(t.warnings.filter((w) => w.msg === UNKNOWN_WARNING)).toHaveLength(1)
      expect(t.warnings[0]!.fields?.address).toBe(UNKNOWN)
      expect(batch.events).toEqual([])
      expect(batch.tokens).toEqual([])
      expect(batch.pools).toEqual([])
      expect(t.pools.poolIds()).toEqual([])
      expect(await t.sql`select 1 from indexer.tokens`).toEqual([])
    } finally {
      await t.sql.end()
    }
  })

  it("a Classic launch from a Master factory, and a Master launch from the bonding factory, are ignored", async () => {
    const t = await setup()
    try {
      const classic = t.seed("hookit-hooc-launch")
      const master = t.seed("hookit-hkt-launch")
      const master0 = [...HOOKIT_MASTER_FACTORIES][0]!
      t.chain.logs = t.chain.logs.flatMap((l, i) =>
        l.address === HOOKIT_BONDING_FACTORY
          ? [retarget(l, master0, 200 + i)]
          : l.address === master0
            ? [retarget(l, HOOKIT_BONDING_FACTORY, 300 + i)]
            : [],
      )
      const batch = await t.ingest(
        master.blockNumber > classic.blockNumber ? master.blockNumber : classic.blockNumber,
      )
      expect(batch.events).toEqual([])
      expect(batch.trades).toEqual([])
      expect(batch.classic).toEqual([])
    } finally {
      await t.sql.end()
    }
  })

  it("a Bought from an unknown contract is dropped without a warning", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-hooc-launch")
      const bought = t.chain.logs.find((l) => decodeHookitLog(l)?.kind === "bought")!
      t.chain.logs = [retarget(bought, UNKNOWN, 400)]
      const batch = await t.ingest(f.blockNumber)
      expect(batch.events).toEqual([])
      expect(t.warnings).toEqual([])
    } finally {
      await t.sql.end()
    }
  })

  it("a Bought for a launch the source has not seen is skipped with one warning", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-hooc-launch")
      t.chain.logs = t.chain.logs.filter((l) => decodeHookitLog(l)?.kind === "bought")
      const batch = await t.ingest(f.blockNumber)
      expect(batch.trades).toEqual([])
      expect(t.warnings.map((w) => w.msg)).toEqual([
        "ignoring Hookit curve event for an unknown launch",
      ])
    } finally {
      await t.sql.end()
    }
  })

  it("logs with truncated data are skipped and the rest of the span completes", async () => {
    const t = await setup()
    try {
      const f = t.seed("hookit-hooc-launch")
      const launch = loadHookitFixture("hookit-hkt-launch")
      addFixture(t.chain, launch)
      for (const l of [...t.chain.logs]) {
        const d = decodeHookitLog(l)
        if (d && (d.kind === "bought" || d.kind === "masterLaunched"))
          t.chain.add({ ...l, logIndex: l.logIndex + 50, data: l.data.slice(0, 66) as Hash })
      }
      const batch = await t.ingest(
        launch.blockNumber > f.blockNumber ? launch.blockNumber : f.blockNumber,
      )
      expect(batch.events.map((e) => e.event.type).sort()).toEqual([
        "launchpad.launch",
        "launchpad.launch",
        "launchpad.trade",
      ])
    } finally {
      await t.sql.end()
    }
  })
})

describe("Hookit metadata from hostile sources", () => {
  const inline = (body: string) =>
    `data:application/json;base64,${Buffer.from(body).toString("base64")}`
  const URIS: Record<string, string> = {
    "an inline document over 8 KB": inline(JSON.stringify({ description: "x".repeat(9_000) })),
    "base64 that does not decode": "data:application/json;base64,@@@@",
    "a test URI that is not a CID": "ipfs://hookit-test-tst",
    "a creator-supplied https URI": "https://example.com/meta.json",
    "a javascript: image": inline(
      JSON.stringify({ image: "javascript:alert(1)", description: "d" }),
    ),
    "a 3,000-character image URL": inline(
      JSON.stringify({ image: `https://x.example/${"a".repeat(3_000)}`, description: "d" }),
    ),
  }
  for (const [label, uri] of Object.entries(URIS)) {
    it(`${label} gives no image and no fetch`, async () => {
      const calls: string[] = []
      const t = await setup({ fetch: metadataFetch(DOCS, calls) })
      try {
        const f = t.seed("hookit-hkt-launch")
        t.chain.metadataUris.set(f.tokens[0]!.token, uri)
        const [launch] = launchesOf(await t.ingest(f.blockNumber))
        expect(launch!.imageUrl).toBeNull()
        expect(calls).toEqual([])
        expect(launch!.name).toBe("HOOKIT")
      } finally {
        await t.sql.end()
      }
    })
  }

  it("a 2 MB body is refused and the launch is text-only", async () => {
    const big: Fetch = (async () => new Response("x".repeat(2 * 1024 * 1024))) as unknown as Fetch
    const t = await setup({ fetch: big })
    try {
      const f = t.seed("hookit-hkt-launch")
      const [launch] = launchesOf(await t.ingest(f.blockNumber))
      expect(launch).toMatchObject({ description: null, imageUrl: null })
    } finally {
      await t.sql.end()
    }
  })
})

describe("Hookit spans", () => {
  const dumpOf = async (sql: Sql) => ({
    tokens: await sql`select * from indexer.tokens order by address`,
    pools: await sql`select * from indexer.pools order by pool_id`,
    trades: await sql`select * from indexer.trades order by tx_hash, log_index`,
    curves: await sql`select * from indexer.hookit_curves order by token`,
    state: await sql`select * from indexer.curve_state order by token`,
    events: await sql`select type, entity, payload, block from indexer.events order by id`,
  })
  const strip = (rows: Record<string, unknown>) =>
    JSON.parse(json(rows), (k, v) => (k === "created_at" ? undefined : v))

  it("processing the same span twice writes identical rows", async () => {
    const t = await setup()
    try {
      const c = t.seed("hookit-hooc-launch")
      const m = t.seed("hookit-hmu-launch")
      const to = m.blockNumber > c.blockNumber ? m.blockNumber : c.blockNumber
      const first = await t.span(to)
      const a = json(first.hookit)
      // The same span again, as a retry after a failed batch would run it.
      await t.inkypump.reload()
      await t.source.reload()
      const second = await t.span(to)
      expect(json(second.hookit)).toBe(a)
      // Writing the source's rows twice leaves the same tables.
      await t.sql.begin(async (tx) => {
        await t.source.write(tx, first.hookit)
      })
      const once = strip(await dumpOf(t.sql))
      await t.sql.begin(async (tx) => {
        await t.source.write(tx, second.hookit)
      })
      expect(strip(await dumpOf(t.sql))).toEqual(once)
    } finally {
      await t.sql.end()
    }
  })

  it("a backfill span and a live span of the same logs give the same batch", async () => {
    const live = await setup({ live: true })
    const back = await setup({ live: false })
    try {
      const run = async (t: Awaited<ReturnType<typeof setup>>) => {
        const c = t.seed("hookit-hooc-launch")
        const m = t.seed("hookit-inky-launch")
        return json(await t.batchOf(m.blockNumber > c.blockNumber ? m.blockNumber : c.blockNumber))
      }
      expect(await run(back)).toBe(await run(live))
    } finally {
      await live.sql.end()
      await back.sql.end()
    }
  })
})
