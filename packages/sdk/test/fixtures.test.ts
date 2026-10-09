import { describe, expect, it } from "vitest"
import { curvePrice, curveValue, decodeLog, type Trade } from "../src/index"
import { FIXTURES, type Fixture, type FixtureName, loadFixture } from "./fixtures"

const abs = (x: bigint) => (x < 0n ? -x : x)
const tradesOf = (f: Fixture) =>
  f.logs.map((l) => decodeLog(l)).filter((d): d is Trade => d?.kind === "trade")

describe("mainnet fixtures", () => {
  it.each(FIXTURES)("%s: every captured log decodes", (name) => {
    const f = loadFixture(name)
    expect(f.logs.length).toBeGreaterThan(0)
    for (const l of f.logs) expect(decodeLog(l)).not.toBeNull()
  })

  it.each<FixtureName>(["legacy-launch", "legacy-sell", "legacy-bond"])(
    "%s: legacy raised equals curveValue(sold) within 1,000 wei",
    (name) => {
      for (const s of loadFixture(name).states) {
        expect(abs(curveValue(s.at, s.at.sold) - s.at.raised)).toBeLessThanOrEqual(1000n)
      }
    },
  )

  it("legacy-capped-sell: a capped sell leaves raised above curveValue", () => {
    const [s] = loadFixture("legacy-capped-sell").states
    expect(s!.at.raised - curveValue(s!.at, s!.at.sold)).toBeGreaterThan(1000n)
  })

  // GATE: if any of these fail, stop and report to the user. Do not add per-family math.
  it.each<FixtureName>([
    "current-launch",
    "current-buy",
    "current-sell",
    "xstocks-launch-buy",
    "xstocks-sell",
  ])("%s: curveValue(sold) equals netContributions exactly", (name) => {
    for (const s of loadFixture(name).states) {
      expect(curveValue(s.at, s.at.sold)).toBe(s.at.netContributions)
    }
  })

  it.each(FIXTURES)(
    "%s: trade timestamp is the block timestamp and price matches the curve",
    (name) => {
      const f = loadFixture(name)
      for (const t of tradesOf(f)) {
        expect(t.timestamp).toBe(f.timestamp)
        const s = f.states.find((x) => x.launchId === t.launchId)!
        expect(abs(curvePrice(s.at, t.sold) - t.price)).toBeLessThanOrEqual(1n)
      }
    },
  )

  it("legacy-bond: the bond fired when sold reached saleSupply", () => {
    const [s] = loadFixture("legacy-bond").states
    expect(s!.at.sold).toBe(s!.at.saleSupply)
    expect(s!.at.finalized).toBe(true)
  })

  it.each(FIXTURES)("%s: every token has a total supply of 1e27", (name) => {
    for (const supply of Object.values(loadFixture(name).totalSupplies))
      expect(supply).toBe(10n ** 27n)
  })

  it("xstocks-hook-created: decodes the TSLAx hook", () => {
    const [log] = loadFixture("xstocks-hook-created").logs
    expect(decodeLog(log!)).toEqual({
      kind: "xstocksHookCreated",
      assetId: "0x07bc73d9eaaa9f85a9be9875be2c247584a951a455516654ebba5db3b2742f23",
      wrapper: "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171",
      hook: "0x799def4ec4a0a293a59b53a6479afc5a9df76ac4",
    })
  })
})
