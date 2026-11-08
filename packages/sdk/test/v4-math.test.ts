import { describe, expect, it } from "vitest"
import { quoteReserve, reservesInRange, sqrtRatioAtTick } from "../src/index"
import { loadHookitPoolState } from "./fixtures"

describe("sqrtRatioAtTick", () => {
  it("matches the published bounds and the zero tick", () => {
    expect(sqrtRatioAtTick(0)).toBe(1n << 96n)
    expect(sqrtRatioAtTick(-887272)).toBe(4295128739n)
    expect(sqrtRatioAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n)
  })

  it("brackets the recorded price of a live pool", () => {
    for (const p of loadHookitPoolState().pools) {
      expect(sqrtRatioAtTick(p.tick)).toBeLessThanOrEqual(p.sqrtPriceX96)
      expect(sqrtRatioAtTick(p.tick + 1)).toBeGreaterThan(p.sqrtPriceX96)
    }
  })
})

describe("reservesInRange", () => {
  const pools = loadHookitPoolState().pools

  it("reservesInRange with null ticks equals quoteReserve", () => {
    for (const p of pools) {
      const r = reservesInRange(p.sqrtPriceX96, p.liquidity, null, null)
      expect(r.amount1).toBe(quoteReserve(p.liquidity, p.sqrtPriceX96, true))
      expect(r.amount0).toBe(quoteReserve(p.liquidity, p.sqrtPriceX96, false))
    }
  })

  it("the upper tick takes quote out of currency0", () => {
    const p = pools[0]
    if (!p) throw new Error("no pool")
    const bounded = reservesInRange(p.sqrtPriceX96, p.liquidity, null, 201240)
    const open = reservesInRange(p.sqrtPriceX96, p.liquidity, null, null)
    expect(bounded.amount0).toBeLessThan(open.amount0)
    expect(bounded.amount1).toBe(open.amount1)
  })

  it("the lower tick takes quote out of currency1", () => {
    const p = pools[0]
    if (!p) throw new Error("no pool")
    const bounded = reservesInRange(p.sqrtPriceX96, p.liquidity, 100000, null)
    const open = reservesInRange(p.sqrtPriceX96, p.liquidity, null, null)
    expect(bounded.amount1).toBeLessThan(open.amount1)
    expect(bounded.amount0).toBe(open.amount0)
  })

  it("an inverted range holds nothing", () => {
    const p = pools[0]
    if (!p) throw new Error("no pool")
    expect(reservesInRange(p.sqrtPriceX96, p.liquidity, 200_000, 100_000)).toEqual({
      amount0: 0n,
      amount1: 0n,
    })
  })

  it("ticks beyond the valid range are clamped to it", () => {
    const p = pools[0]
    if (!p) throw new Error("no pool")
    expect(reservesInRange(p.sqrtPriceX96, p.liquidity, -2_000_000, 2_000_000)).toEqual(
      reservesInRange(p.sqrtPriceX96, p.liquidity, -887_272, 887_272),
    )
  })

  it("an uninitialized pool holds nothing", () => {
    expect(reservesInRange(0n, 10n ** 20n, -60, 60)).toEqual({ amount0: 0n, amount1: 0n })
  })

  it("never returns a negative amount for a price outside the range (synthetic)", () => {
    for (const price of [1n << 80n, 1n << 96n, 1n << 110n]) {
      const r = reservesInRange(price, 10n ** 20n, -600, 600)
      expect(r.amount0).toBeGreaterThanOrEqual(0n)
      expect(r.amount1).toBeGreaterThanOrEqual(0n)
    }
  })
})
