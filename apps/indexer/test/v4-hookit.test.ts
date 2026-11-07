import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { SwapEvent } from "@ink-indexer/events"
import {
  DEAD_ADDRESS,
  decodeSwap,
  decodeTransfer,
  HOOKIT_BUYBACK,
  NATIVE_QUOTE_ASSET,
  poolMarketCap,
  poolPrice,
  quoteReserve,
  RIPTIDE_VAULT,
  SWAP_TOPIC,
  TRANSFER_TOPIC,
  ZERO_ADDRESS,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import { describe, expect, inject, it } from "vitest"
import { swapLog, transferLog } from "../../../packages/sdk/test/builders"
import {
  type HookitFixtureName,
  loadHookitFixture,
  loadV4Fixture,
} from "../../../packages/sdk/test/fixtures"
import { Indexer } from "../src/loop"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { writePools } from "../src/sources/inkypump/store"
import { type PoolEntry, PoolRegistry } from "../src/sources/pools"
import { v4Source } from "../src/sources/v4/index"
import { createStore } from "../src/store"
import { FakeChain } from "./fake-chain"
import { addFixture, poolsOfLaunch } from "./hookit-scenario"
import { nextTx, entry as plainEntry, sender } from "./v4-scenario"

const HKT_TOKEN: Address = "0xcf010ba185fd6ee6027b141e2c32614d673f8258"
const HKT_POOL: Hash = "0xdc2f8c6d0a436fd2fb35c1003caf4acb25da7b58bd1475c7039917a30cb3ad59"
const ONE_E27 = 10n ** 27n

const swapsOf = (name: HookitFixtureName) =>
  loadHookitFixture(name).logs.flatMap((l) => {
    const s = decodeSwap(l)
    return s ? [{ log: l, swap: s }] : []
  })

const burnsOf = (name: HookitFixtureName) =>
  loadHookitFixture(name).logs.flatMap((l) => {
    const t = decodeTransfer(l)
    return t?.to === ZERO_ADDRESS ? [{ log: l, value: t.value, from: t.from }] : []
  })

/** Floating-point reserves of a range, independent of the library's tick and price math. */
function reservesByFloat(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
) {
  const lo = 1.0001 ** (tickLower / 2)
  const hi = 1.0001 ** (tickUpper / 2)
  const p = Math.min(Math.max(Number(sqrtPriceX96) / 2 ** 96, lo), hi)
  const l = Number(liquidity)
  return { amount0: l * (1 / p - 1 / hi), amount1: l * (p - lo) }
}

const near = (actual: string | bigint, expected: number, relative = 1e-6) => {
  const a = Number(actual)
  expect(Math.abs(a - expected) / expected, `${a} against ${expected}`).toBeLessThan(relative)
}

/** A Hookit launch's pools in a registry with the token's supply read at `supplyBlock`. */
function setup(
  launch: HookitFixtureName,
  a: {
    supply?: bigint
    supplyBlock: bigint
    head?: bigint
    /** False leaves the dead balance unread, as for a token a process loads without one. */
    deadRead?: boolean
    mutate?: (p: PoolEntry) => PoolEntry
  },
) {
  const entries = poolsOfLaunch(launch).map((p) => a.mutate?.(p) ?? p)
  const chain = new FakeChain(a.head ?? 61_000_000n)
  const pools = new PoolRegistry()
  const token = entries[0]!.token
  for (const p of entries) pools.add(p, a.supply ?? ONE_E27, a.supplyBlock)
  if (a.deadRead !== false) pools.setDead(token, 0n, a.supplyBlock)
  const source = v4Source({ sql: {} as Sql, chain, logger: () => {}, pools })
  /** Processes [from, to] as the live tick's span. */
  const run = (to: bigint, from = 0n) =>
    source.process(
      source.filters().map((f) => (f ? chain.logsIn(from, to, f) : [])),
      { toBlock: to, live: true },
    )
  return { chain, pools, source, run, entries, token }
}

const eventsOf = (batch: { events: { event: unknown }[] }) =>
  batch.events.map((e) => e.event as SwapEvent)

describe("v4 source: Hookit hook swaps", () => {
  const first = loadHookitFixture("hookit-hkt-first-swap")
  const sell = loadHookitFixture("hookit-hkt-sell")
  const [routerSwap, hookSwapA, hookSwapB] = swapsOf("hookit-hkt-first-swap")
  const [burn] = burnsOf("hookit-hkt-first-swap")

  it("the first $HKT swap transaction writes one swap, not three; its pool state and the next swap's price include the hook buys", async () => {
    const t = setup("hookit-hkt-launch", { supplyBlock: first.blockNumber - 1n })
    addFixture(t.chain, first)
    addFixture(t.chain, sell)
    const batch = await t.run(sell.blockNumber)
    const [one, next] = eventsOf(batch)
    expect(batch.events).toHaveLength(2)
    expect(batch.trades).toHaveLength(2)
    // The user's own swap, with the router as the caller and the transaction's sender as the trader.
    expect(one).toMatchObject({
      type: "launchpad.swap",
      launchpad: "hookit",
      token: HKT_TOKEN,
      poolId: HKT_POOL,
      side: "buy",
      trader: first.sender,
      router: routerSwap!.swap.sender,
      quoteAsset: NATIVE_QUOTE_ASSET,
      quoteAmount: String(-routerSwap!.swap.amount0),
      tokenAmount: String(routerSwap!.swap.amount1),
      logIndex: routerSwap!.log.logIndex,
    })
    // The event is the user's own swap at its own post-swap state. The hook's buys after it and the
    // burn between them are not folded into it, and they do not raise the ath.
    expect(one!.supply).toBe(String(ONE_E27))
    expect(one!.price).toBe(String(poolPrice(routerSwap!.swap.sqrtPriceX96, false)))
    expect(one!.marketCap).toBe(
      String(poolMarketCap(routerSwap!.swap.sqrtPriceX96, false, ONE_E27)),
    )
    expect(one!.athMarketCap).toBe(one!.marketCap)
    // The recorded supply after the transaction holds exactly that burn.
    const supplyAfterBurn = ONE_E27 - burn!.value
    expect(first.tokens[0]!.totalSupply).toBe(supplyAfterBurn)
    expect(hookSwapA!.swap.sender).toBe(burn!.from)
    expect(hookSwapB!.swap.sender).toBe(burn!.from)

    // The next swap carries the pool state the hook buys left and the lowered supply.
    const [sellSwap] = swapsOf("hookit-hkt-sell")
    const [sellBurn] = burnsOf("hookit-hkt-sell")
    expect(next).toMatchObject({ side: "sell", trader: sell.sender, router: sellSwap!.swap.sender })
    expect(next!.supply).toBe(String(supplyAfterBurn))
    expect(sellBurn!.value).toBeGreaterThan(0n)
    expect(next!.price).toBe(String(poolPrice(sellSwap!.swap.sqrtPriceX96, false)))
    // One sender read per block that holds a user swap.
    expect(t.chain.getBlockSendersCalls).toBe(2)
  })

  it("a swap by the pool's own hook with no swap before it in the transaction writes nothing and reads no block", async () => {
    const t = setup("hookit-hkt-launch", { supplyBlock: first.blockNumber - 1n })
    addFixture(t.chain, first, (l) => decodeSwap(l)?.sender !== routerSwap!.swap.sender)
    const batch = await t.run(first.blockNumber)
    expect(batch.events).toEqual([])
    expect(batch.trades).toEqual([])
    expect(batch.ath).toEqual([])
    expect(t.pools.marks(HKT_TOKEN)?.ath).toBe(0n)
    expect(t.chain.getBlockSendersCalls).toBe(0)
  })

  it("a swap by the hook of a pool that is not a Hookit pool is a swap like any other (synthetic)", async () => {
    const t = setup("hookit-hkt-launch", {
      supplyBlock: first.blockNumber - 1n,
      mutate: (p) => ({ ...p, launchpad: "tsunami" }),
    })
    addFixture(t.chain, first)
    const batch = await t.run(first.blockNumber)
    expect(batch.events).toHaveLength(3)
    expect(batch.trades).toHaveLength(3)
  })

  it("a HkitBuyback swap is a trade whose trader is the buyback contract", async () => {
    const f = loadHookitFixture("hookit-hkt-buyback")
    const t = setup("hookit-hkt-launch", { supplyBlock: f.blockNumber - 1n })
    addFixture(t.chain, f)
    const batch = await t.run(f.blockNumber)
    const [buyback] = swapsOf("hookit-hkt-buyback")
    expect(buyback!.swap.sender).toBe(HOOKIT_BUYBACK)
    // The buyback's own swap is the one trade; the hook's three buys after it are not.
    expect(batch.events).toHaveLength(1)
    expect(batch.trades).toEqual([
      {
        txHash: f.txHash,
        logIndex: buyback!.log.logIndex,
        token: HKT_TOKEN,
        poolId: HKT_POOL,
        side: "buy",
        trader: HOOKIT_BUYBACK,
        amountIn: -buyback!.swap.amount0,
        amountOut: buyback!.swap.amount1,
        block: f.blockNumber,
      },
    ])
  })

  it("a HkitBuyback swap's trader is the buyback contract, not $HKT's creator", async () => {
    const f = loadHookitFixture("hookit-hkt-buyback")
    const t = setup("hookit-hkt-launch", { supplyBlock: f.blockNumber - 1n })
    addFixture(t.chain, f)
    const [ev] = eventsOf(await t.run(f.blockNumber))
    // $HKT's creator sent the transaction.
    expect(f.sender).toBe("0x93a00f2977e82ff72b487820e50ecf5c7a99e855")
    expect(ev!.trader).toBe(HOOKIT_BUYBACK)
    expect(ev!.trader).not.toBe(f.sender)
  })

  it("a trader the registry holds for a transaction replaces the sender for the swaps of the contract it names", async () => {
    const f = loadHookitFixture("hookit-inky-launch")
    const t = setup("hookit-inky-launch", { supplyBlock: f.blockNumber - 1n })
    addFixture(t.chain, f)
    const buyer: Address = "0x00000000000000000000000000000000000000b7"
    const via: Address = "0x99c6f8921858660881186296c39a07d1b30dc039"
    t.pools.setTraderOf(f.txHash, buyer, via)
    const batch = await t.run(f.blockNumber)
    // Only the swap the named contract made takes the registry's trader; the others keep the sender.
    const mine = eventsOf(batch).filter((e) => e.trader === buyer)
    expect(mine).toHaveLength(1)
    expect(
      eventsOf(batch)
        .filter((e) => e.trader !== buyer)
        .every((e) => e.trader === f.sender),
    ).toBe(true)
  })

  it("a swap by another contract in the same transaction keeps the transaction's sender (synthetic)", async () => {
    const f = loadHookitFixture("hookit-inky-launch")
    const t = setup("hookit-inky-launch", { supplyBlock: f.blockNumber - 1n })
    addFixture(t.chain, f)
    const buyer: Address = "0x00000000000000000000000000000000000000b7"
    const factory: Address = "0x99c6f8921858660881186296c39a07d1b30dc039"
    t.pools.setTraderOf(f.txHash, buyer, factory)
    const swap = t.chain.logs.find(
      (l) => l.topics[0] === SWAP_TOPIC && l.topics[2]!.endsWith(factory.slice(2)),
    )!
    const router = `0x${"0".repeat(24)}00000000000000000000000000000000000000a9`
    t.chain.add({
      ...swap,
      logIndex: swap.logIndex + 100,
      topics: [swap.topics[0]!, swap.topics[1]!, router as Hash],
    })
    const traders = eventsOf(await t.run(f.blockNumber)).map((e) => e.trader)
    expect(traders.sort()).toEqual([buyer, f.sender].sort())
  })

  it("a malformed Swap log is skipped and the span still completes", async () => {
    const t = setup("hookit-hkt-launch", { supplyBlock: first.blockNumber - 1n })
    addFixture(t.chain, first)
    t.chain.add({ ...routerSwap!.log, logIndex: 99, data: "0x1234" })
    const batch = await t.run(first.blockNumber)
    expect(batch.events).toHaveLength(1)
  })
})

describe("v4 source: Hookit liquidity", () => {
  it("$HKT's swap carries the in-range quote and token liquidity", async () => {
    const first = loadHookitFixture("hookit-hkt-first-swap")
    const t = setup("hookit-hkt-launch", { supplyBlock: first.blockNumber - 1n })
    addFixture(t.chain, first)
    const [ev] = eventsOf(await t.run(first.blockNumber))
    const last = swapsOf("hookit-hkt-first-swap")[0]!.swap
    const want = reservesByFloat(last.sqrtPriceX96, last.liquidity, -887220, 201240)
    // ETH is currency0 and the token currency1.
    near(ev!.quoteLiquidity, want.amount0)
    near(ev!.tokenLiquidity!, want.amount1)
    // Across the launch's range the quote side is a fraction of what the full-range formula gives.
    const full = quoteReserve(last.liquidity, last.sqrtPriceX96, false)
    expect(BigInt(ev!.quoteLiquidity) * 5n).toBeLessThan(full)
  })

  it("the INKY USDG swap is in 6-decimal units", async () => {
    const f = loadHookitFixture("hookit-inky-usdg-wmstrx")
    const t = setup("hookit-inky-launch", { supplyBlock: f.blockNumber - 1n })
    addFixture(t.chain, f)
    const evs = eventsOf(await t.run(f.blockNumber))
    const usdgPool = t.entries.find((p) => p.tokenIsCurrency0)!
    const usdg = evs.find((e) => e.poolId === usdgPool.poolId)!
    const wmstrx = evs.find((e) => e.poolId !== usdgPool.poolId)!
    const inkySwaps = swapsOf("hookit-inky-usdg-wmstrx").filter(
      (x) => x.swap.poolId === usdgPool.poolId,
    )
    const userSell = inkySwaps[0]!
    const hookLast = userSell
    expect(usdg.quoteAsset).toBe(usdgPool.quoteAsset)
    // $3.099425 for 615,304.96 tokens.
    expect(usdg).toMatchObject({
      side: "sell",
      quoteAmount: "3099425",
      tokenAmount: "615304963013777292708083",
    })
    expect(userSell!.swap.amount1).toBe(3099425n)
    // The price is USDG base units per 1e18 tokens: a few millionths of a dollar is a few units.
    expect(usdg.price).toBe(String(poolPrice(hookLast!.swap.sqrtPriceX96, true)))
    expect(Number(usdg.price)).toBeGreaterThan(1)
    expect(Number(usdg.price)).toBeLessThan(100)
    // About a billion tokens at that price is thousands of dollars, in millionths.
    const dollars = BigInt(usdg.marketCap) / 10n ** 6n
    expect(dollars).toBeGreaterThan(1_000n)
    expect(dollars).toBeLessThan(100_000n)
    // The quote side sits in currency1 for a pool whose token is currency0: the range runs above the lower tick.
    const want = reservesByFloat(
      hookLast!.swap.sqrtPriceX96,
      hookLast!.swap.liquidity,
      -398340,
      887220,
    )
    near(usdg.quoteLiquidity, want.amount1, 1e-4)
    near(usdg.tokenLiquidity!, want.amount0, 1e-4)
    // The wMSTRx leg of the same transaction is in 18-decimal units.
    expect(wmstrx).toMatchObject({ side: "buy", quoteAmount: "21884749568558284" })
  })

  it("the A18 wMSTRx swap has the token as currency1 and the right side", async () => {
    const launch = loadHookitFixture("hookit-a18-launch")
    const f = loadHookitFixture("hookit-stock-pool-swap")
    const t = setup("hookit-a18-launch", { supplyBlock: f.blockNumber - 1n })
    expect(launch.tokens[0]!.token).toBe(f.tokens[0]!.token)
    expect(t.entries[0]!.tokenIsCurrency0).toBe(false)
    addFixture(t.chain, f)
    const [ev] = eventsOf(await t.run(f.blockNumber))
    const [user] = swapsOf("hookit-stock-pool-swap")
    const hookLast = user
    // The swapper receives wMSTRx (currency0) and pays the token: a sell.
    expect(user!.swap.amount0).toBeGreaterThan(0n)
    expect(ev).toMatchObject({
      side: "sell",
      quoteAsset: t.entries[0]!.quoteAsset,
      quoteAmount: String(user!.swap.amount0),
      tokenAmount: String(-user!.swap.amount1),
    })
    expect(ev!.price).toBe(String(poolPrice(hookLast!.swap.sqrtPriceX96, false)))
    const want = reservesByFloat(
      hookLast!.swap.sqrtPriceX96,
      hookLast!.swap.liquidity,
      -887220,
      171720,
    )
    near(ev!.quoteLiquidity, want.amount0)
    near(ev!.tokenLiquidity!, want.amount1)
  })

  it("an InkyPump pool's liquidity is unchanged and carries no token side", async () => {
    const f = loadV4Fixture("v4-inkypump-buy")
    const logged = f.logs.find((l) => decodeSwap(l) !== null)!
    const decoded = decodeSwap(logged)!
    const token = f.logs.find((l) => l.address !== decoded.sender && decodeTransfer(l))!.address
    const chain = new FakeChain(f.blockNumber + 10n)
    const pools = new PoolRegistry()
    pools.add({ ...plainEntry(9), poolId: decoded.poolId, token }, ONE_E27)
    pools.setDead(token, 0n, f.blockNumber - 5n)
    const source = v4Source({ sql: {} as Sql, chain, logger: () => {}, pools })
    for (const l of f.logs) chain.add(l)
    chain.senders.set(f.blockNumber, {
      hash: chain.hashOf(f.blockNumber),
      senders: new Map(Object.entries(f.senders) as [Hash, Address][]),
    })
    const batch = await source.process(
      source.filters().map((flt) => (flt ? chain.logsIn(f.blockNumber, f.blockNumber, flt) : [])),
      { toBlock: f.blockNumber, live: false },
    )
    const [ev] = eventsOf(batch)
    expect(ev!.quoteLiquidity).toBe(
      String(quoteReserve(decoded.liquidity, decoded.sqrtPriceX96, false)),
    )
    expect(ev!.quoteLiquidity).toBe(GOLDEN_INKYPUMP_LIQUIDITY)
    expect(ev).not.toHaveProperty("tokenLiquidity")
  })
})

const GOLDEN_INKYPUMP_LIQUIDITY = "2940999000000000023"

describe("v4 source: Hookit burns", () => {
  const first = loadHookitFixture("hookit-hkt-first-swap")
  const sell = loadHookitFixture("hookit-hkt-sell")
  const [burn1] = burnsOf("hookit-hkt-first-swap")
  const [burn2] = burnsOf("hookit-hkt-sell")

  it("the burn filter takes transfers to the dead and zero addresses in one request", () => {
    const t = setup("hookit-hkt-launch", { supplyBlock: first.blockNumber })
    const filters = t.source.filters()
    expect(filters).toHaveLength(2)
    expect(filters[1]!.topics).toEqual([
      TRANSFER_TOPIC,
      null,
      [`0x${"0".repeat(60)}dead`, `0x${"0".repeat(64)}`],
    ])
  })

  it("a burn to 0x0 lowers a Hookit token's supply from the next swap", async () => {
    const t = setup("hookit-hkt-launch", { supplyBlock: first.blockNumber - 1n })
    addFixture(t.chain, first)
    addFixture(t.chain, sell)
    const batch = await t.run(sell.blockNumber)
    // The recorded supply after the first transaction is the supply before it less its burn.
    expect(first.tokens[0]!.totalSupplyBefore).toBe(ONE_E27)
    expect(first.tokens[0]!.totalSupply).toBe(ONE_E27 - burn1!.value)
    const [, next] = eventsOf(batch)
    // The sell's own burn comes after its swap, so the next swap after that sees it.
    expect(next!.supply).toBe(String(ONE_E27 - burn1!.value))
    expect(t.pools.marks(HKT_TOKEN)).toMatchObject({
      totalSupply: ONE_E27 - burn1!.value - burn2!.value,
      supplyBlock: sell.blockNumber,
    })
    expect(batch.supply).toEqual([
      {
        token: HKT_TOKEN,
        totalSupply: ONE_E27 - burn1!.value - burn2!.value,
        block: sell.blockNumber,
      },
    ])
    // The market cap of the next swap is on the lowered supply, outside no dead balance.
    expect(next!.marketCap).toBe(
      String(
        poolMarketCap(
          swapsOf("hookit-hkt-sell")[0]!.swap.sqrtPriceX96,
          false,
          BigInt(next!.supply),
        ),
      ),
    )
  })

  it("a burn at the supply-read block is not counted again", async () => {
    // The supply was read at the block of the burn, so it already holds the burn.
    const t = setup("hookit-hkt-launch", {
      supply: first.tokens[0]!.totalSupply,
      supplyBlock: first.blockNumber,
    })
    addFixture(t.chain, first)
    addFixture(t.chain, sell)
    const batch = await t.run(first.blockNumber)
    expect(batch.supply).toEqual([])
    expect(t.pools.marks(HKT_TOKEN)?.totalSupply).toBe(first.tokens[0]!.totalSupply)
    expect(eventsOf(batch)[0]!.supply).toBe(String(first.tokens[0]!.totalSupply))
    // The burn of a later block still counts.
    const later = await t.run(sell.blockNumber, first.blockNumber + 1n)
    expect(t.pools.marks(HKT_TOKEN)?.totalSupply).toBe(first.tokens[0]!.totalSupply - burn2!.value)
    expect(later.supply).toHaveLength(1)
  })

  it("a burn after the supply was read in the same block is counted (synthetic)", async () => {
    const t = setup("hookit-hkt-launch", { supplyBlock: first.blockNumber })
    addFixture(t.chain, first)
    const burnAfter = transferLog(
      { from: HKT_TOKEN, to: ZERO_ADDRESS, value: 5n },
      {
        address: HKT_TOKEN,
        blockNumber: first.blockNumber + 1n,
        transactionHash: nextTx(),
        logIndex: 1,
      },
    )
    t.chain.add(burnAfter)
    t.chain.add({ ...burnAfter, logIndex: 2 })
    const batch = await t.run(first.blockNumber + 1n, first.blockNumber + 1n)
    expect(batch.supply).toEqual([
      { token: HKT_TOKEN, totalSupply: ONE_E27 - 10n, block: first.blockNumber + 1n },
    ])
  })

  it("a Riptide burn to 0x0 leaves the Tsunami token's supply alone (synthetic)", async () => {
    const chain = new FakeChain(60_000n)
    const pools = new PoolRegistry()
    const token: Address = "0x00000000000000000000000000000000000000d1"
    pools.add({ ...plainEntry(4), token, launchpad: "tsunami" }, ONE_E27, 1n)
    pools.setDead(token, 0n, 1n)
    const source = v4Source({ sql: {} as Sql, chain, logger: () => {}, pools })
    chain.add(
      transferLog(
        { from: RIPTIDE_VAULT, to: ZERO_ADDRESS, value: 10n ** 24n },
        { address: token, blockNumber: 100n, transactionHash: nextTx(), logIndex: 0 },
      ),
    )
    const batch = await source.process(
      source.filters().map((f) => (f ? chain.logsIn(0n, 100n, f) : [])),
      { toBlock: 100n, live: true },
    )
    expect(batch.supply).toEqual([])
    expect(batch.dead).toEqual([])
    expect(batch.blocks).toEqual([])
    expect(pools.marks(token)).toMatchObject({ totalSupply: ONE_E27, supplyBlock: 1n })
    expect(chain.supplyReads).toEqual([])
  })

  it("a dead-address transfer still counts", async () => {
    const f = loadHookitFixture("hookit-dead-transfer")
    const dead = decodeTransfer(f.logs[0]!)!
    expect(dead.to).toBe(DEAD_ADDRESS)
    const token = f.tokens[0]!.token
    const chain = new FakeChain(f.blockNumber + 10n)
    const pools = new PoolRegistry()
    pools.add(
      {
        ...poolsOfLaunch("hookit-hkt-launch")[0]!,
        token,
        launchId: `0x${"00".repeat(12)}${token.slice(2)}`,
      },
      f.tokens[0]!.totalSupply,
      f.blockNumber - 1n,
    )
    pools.setDead(token, 0n, f.blockNumber - 1n)
    const source = v4Source({ sql: {} as Sql, chain, logger: () => {}, pools })
    addFixture(chain, f)
    const batch = await source.process(
      source.filters().map((flt) => (flt ? chain.logsIn(0n, f.blockNumber, flt) : [])),
      { toBlock: f.blockNumber, live: true },
    )
    expect(batch.dead).toEqual([{ token, balance: dead.value, block: f.blockNumber }])
    expect(batch.supply).toEqual([])
    expect(pools.marks(token)?.totalSupply).toBe(f.tokens[0]!.totalSupply)
  })

  it("a burn larger than the supply leaves it at zero (synthetic)", async () => {
    const t = setup("hookit-hkt-launch", { supply: 5n, supplyBlock: first.blockNumber - 1n })
    addFixture(t.chain, first)
    const batch = await t.run(first.blockNumber)
    expect(batch.supply).toEqual([{ token: HKT_TOKEN, totalSupply: 0n, block: first.blockNumber }])
  })

  it("a malformed or ERC-721 shaped Transfer to 0x0 is skipped and the span completes (synthetic)", async () => {
    const t = setup("hookit-hkt-launch", { supplyBlock: first.blockNumber - 1n })
    addFixture(t.chain, first)
    const real = first.logs.find((l) => decodeTransfer(l)?.to === ZERO_ADDRESS)!
    t.chain.add({ ...real, logIndex: 90, data: "0x" })
    t.chain.add({ ...real, logIndex: 91, topics: [...real.topics, `0x${"0".repeat(63)}1`] })
    const batch = await t.run(first.blockNumber)
    expect(batch.supply).toEqual([
      { token: HKT_TOKEN, totalSupply: ONE_E27 - burn1!.value, block: first.blockNumber },
    ])
  })

  it("a Hookit token this process starts following has its supply read again at the span's read block", async () => {
    const t = setup("hookit-hkt-launch", {
      supply: 7n * 10n ** 26n,
      supplyBlock: 10n,
      deadRead: false,
    })
    addFixture(t.chain, first)
    t.chain.supplies.set(HKT_TOKEN, first.tokens[0]!.totalSupply)
    await t.source.reload()
    const batch = await t.run(first.blockNumber)
    expect(t.chain.supplyReads).toEqual([{ tokens: [HKT_TOKEN], block: first.blockNumber }])
    // The burn is in the value read at its own block, so it is not taken off again.
    expect(batch.supply).toEqual([
      { token: HKT_TOKEN, totalSupply: first.tokens[0]!.totalSupply, block: first.blockNumber },
    ])
    expect(eventsOf(batch)[0]!.supply).toBe(String(first.tokens[0]!.totalSupply))
    // A later span does not read it again.
    await t.source.reload()
    await t.run(first.blockNumber + 1n, first.blockNumber + 1n)
    expect(t.chain.supplyReads).toHaveLength(1)
  })

  it("a Hookit token with no supply block has its supply read, other tokens' are not", async () => {
    const t = setup("hookit-hkt-launch", { supplyBlock: 10n })
    t.pools.add(plainEntry(3), ONE_E27)
    t.pools.setDead(plainEntry(3).token, 0n, 10n)
    t.pools.setSupply(HKT_TOKEN, ONE_E27, 10n)
    t.pools.add(
      { ...t.entries[0]!, poolId: `0x${"0f".repeat(32)}`, token: plainEntry(5).token },
      ONE_E27,
    )
    await t.run(50n)
    expect(t.chain.supplyReads).toEqual([{ tokens: [plainEntry(5).token], block: 50n }])
  })
})

describe("v4 source: Hookit markets", () => {
  it("HMU's split buy gives two swaps in wAMZNx and wNVDAx units, each against its own pool's ath", async () => {
    const f = loadHookitFixture("hookit-hmu-split")
    const t = setup("hookit-hmu-launch", { supplyBlock: f.blockNumber - 1n })
    const [wAmzn, wNvda] = [
      t.entries.find((p) => p.quoteAsset.startsWith("0x910c"))!,
      t.entries.find((p) => p.quoteAsset.startsWith("0xa8dd"))!,
    ]
    addFixture(t.chain, f)
    // The larger raw number sits in the other pool and must not reach this pool's ath.
    t.pools.bumpAth(t.token, 10n ** 40n, f.blockNumber - 1n, wAmzn.poolId)
    const batch = await t.run(f.blockNumber)
    const evs = eventsOf(batch)
    expect(evs).toHaveLength(2)
    const [a, n] = [
      evs.find((e) => e.poolId === wAmzn.poolId)!,
      evs.find((e) => e.poolId === wNvda.poolId)!,
    ]
    const swaps = swapsOf("hookit-hmu-split")
    expect(a).toMatchObject({
      quoteAsset: wAmzn.quoteAsset,
      side: "buy",
      quoteAmount: String(-swaps.find((s) => s.swap.poolId === wAmzn.poolId)!.swap.amount0),
      athMarketCap: String(10n ** 40n),
    })
    expect(n).toMatchObject({
      quoteAsset: wNvda.quoteAsset,
      side: "buy",
      quoteAmount: String(-swaps.find((s) => s.swap.poolId === wNvda.poolId)!.swap.amount0),
      athMarketCap: n.marketCap,
    })
    // Each pool's ath is kept apart: only the pool that rose is reported, with its pool id.
    expect(batch.ath).toEqual([
      {
        token: t.token,
        poolId: wNvda.poolId,
        marketCap: BigInt(n.marketCap),
        block: f.blockNumber,
      },
    ])
    expect(t.pools.poolMarks(wAmzn.poolId)?.ath).toBe(10n ** 40n)
    expect(t.pools.marks(t.token)?.ath).toBe(0n)
    expect(batch.trades.map((tr) => tr.poolId).sort()).toEqual([wAmzn.poolId, wNvda.poolId].sort())
  })
})

describe("v4 source: Hookit state through the database", () => {
  async function db(launch: HookitFixtureName, supplyBlock: bigint, supply = ONE_E27) {
    const sql: Sql = await resetDb(inject("databaseUrl"))
    const entries = poolsOfLaunch(launch)
    await seedToken(sql, entries, supplyBlock, supply)
    const chain = new FakeChain(61_000_000n)
    const pools = new PoolRegistry()
    await pools.load(sql)
    const source = v4Source({ sql, chain, logger: () => {}, pools })
    const ink = inkypumpSource({ sql, chain, logger: () => {}, pools })
    const store = createStore(sql)
    const ingest = async (from: bigint, to: bigint) => {
      const batch = await source.process(
        source.filters().map((f) => (f ? chain.logsIn(from, to, f) : [])),
        { toBlock: to, live: true },
      )
      await store.writeBatch([batch], [(tx) => source.write(tx, batch)], {
        cursor: { block: to, hash: chain.hashOf(to) },
        head: to,
      })
      return batch
    }
    return { sql, chain, pools, source, ink, store, entries, ingest }
  }

  it("pool rows carry the hook and the tick range of a Hookit pool and nothing for other pools", async () => {
    const { sql, entries } = await db("hookit-hmu-launch", 56_521_187n)
    try {
      await seedToken(sql, [plainEntry(1)], 1n, 1000n, "inkypump")
      const rows =
        await sql`select pool_id, hook, tick_lower, tick_upper from indexer.pools order by pool_id`
      expect(rows).toHaveLength(entries.length + 1)
      for (const p of entries)
        expect(rows.find((r) => r.pool_id === p.poolId)).toMatchObject({
          hook: p.hook,
          tick_lower: p.tickLower,
          tick_upper: p.tickUpper,
        })
      expect(rows.find((r) => r.pool_id === plainEntry(1).poolId)).toMatchObject({
        hook: null,
        tick_lower: null,
        tick_upper: null,
      })
    } finally {
      await sql.end()
    }
  })

  it("a multi-market token's ath is written per pool and read back, so a reload bumps nothing twice", async () => {
    const f = loadHookitFixture("hookit-hmu-split")
    const t = await db("hookit-hmu-launch", f.blockNumber - 1n)
    try {
      addFixture(t.chain, f)
      const batch = await t.ingest(f.blockNumber, f.blockNumber)
      expect(batch.ath).toHaveLength(2)
      const stored = await t.sql`
        select pool_id, ath_market_cap::text as ath, ath_block from indexer.pools
        where ath_market_cap is not null order by pool_id`
      expect(stored).toEqual(
        batch.ath
          .map((a) => ({ pool_id: a.poolId, ath: String(a.marketCap), ath_block: a.block }))
          .sort((x, y) => (x.pool_id! < y.pool_id! ? -1 : 1)),
      )
      expect(
        await t.sql`select ath_market_cap from indexer.tokens where address = ${t.entries[0]!.token}`,
      ).toEqual([{ ath_market_cap: null }])

      // A new process loads each pool's ath and sees the same span again: nothing rises.
      const reloaded = new PoolRegistry()
      await reloaded.load(t.sql)
      for (const a of batch.ath)
        expect(reloaded.poolMarks(a.poolId!)).toEqual({ ath: a.marketCap, athBlock: a.block })
      const again = v4Source({ sql: t.sql, chain: t.chain, logger: () => {}, pools: reloaded })
      const second = await again.process(
        again.filters().map((flt) => (flt ? t.chain.logsIn(0n, f.blockNumber, flt) : [])),
        { toBlock: f.blockNumber, live: true },
      )
      expect(second.ath).toEqual([])
      expect(eventsOf(second)).toEqual(eventsOf(batch))
    } finally {
      await t.sql.end()
    }
  })

  it("a single-market token's ath stays on the token row", async () => {
    const first = loadHookitFixture("hookit-hkt-first-swap")
    const t = await db("hookit-hkt-launch", first.blockNumber - 1n)
    try {
      addFixture(t.chain, first)
      const batch = await t.ingest(first.blockNumber, first.blockNumber)
      expect(batch.ath).toHaveLength(1)
      expect(batch.ath[0]).not.toHaveProperty("poolId")
      expect(await t.sql`select ath_market_cap::text as ath from indexer.tokens`).toEqual([
        { ath: String(batch.ath[0]!.marketCap) },
      ])
      expect(await t.sql`select ath_market_cap from indexer.pools`).toEqual([
        { ath_market_cap: null },
      ])
    } finally {
      await t.sql.end()
    }
  })

  it("a pool's stored ath never moves down", async () => {
    const f = loadHookitFixture("hookit-hmu-split")
    const t = await db("hookit-hmu-launch", f.blockNumber - 1n)
    try {
      const pool = t.entries[0]!.poolId
      const write = (marketCap: bigint, block: bigint) =>
        t.sql.begin((tx) =>
          t.source.write(tx, {
            trades: [],
            events: [],
            ath: [{ token: t.entries[0]!.token, poolId: pool, marketCap, block }],
            dead: [],
            supply: [],
            blocks: [],
          }),
        )
      const stored = () =>
        t.sql`select ath_market_cap::text as ath, ath_block from indexer.pools where pool_id = ${pool}`
      await write(50n, 10n)
      await write(20n, 11n)
      expect(await stored()).toEqual([{ ath: "50", ath_block: 10n }])
      await write(70n, 12n)
      expect(await stored()).toEqual([{ ath: "70", ath_block: 12n }])
    } finally {
      await t.sql.end()
    }
  })

  it("a total supply never moves back to an older block", async () => {
    const t = await db("hookit-hkt-launch", 100n)
    try {
      const write = (totalSupply: bigint, block: bigint) =>
        t.sql.begin((tx) =>
          t.source.write(tx, {
            trades: [],
            events: [],
            ath: [],
            dead: [],
            supply: [{ token: HKT_TOKEN, totalSupply, block }],
            blocks: [],
          }),
        )
      const stored = () =>
        t.sql`select total_supply::text as supply, total_supply_block as block from indexer.tokens`
      await write(900n, 200n)
      await write(950n, 150n)
      expect(await stored()).toEqual([{ supply: "900", block: 200n }])
      await write(890n, 200n)
      expect(await stored()).toEqual([{ supply: "890", block: 200n }])
      await write(800n, 210n)
      expect(await stored()).toEqual([{ supply: "800", block: 210n }])
    } finally {
      await t.sql.end()
    }
  })

  it("the supply a burn leaves is stored with its block", async () => {
    const first = loadHookitFixture("hookit-hkt-first-swap")
    const t = await db("hookit-hkt-launch", first.blockNumber - 1n)
    try {
      addFixture(t.chain, first)
      await t.ingest(first.blockNumber, first.blockNumber)
      expect(
        await t.sql`select total_supply::text as supply, total_supply_block as block from indexer.tokens`,
      ).toEqual([{ supply: String(first.tokens[0]!.totalSupply), block: first.blockNumber }])
    } finally {
      await t.sql.end()
    }
  })

  it("a rollback below a burn reads the supply again at the fork, and below a swap restores each pool's ath", async () => {
    const first = loadHookitFixture("hookit-hkt-first-swap")
    const sell = loadHookitFixture("hookit-hkt-sell")
    const t = await db("hookit-hkt-launch", first.blockNumber - 1n)
    try {
      addFixture(t.chain, first)
      addFixture(t.chain, sell)
      const [burn1] = burnsOf("hookit-hkt-first-swap")
      t.chain.supplies.set(HKT_TOKEN, (block) =>
        block >= first.blockNumber ? ONE_E27 - burn1!.value : ONE_E27,
      )
      await t.ingest(first.blockNumber, first.blockNumber)
      await t.ingest(first.blockNumber + 1n, sell.blockNumber)
      const supply = () =>
        t.sql`select total_supply::text as supply, total_supply_block as block from indexer.tokens`
      expect((await supply())[0]!.block).toBe(sell.blockNumber)

      const fork = first.blockNumber
      const prepared = await t.source.prepareRollback(fork)
      expect(t.chain.supplyReads.at(-1)).toEqual({ tokens: [HKT_TOKEN], block: fork })
      await t.store.rollback(fork, t.chain.hashOf(fork), [
        (tx) => t.source.rollback(tx, fork, prepared),
      ])
      expect(await supply()).toEqual([{ supply: String(ONE_E27 - burn1!.value), block: fork }])
    } finally {
      await t.sql.end()
    }
  })

  it("a rollback below the swap that set a pool's ath restores the ath of the swaps that remain", async () => {
    const f = loadHookitFixture("hookit-hmu-split")
    const t = await db("hookit-hmu-launch", f.blockNumber - 1n)
    try {
      addFixture(t.chain, f)
      const first = await t.ingest(f.blockNumber, f.blockNumber)
      const nvdaPool = t.entries.find((p) => p.quoteAsset.startsWith("0xa8dd"))!.poolId
      const nvda = first.ath.find((a) => a.poolId === nvdaPool)!
      // A later swap in the same pool at a quarter of the price, so four times the market cap.
      const last = swapsOf("hookit-hmu-split").find(
        (s) => s.swap.poolId === nvda.poolId && s.log.logIndex > 50,
      )!
      const tx = nextTx()
      const later = f.blockNumber + 5n
      t.chain.add(
        swapLog(
          {
            poolId: nvda.poolId!,
            sender: last.swap.sender,
            amount0: -(10n ** 15n),
            amount1: 10n ** 20n,
            sqrtPriceX96: last.swap.sqrtPriceX96 / 2n,
            liquidity: last.swap.liquidity,
          },
          { blockNumber: later, transactionHash: tx, logIndex: 0 },
        ),
      )
      sender(t.chain, later, tx, f.sender as Address)
      await t.ingest(f.blockNumber + 1n, later)
      const ath = () =>
        t.sql`select ath_market_cap::text as ath, ath_block from indexer.pools where pool_id = ${nvda.poolId!}`
      expect(BigInt((await ath())[0]!.ath)).toBeGreaterThan(nvda.marketCap)

      // The InkyPump source owns the pool and ath rows' rollback.
      const prepared = await t.ink.prepareRollback(f.blockNumber)
      await t.store.rollback(f.blockNumber, t.chain.hashOf(f.blockNumber), [
        (tx2) => t.ink.rollback(tx2, f.blockNumber, prepared),
      ])
      expect(await ath()).toEqual([{ ath: String(nvda.marketCap), ath_block: nvda.block }])
    } finally {
      await t.sql.end()
    }
  })
})

describe("v4 source: reloads and the tokens a process registered itself", () => {
  it("a reload does not re-read the supply of a token this process's launch source registered", async () => {
    const launch = loadHookitFixture("hookit-hkt-launch")
    const t = setup("hookit-hkt-launch", { supplyBlock: launch.blockNumber })
    addFixture(t.chain, launch)
    // The registry was filled by the launch source in this process, not by a reload.
    await t.run(launch.blockNumber)
    await t.source.reload()
    await t.source.process([[], []], {
      toBlock: launch.blockNumber + 1n,
      live: false,
      readStateAt: 61_000_000n,
    })
    expect(t.pools.marks(t.token)?.supplyBlock).toBe(launch.blockNumber)
    expect(t.chain.supplyReads.filter((r) => r.block === 61_000_000n)).toEqual([])
  })
})

describe("v4 source: a live process that follows a Hookit token during a backfill", () => {
  const first = loadHookitFixture("hookit-hkt-first-swap")
  const sell = loadHookitFixture("hookit-hkt-sell")
  const buyback = loadHookitFixture("hookit-hkt-buyback")
  const launch = loadHookitFixture("hookit-hkt-launch")

  it("a live process that reloads during a backfill re-reads a Hookit token's supply at its read block, and the backfill's later burns still land", async () => {
    const sql: Sql = await resetDb(inject("databaseUrl"))
    try {
      const entries = poolsOfLaunch("hookit-hkt-launch")
      const L = launch.blockNumber
      const chain = new FakeChain(buyback.blockNumber + 200n)
      chain.maxSpan = 100n
      for (const f of [first, sell, buyback]) addFixture(chain, f)
      // The live cursor sits after the sell and before the buyback's burns.
      const cursor = sell.blockNumber + 50n
      // Chain truth: the supply at a block is 10^27 less every burn to it.
      const burns = chain.logs.flatMap((l) => {
        const tr = decodeTransfer(l)
        return l.address === HKT_TOKEN && tr?.to === ZERO_ADDRESS
          ? [{ block: l.blockNumber, value: tr.value }]
          : []
      })
      expect(burns).toHaveLength(4)
      const supplyAt = (block: bigint) =>
        ONE_E27 - burns.filter((b) => b.block <= block).reduce((n, b) => n + b.value, 0n)
      chain.supplies.set(HKT_TOKEN, supplyAt)

      const indexerOn = () => {
        const pools = new PoolRegistry()
        const logger = () => {}
        return {
          pools,
          indexer: new Indexer({
            chain,
            store: createStore(sql),
            logger,
            sources: [
              inkypumpSource({ sql, chain, logger, pools }),
              v4Source({ sql, chain, logger, pools }),
            ],
          }),
        }
      }
      await createStore(sql).writeBatch([], [], {
        cursor: { block: cursor, hash: chain.hashOf(cursor) },
        head: cursor,
      })
      // A token of another launchpad keeps the source's requests on while Hookit's is unknown.
      await seedToken(sql, [plainEntry(1)], 1n, 1000n, "inkypump")
      // The live process starts before the token is known.
      const live = indexerOn()
      await live.indexer.init()
      const backfill = indexerOn()
      await backfill.indexer.init()

      // The backfill's first span registers the token, as a launch source does, and reaches the
      // first burn; the second span starts after the live process has reloaded.
      const getLogs = chain.getLogs.bind(chain)
      let spans = 0
      chain.getLogs = async (from, to, filter) => {
        spans++
        if (spans === 1) {
          await seedToken(sql, entries, L)
          for (const p of entries) backfill.pools.add(p, ONE_E27, L)
        }
        if (from > first.blockNumber && spans > 1 && !reloaded) {
          reloaded = true
          // Move the live head so its tick covers the buyback block.
          await live.indexer.init()
          await live.indexer.trigger()
        }
        return getLogs(from, to, filter)
      }
      let reloaded = false
      await backfill.indexer.backfill(L, cursor)

      const stored = await sql`
        select total_supply::text as supply, total_supply_block as block from indexer.tokens
        where launchpad = 'hookit'`
      expect(stored).toEqual([
        { supply: String(supplyAt(buyback.blockNumber)), block: buyback.blockNumber },
      ])
      expect(live.pools.marks(HKT_TOKEN)?.totalSupply).toBe(supplyAt(buyback.blockNumber))
      // The backfill priced the swaps of its span on the supply at each swap's own block.
      const swaps = await sql`
        select payload->>'supply' as supply, block from indexer.events
        where type = 'launchpad.swap' and block <= ${cursor.toString()} order by block`
      expect(swaps.map((r) => r.supply)).toEqual([
        // Each swap comes before the burn of its own transaction.
        String(supplyAt(first.blockNumber - 1n)),
        String(supplyAt(first.blockNumber)),
      ])
    } finally {
      await sql.end()
    }
  })
})

const MASTER_HOOK: Address = "0xbd7e7815c640a67cabd9a93a15d1f250aaeeaac8"

/** Writes a token and its pools as the source that registers them would. */
async function seedToken(
  sql: Sql,
  entries: PoolEntry[],
  block: bigint,
  supply = ONE_E27,
  launchpad = "hookit",
) {
  const p = entries[0]!
  await sql`
    insert into indexer.tokens (address, launchpad, hook, launch_id, creator, created_block, created_at,
                                quote_asset, total_supply, total_supply_block, gain_bps)
    values (${p.token}, ${launchpad}, ${p.hook ?? MASTER_HOOK}, ${p.launchId}, ${DEAD_ADDRESS},
            ${p.createdBlock.toString()}, now(), ${p.quoteAsset}, ${supply.toString()},
            ${block.toString()}, null)
    on conflict do nothing`
  await sql.begin((tx) => writePools(tx, entries))
}
