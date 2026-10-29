import { SCHEMA_VERSION } from "@ink-indexer/events"
import type { Address } from "viem"
import { describe, expect, it } from "vitest"
import {
  DEAD_ADDRESS,
  decodeLog,
  decodeSwap,
  decodeTransfer,
  type LaunchFinalized,
  poolMarketCap,
  poolPrice,
  quoteReserve,
  readBalances,
  type StateReader,
  SWAP_TOPIC,
  swapEvent,
  swapLegs,
  TRANSFER_TOPIC,
  UNISWAP_V4_POOL_MANAGER,
  type V4Swap,
} from "../src/index"
import { loadV4Fixture } from "./fixtures"

const KRAK: Address = "0x7466ddd16d27b2a4070a827468f8f930aab2201a"
const NATIVE: Address = "0x0000000000000000000000000000000000000000"
const Q96 = 1n << 96n

function swapOf(name: "v4-inkypump-buy" | "v4-inkypump-sell") {
  const f = loadV4Fixture(name)
  const log = f.logs.find((l) => l.topics[0] === SWAP_TOPIC)!
  return { f, log, swap: decodeSwap(log)! }
}

function bond() {
  const f = loadV4Fixture("v4-inkypump-bond")
  const fin = f.logs.map((l) => decodeLog(l)).find((d) => d?.kind === "launchFinalized")
  return { f, fin: fin as LaunchFinalized, pool: f.pools[0]! }
}

describe("decodeSwap", () => {
  it("decodes the recorded buy", () => {
    const { f, log, swap } = swapOf("v4-inkypump-buy")
    expect(log.address).toBe(UNISWAP_V4_POOL_MANAGER)
    expect(swap.poolId).toBe(bond().fin.poolId)
    expect(swap.sender).toMatch(/^0x[0-9a-f]{40}$/)
    expect(swap.sender).not.toBe(f.senders[f.txHash])
    expect(swap.sqrtPriceX96).toBeGreaterThan(0n)
    expect(swap.liquidity).toBeGreaterThan(0n)
    expect(typeof swap.tick).toBe("number")
    expect(typeof swap.fee).toBe("number")
  })

  it("returns null for a log that is not a Swap", () => {
    const { f } = swapOf("v4-inkypump-buy")
    expect(decodeSwap(f.logs.find((l) => l.topics[0] === TRANSFER_TOPIC)!)).toBeNull()
  })
})

describe("swap sign convention", () => {
  // Pinned from the recorded transactions: amounts are the swapper's balance change, so the
  // side the swapper pays is negative and the side it receives is positive. ETH is currency0.
  it("a buy gives the token amount to the swapper", () => {
    const { swap } = swapOf("v4-inkypump-buy")
    expect(swap.amount0).toBe(-1_000_000_000_000_000n)
    expect(swap.amount1).toBe(123_552_922_901_793_357_487_418n)
    expect(swapLegs(swap, false)).toEqual({
      side: "buy",
      tokenAmount: 123_552_922_901_793_357_487_418n,
      quoteAmount: 1_000_000_000_000_000n,
    })
  })

  it("a sell takes the token amount from the swapper", () => {
    const { swap } = swapOf("v4-inkypump-sell")
    expect(swap.amount0).toBe(1_996_003_355_086_227n)
    expect(swap.amount1).toBe(-246_854_205_649_052_629_694_173n)
    expect(swapLegs(swap, false)).toEqual({
      side: "sell",
      tokenAmount: 246_854_205_649_052_629_694_173n,
      quoteAmount: 1_996_003_355_086_227n,
    })
  })

  it("reads the token from amount0 when the token is currency0", () => {
    const s = { amount0: 5n, amount1: -7n } as V4Swap
    expect(swapLegs(s, true)).toEqual({ side: "buy", tokenAmount: 5n, quoteAmount: 7n })
  })
})

describe("decodeTransfer", () => {
  it("decodes the token transfer in the recorded buy", () => {
    const { f, swap } = swapOf("v4-inkypump-buy")
    const log = f.logs.find((l) => l.topics[0] === TRANSFER_TOPIC)!
    const t = decodeTransfer(log)!
    expect(log.address).toBe(KRAK)
    expect(t.value).toBe(swap.amount1)
    expect(t.from).toMatch(/^0x[0-9a-f]{40}$/)
    expect(t.to).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it("returns null for a Swap log", () => {
    expect(decodeTransfer(swapOf("v4-inkypump-buy").log)).toBeNull()
  })
})

describe("pool math", () => {
  // Same cases as the bot's pool market cap, so both read a pool the same way.
  it("market cap is the same whichever currency the token is", () => {
    // A live reading of KRAK's pool: 5.3289 ETH market cap at 1B supply, token is currency1.
    expect(poolMarketCap(1085330431310623941983443206493297n, false, 10n ** 27n)).toBe(
      5328870998753306917n,
    )
    const sqrt = Q96 * 2n // currency1 per currency0 = 4
    expect(poolMarketCap(sqrt, true, 100n)).toBe(400n)
    expect(poolMarketCap(sqrt, false, 100n)).toBe(25n)
  })

  it("poolPrice is quote per 1e18 token units", () => {
    const sqrt = Q96 * 2n
    expect(poolPrice(sqrt, true)).toBe(4n * 10n ** 18n)
    expect(poolPrice(sqrt, false)).toBe(25n * 10n ** 16n)
  })

  it("an uninitialized pool has no price", () => {
    expect(poolPrice(0n, false)).toBe(0n)
    expect(poolMarketCap(0n, false, 10n ** 27n)).toBe(0n)
    expect(quoteReserve(10n ** 20n, 0n, false)).toBe(0n)
  })

  it("quoteReserve at the bond block is within 0.1% of LaunchFinalized.liquidityEth", () => {
    const { fin, pool } = bond()
    expect(pool.poolId).toBe(fin.poolId)
    const q = quoteReserve(pool.liquidity, pool.sqrtPriceX96, false)
    const diff = q > fin.liquidityQuote ? q - fin.liquidityQuote : fin.liquidityQuote - q
    expect(diff * 1000n).toBeLessThanOrEqual(fin.liquidityQuote)
  })

  it("quoteReserve uses L·√P when the quote is currency1", () => {
    expect(quoteReserve(1000n, Q96 * 2n, true)).toBe(2000n)
    expect(quoteReserve(1000n, Q96 * 2n, false)).toBe(500n)
  })
})

describe("swapEvent", () => {
  it("builds launchpad.swap from the recorded buy", () => {
    const { f, log, swap } = swapOf("v4-inkypump-buy")
    const supply = 10n ** 27n
    const e = swapEvent(
      swap,
      {
        launchpad: "inkypump",
        token: KRAK,
        launchId: swap.poolId,
        poolManager: UNISWAP_V4_POOL_MANAGER,
        tokenIsCurrency0: false,
        quoteAsset: NATIVE,
        trader: f.senders[f.txHash]!,
        supply,
        athMarketCap: 9n * 10n ** 18n,
      },
      {
        txHash: f.txHash,
        logIndex: log.logIndex,
        blockNumber: f.blockNumber,
        blockTimestamp: f.timestamp,
      },
    )
    expect(e).toEqual({
      type: "launchpad.swap",
      v: SCHEMA_VERSION,
      chainId: 57073,
      launchpad: "inkypump",
      token: KRAK,
      launchId: swap.poolId,
      txHash: f.txHash,
      logIndex: log.logIndex,
      blockNumber: f.blockNumber.toString(),
      blockTimestamp: f.timestamp,
      poolId: swap.poolId,
      poolManager: UNISWAP_V4_POOL_MANAGER,
      side: "buy",
      trader: f.senders[f.txHash],
      router: swap.sender,
      tokenAmount: "123552922901793357487418",
      quoteAmount: "1000000000000000",
      quoteAsset: NATIVE,
      price: poolPrice(swap.sqrtPriceX96, false).toString(),
      marketCap: poolMarketCap(swap.sqrtPriceX96, false, supply).toString(),
      athMarketCap: "9000000000000000000",
      quoteLiquidity: quoteReserve(swap.liquidity, swap.sqrtPriceX96, false).toString(),
      supply: supply.toString(),
    })
  })
})

describe("readBalances", () => {
  const A: Address = "0x00000000000000000000000000000000000000a1"
  const B: Address = "0x00000000000000000000000000000000000000b2"

  it("readBalances returns one value per pair", async () => {
    let args: { blockNumber?: bigint; contracts?: { address: Address; args: unknown[] }[] } = {}
    const client = {
      multicall: async (a: typeof args) => {
        args = a
        return [5n, 7n]
      },
    } as unknown as StateReader
    const pairs = [
      { token: A, holder: DEAD_ADDRESS },
      { token: B, holder: DEAD_ADDRESS },
    ]
    expect(await readBalances(client, pairs, 42n)).toEqual([5n, 7n])
    expect(args.blockNumber).toBe(42n)
    expect(args.contracts?.map((c) => [c.address, c.args])).toEqual([
      [A, [DEAD_ADDRESS]],
      [B, [DEAD_ADDRESS]],
    ])
  })

  it("makes no call for no pairs", async () => {
    const client = {
      multicall: async () => {
        throw new Error("should not be called")
      },
    } as unknown as StateReader
    expect(await readBalances(client, [], 42n)).toEqual([])
  })
})
