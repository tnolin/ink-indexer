import { describe, expect, it } from "vitest"
import { curvePrice, curveValue, marketCap, progressBps, soldBps } from "../src/index"

const LEGACY = {
  targetRaise: 3n * 10n ** 18n,
  saleSupply: 636267244543291926383972167n,
  gainBps: 50_000,
}

describe("curve math", () => {
  it("matches on-chain raised for legacy launches", () => {
    expect(curveValue(LEGACY, 126456868244813729288597944n)).toBe(254999999999999999n)
    expect(curveValue(LEGACY, 74209540390054786018074n)).toBe(99999999999999n)
    expect(curveValue(LEGACY, 41704709172325507929164879n)).toBe(65388482136371487n)
  })

  it("is zero at zero and exactly the target when the curve is full", () => {
    expect(curveValue(LEGACY, 0n)).toBe(0n)
    expect(curveValue(LEGACY, LEGACY.saleSupply)).toBe(LEGACY.targetRaise)
  })

  it("is linear in sold for a flat curve", () => {
    const flat = { targetRaise: 10n ** 18n, saleSupply: 8n * 10n ** 26n, gainBps: 0 }
    expect(curveValue(flat, 4n * 10n ** 26n)).toBe(5n * 10n ** 17n)
  })

  it("prices within 1 base unit of the Trade event price", () => {
    const cases: [bigint, bigint][] = [
      [10996462298049720546679419n, 1463554654n],
      [126456868244813729288597944n, 2685852827n],
      [74209540390054786018074n, 1347928440n],
    ]
    for (const [sold, eventPrice] of cases) {
      const diff = curvePrice(LEGACY, sold) - eventPrice
      expect(diff < 0n ? -diff : diff).toBeLessThanOrEqual(1n)
    }
  })

  it("turns curve value into basis points, capped at 10,000", () => {
    expect(progressBps(254999999999999999n, 3n * 10n ** 18n)).toBe(849)
    expect(progressBps(3n * 10n ** 18n, 3n * 10n ** 18n)).toBe(10_000)
    expect(progressBps(4n * 10n ** 18n, 3n * 10n ** 18n)).toBe(10_000)
    expect(progressBps(0n, 3n * 10n ** 18n)).toBe(0)
  })

  it("returns 0 instead of dividing by zero when the sale supply or the target is zero", () => {
    expect(curveValue({ ...LEGACY, saleSupply: 0n }, 0n)).toBe(0n)
    expect(curveValue({ ...LEGACY, saleSupply: 0n }, 10n ** 18n)).toBe(0n)
    expect(progressBps(10n ** 18n, 0n)).toBe(0)
    expect(progressBps(0n, 0n)).toBe(0)
    expect(progressBps(10n ** 18n, -1n)).toBe(0)
  })

  it("turns tokens sold into basis points of the sale supply, floored and capped at 10,000", () => {
    const supply = 10n ** 27n
    expect(soldBps(4n * 10n ** 26n, supply)).toBe(4000)
    expect(soldBps(0n, supply)).toBe(0)
    expect(soldBps(supply, supply)).toBe(10_000)
    expect(soldBps(supply + 1n, supply)).toBe(10_000)
    expect(soldBps(supply - 1n, supply)).toBe(9_999)
    expect(soldBps(1n, supply)).toBe(0)
    expect(soldBps(5n, 0n)).toBe(0)
    expect(soldBps(-1n, supply)).toBe(0)
  })

  it("computes market cap from price per whole token and total supply", () => {
    expect(marketCap(1463554654n, 10n ** 27n)).toBe(1463554654n * 10n ** 9n)
  })
})
