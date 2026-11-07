import { SCHEMA_VERSION } from "@ink-indexer/events"
import { type Address, decodeEventLog, type Hex, pad, parseAbi, toEventSelector } from "viem"
import { describe, expect, it } from "vitest"
import {
  type ClassicCurve,
  classicCurveOf,
  classicMarketCap,
  classicPrice,
  classicProgressBps,
  classicState,
  DEAD_ADDRESS,
  decodeHookitLog,
  decodeSwap,
  decodeTransfer,
  HOOKIT_BONDING_FACTORY,
  HOOKIT_BUYBACK,
  HOOKIT_EVENTS,
  HOOKIT_GRADUATED_FEE_HOOK,
  HOOKIT_HOOKS,
  HOOKIT_LOG_TOPICS,
  HOOKIT_MASTER_FACTORIES,
  HOOKIT_MODULE_NAMES,
  HOOKIT_TOPICS,
  type HookitLog,
  hookitBondEvent,
  hookitClassicLaunchEvent,
  hookitLaunchId,
  hookitMasterLaunchEvent,
  hookitTradeEvent,
  hookModules,
  quoteReserve,
  readClassicLaunches,
  readMetadataUris,
  reservesInRange,
  UNISWAP_V4_POOL_MANAGER,
  ZERO_ADDRESS,
} from "../src/index"
import {
  HOOKIT_FIXTURES,
  type HookitFixtureName,
  loadHookitFixture,
  loadHookitHistory,
  loadHookitPoolState,
} from "./fixtures"

const META = {
  txHash: `0x${"aa".repeat(32)}`,
  logIndex: 4,
  blockNumber: 59_000_000n,
  blockTimestamp: 1_790_000_000,
} as const
const ETH = ZERO_ADDRESS

const decodedOf = (name: HookitFixtureName) => {
  const f = loadHookitFixture(name)
  return {
    f,
    logs: f.logs.flatMap((l) => {
      const d = decodeHookitLog(l)
      return d ? [{ log: l, d }] : []
    }),
  }
}
const all = <K extends HookitLog["kind"]>(name: HookitFixtureName, kind: K) =>
  decodedOf(name)
    .logs.filter((x) => x.d.kind === kind)
    .map((x) => x.d as HookitLog & { kind: K })
const one = <K extends HookitLog["kind"]>(name: HookitFixtureName, kind: K) => {
  const hit = all(name, kind)[0]
  if (!hit) throw new Error(`no ${kind} in ${name}`)
  return hit
}
const within = (actual: number, expected: number, tolerance = 0.01) =>
  expect(Math.abs(actual - expected) / expected).toBeLessThan(tolerance)
const whole = (x: bigint, decimals = 18) => Number(x) / 10 ** decimals

describe("Hookit constants", () => {
  it("every HOOKIT_TOPICS entry matches its signature", () => {
    for (const [name, topic] of Object.entries(HOOKIT_TOPICS)) {
      expect(HOOKIT_EVENTS[name as keyof typeof HOOKIT_EVENTS], name).toBeDefined()
      expect(toEventSelector(HOOKIT_EVENTS[name as keyof typeof HOOKIT_EVENTS]), name).toBe(topic)
    }
    expect(HOOKIT_LOG_TOPICS).toHaveLength(Object.keys(HOOKIT_TOPICS).length)
    expect(new Set(HOOKIT_LOG_TOPICS).size).toBe(HOOKIT_LOG_TOPICS.length)
  })

  it("lists five Master factories and every address in lowercase", () => {
    expect(HOOKIT_MASTER_FACTORIES.size).toBe(5)
    const addresses = [
      ...HOOKIT_MASTER_FACTORIES,
      HOOKIT_BONDING_FACTORY,
      HOOKIT_BUYBACK,
      HOOKIT_GRADUATED_FEE_HOOK,
      ...HOOKIT_HOOKS.master.map((h) => h.address),
    ]
    for (const a of addresses) expect(a).toBe(a.toLowerCase())
    expect(HOOKIT_HOOKS.master).toHaveLength(6)
  })

  it("the six-field TokenLaunched topic is not a Hookit topic", () => {
    const sixField = toEventSelector(
      "event TokenLaunched(uint256 indexed launchId, address indexed token, address indexed creator, bytes32 poolId, address hooks, bool customHook)",
    )
    expect(sixField).toBe("0xe691c945f982b5e2dc78ac64408717ff084824de168d2ed40415d36823411f36")
    expect(HOOKIT_LOG_TOPICS).not.toContain(sixField)
    const log = one("hookit-hkt-launch", "masterLaunched")
    expect(log).toBeDefined()
    const raw = loadHookitFixture("hookit-hkt-launch").logs.find(
      (l) => l.topics[0] === HOOKIT_TOPICS.masterLaunched,
    )
    expect(
      decodeHookitLog({
        topics: [sixField, ...(raw?.topics.slice(1) ?? [])],
        data: raw?.data ?? "0x",
      }),
    ).toBeNull()
  })
})

describe("decodeHookitLog", () => {
  it.each(HOOKIT_FIXTURES)("%s: every recorded Hookit log decodes", (name) => {
    const f = loadHookitFixture(name)
    const hookit = f.logs.filter((l) => HOOKIT_LOG_TOPICS.includes(l.topics[0] as Hex))
    for (const l of hookit) expect(decodeHookitLog(l), `log ${l.logIndex}`).not.toBeNull()
  })

  it("decodes $HKT's nine-field TokenLaunched", () => {
    const d = one("hookit-hkt-launch", "masterLaunched")
    expect(d.launchId).toBe(2n)
    expect(d.tickLower).toBe(-887220)
    expect(d.tickUpper).toBe(201240)
    expect(d.customHook).toBe(false)
    expect(d.hooks).toBe(HOOKIT_HOOKS.master[0].address)
    expect(d.creator).toBe("0x93a00f2977e82ff72b487820e50ecf5c7a99e855")
    expect(d.token).toBe(loadHookitFixture("hookit-hkt-launch").tokens[0]?.token)
    expect(d.liquidity).toBeGreaterThan(0n)
    expect(d.poolId).toBe(loadHookitPoolState().pools[0]?.poolId)
    for (const a of [d.token, d.creator, d.hooks]) expect(a).toBe(a.toLowerCase())
  })

  it("decodes HMU's five MarketLaunched in market order", () => {
    const markets = all("hookit-hmu-launch", "market")
    expect(markets.map((m) => m.index)).toEqual([0, 1, 2, 3, 4])
    expect(new Set(markets.map((m) => m.quote)).size).toBe(5)
    expect(new Set(markets.map((m) => m.poolId)).size).toBe(5)
    expect(markets.reduce((sum, m) => sum + m.bps, 0)).toBe(10_000)
    expect(markets[0]?.tickLower).toBe(-887220)
    expect(markets[0]?.tickUpper).toBe(180240)
    const launched = one("hookit-hmu-launch", "masterLaunched")
    expect(launched.poolId).toBe(markets[0]?.poolId)
    expect(one("hookit-hmu-launch", "configured").quote).toBe(markets[0]?.quote)
  })

  it("decodes the dev buy that follows a Factory C launch", () => {
    const dev = one("hookit-bloop-launch", "devBuy")
    const launched = one("hookit-bloop-launch", "masterLaunched")
    expect(dev.launchId).toBe(launched.launchId)
    expect(dev.buyer).toBe(launched.creator)
    expect(dev.tokensOut).toBeGreaterThan(0n)
  })

  it("decodes a Classic launch and its first Bought", () => {
    const launched = one("hookit-hooc-launch", "classicLaunched")
    expect(launched.launchId).toBe(1n)
    expect(launched.quote).toBe(ETH)
    expect(launched.graduationQuote).toBe(4_200_000_000_000_000_000n)
    const bought = one("hookit-hooc-launch", "bought")
    expect(bought.buyer).toBe(loadHookitFixture("hookit-hooc-launch").sender)
    expect(bought.tokensOut).toBeGreaterThan(0n)
  })

  it("decodes a HktHolderDrop followed by a Sold", () => {
    const f = decodedOf("hookit-drop-sold")
    expect(f.logs.map((x) => x.d.kind)).toEqual(["drop", "sold"])
    const drop = one("hookit-drop-sold", "drop")
    expect(drop.quoteIn).toBeGreaterThan(0n)
    expect(drop.quoteIn).toBeLessThan(10n ** 15n)
    expect(one("hookit-drop-sold", "sold").tokensIn).toBeGreaterThan(0n)
  })

  it("decodes the wNVDAx Classic launch with its own quote and graduation quote", () => {
    const launched = one("hookit-classic-wnvdax", "classicLaunched")
    expect(launched.quote).toBe("0xa8ddb5cd96b5222afe198316e9a57caa642850d5")
    expect(whole(launched.graduationQuote)).toBeCloseTo(51.0218, 3)
  })

  it("returns null for another topic0 and for a Master launch topic with the wrong layout", () => {
    expect(decodeHookitLog({ topics: [`0x${"11".repeat(32)}`], data: "0x" })).toBeNull()
    expect(decodeHookitLog({ topics: [], data: "0x" })).toBeNull()
  })

  it("a Bought with truncated data decodes to null", () => {
    const raw = loadHookitFixture("hookit-hooc-launch").logs.find(
      (l) => l.topics[0] === HOOKIT_TOPICS.bought,
    )
    if (!raw) throw new Error("no Bought")
    expect(decodeHookitLog(raw)).not.toBeNull()
    expect(decodeHookitLog({ topics: raw.topics, data: raw.data.slice(0, 100) as Hex })).toBeNull()
  })

  it("a Swap whose amounts do not decode gives null", () => {
    const raw = loadHookitFixture("hookit-hkt-first-swap").logs.find(
      (l) => l.topics[0] === "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
    )
    if (!raw) throw new Error("no Swap")
    expect(decodeSwap(raw)).not.toBeNull()
    expect(decodeSwap({ topics: raw.topics, data: raw.data.slice(0, 66) as Hex })).toBeNull()
  })
})

describe("Hookit burns and transfers", () => {
  it("$HKT's first swap burns to the zero address and lowers the supply", () => {
    const f = loadHookitFixture("hookit-hkt-first-swap")
    const burns = f.logs.flatMap((l) => {
      const t = decodeTransfer(l)
      return t?.to === ZERO_ADDRESS ? [t] : []
    })
    expect(burns.length).toBeGreaterThan(0)
    const burned = burns.reduce((sum, b) => sum + b.value, 0n)
    const token = f.tokens[0]
    expect(token?.totalSupplyBefore).not.toBeNull()
    expect((token?.totalSupplyBefore ?? 0n) - (token?.totalSupply ?? 0n)).toBe(burned)
  })

  it("decodes a Transfer to the dead address", () => {
    const f = loadHookitFixture("hookit-dead-transfer")
    const t = decodeTransfer(f.logs[0] as never)
    expect(t?.to).toBe(DEAD_ADDRESS)
    expect(t?.value).toBe(20_000_000n * 10n ** 18n)
  })

  it("a Transfer with truncated data decodes to null", () => {
    const l = loadHookitFixture("hookit-dead-transfer").logs[0]
    if (!l) throw new Error("no Transfer")
    expect(decodeTransfer({ topics: l.topics, data: "0x1234" })).toBeNull()
  })
})

describe("hookModules", () => {
  const modulesOf = (name: HookitFixtureName) => hookModules(one(name, "configured").bitmask)

  it("$HKT's bitmask gives Anti-Snipe, Anti-MEV, Auto-Burn, Deepen LPs, Creator → Hook", () => {
    expect(modulesOf("hookit-hkt-launch")).toEqual([
      "Anti-Snipe",
      "Anti-MEV",
      "Auto-Burn",
      "Deepen LPs",
      "Creator → Hook",
    ])
  })

  it("INKY's gives Anti-Snipe, Auto-Burn, Deepen LPs, Holder Airdrop, Hook → Creator, Fixed Fees", () => {
    expect(modulesOf("hookit-inky-launch")).toEqual([
      "Anti-Snipe",
      "Auto-Burn",
      "Deepen LPs",
      "Holder Airdrop",
      "Hook → Creator",
      "Fixed Fees",
    ])
  })

  it("QCARD's gives Hook → Creator, Fixed Fees", () => {
    expect(modulesOf("hookit-qcard-launch")).toEqual(["Hook → Creator", "Fixed Fees"])
  })

  it("a dynamic-fee launch shows Dynamic Fees and not Fixed Fees", () => {
    const mask = one("hookit-tsunami-launch", "configured").bitmask
    const tax = (mask >> 7n) & 0xffffn
    expect(tax).toBeGreaterThan(0n)
    const modules = hookModules(mask)
    expect(modules).toContain("Dynamic Fees")
    expect(modules).not.toContain("Fixed Fees")
  })

  it("a launch with a tax and no Dynamic Fees bit shows Fixed Fees", () => {
    expect(hookModules(500n << 7n)).toEqual(["Fixed Fees"])
    expect(hookModules((500n << 7n) | (1n << 5n))).toEqual(["Dynamic Fees"])
    expect(hookModules(0n)).toEqual([])
  })

  it("lists every module in the order the token page shows (synthetic)", () => {
    const bits = [0, 1, 2, 3, 4, 5, 6, 111, 112, 145, 162].reduce(
      (m, b) => m | (1n << BigInt(b)),
      0n,
    )
    expect(hookModules(bits)).toEqual([
      "Anti-Snipe",
      "Backed Floor",
      "Dynamic Fees",
      "Max Tx",
      "Anti-MEV",
      "Auto-Burn",
      "Deepen LPs",
      "Holder Airdrop",
      "Buyback Vesting",
      "Creator → Hook",
      "Hook → Creator",
    ])
    expect(Object.values(HOOKIT_MODULE_NAMES)).toHaveLength(12)
  })

  it("unknown bits are ignored", () => {
    const known = one("hookit-hkt-launch", "configured").bitmask
    const withUnknown = known | (1n << 200n) | (1n << 113n) | (1n << 40n) | (1n << 255n)
    expect(hookModules(withUnknown)).toEqual(hookModules(known))
  })
})

describe("Classic curve", () => {
  const history = loadHookitHistory()
  const launchRead = loadHookitFixture("hookit-hooc-launch").classic[0]?.at
  if (!launchRead) throw new Error("no launch read")
  const curve = classicCurveOf(launchRead)

  const replay = () => {
    let sold = 0n
    for (const l of history.logs) {
      const d = decodeHookitLog(l)
      if (d?.kind === "bought" || d?.kind === "drop") sold += d.tokensOut
      if (d?.kind === "sold") sold -= d.tokensIn
    }
    return sold
  }

  it("takes the starting state from the launch block's read", () => {
    expect(curve.curveSupply).toBe(800_000_000n * 10n ** 18n)
    expect(curve.graduationQuote).toBe(4_200_000_000_000_000_000n)
    expect(curve.vQ0).toBe(1_400_000_000_000_000_000n)
  })

  it("HOOC's state after its recorded trades and drops equals launches(1) at that block", () => {
    const sold = replay()
    expect(history.logs.length).toBeGreaterThan(50)
    expect(sold).toBe(history.state.tokensSold)
    const s = classicState(curve, sold)
    expect(s.vT).toBe(history.state.virtualToken)
    // The contract rounds each trade's reserves, so the quote side drifts by a few wei over 91 events.
    const drift = (a: bigint, b: bigint) => (a > b ? a - b : b - a)
    expect(drift(s.realQuote, history.state.realQuote)).toBeLessThan(100n)
    expect(drift(s.vQ, history.state.virtualQuote)).toBeLessThan(100n)
  })

  it("HOOC's progress is 475 bps", () => {
    expect(classicProgressBps(curve, replay())).toBe(475)
  })

  it("progress is 0 when nothing, or a negative amount, is sold", () => {
    expect(classicProgressBps(curve, 0n)).toBe(0)
    expect(classicProgressBps(curve, -(10n ** 24n))).toBe(0)
  })

  it("prices and values the market cap from the virtual reserves", () => {
    const sold = replay()
    const s = classicState(curve, sold)
    expect(classicPrice(curve, sold)).toBe((s.vQ * 10n ** 18n) / s.vT)
    const supply = history.state.totalSupply
    expect(classicMarketCap(curve, sold, supply)).toBe((s.vQ * supply) / s.vT)
    expect(classicMarketCap(curve, 0n, supply)).toBeLessThan(classicMarketCap(curve, sold, supply))
  })

  it("the wNVDAx Classic launch's progress uses its own graduation quote", () => {
    const at = loadHookitFixture("hookit-classic-wnvdax").classic[0]?.at
    if (!at) throw new Error("no read")
    const c = classicCurveOf(at)
    expect(whole(c.graduationQuote)).toBeCloseTo(51.0218, 3)
    const bps = classicProgressBps(c, at.tokensSold)
    expect(bps).toBe(Number((at.realQuote * 10_000n) / at.graduationQuote))
    expect(classicState(c, at.tokensSold).realQuote).toBe(at.realQuote)
  })

  it("the trade that reaches the graduation quote reports 10000 bps (synthetic)", () => {
    const c: ClassicCurve = {
      vQ0: 1_400_000_000_000_000_000n,
      vT0: 1_066_666_666_666_666_666_666_666_667n,
      curveSupply: 800_000_000n * 10n ** 18n,
      graduationQuote: 4_200_000_000_000_000_000n,
    }
    expect(classicProgressBps(c, 0n)).toBe(0)
    // vQ = 2 * vQ0 once a third of the way up the curve is sold: real quote 1.4 ETH is a third of 4.2.
    expect(classicProgressBps(c, c.vT0 / 2n)).toBe(3333)
    // Every curve token sold is the graduating trade, whatever the rounding leaves of the raise.
    expect(classicState(c, c.curveSupply).realQuote).toBeLessThanOrEqual(c.graduationQuote)
    expect(classicProgressBps(c, c.curveSupply)).toBe(10_000)
    // A raise past the target reports no more than 10000.
    const wide = { ...c, curveSupply: c.vT0 }
    expect(classicState(wide, (c.vT0 * 4n) / 5n).realQuote).toBeGreaterThan(c.graduationQuote)
    expect(classicProgressBps(wide, (c.vT0 * 4n) / 5n)).toBe(10_000)
  })

  it("a curve with no graduation quote has no progress", () => {
    expect(classicProgressBps({ vQ0: 1n, vT0: 2n, curveSupply: 1n, graduationQuote: 0n }, 1n)).toBe(
      0,
    )
  })
})

describe("Hookit events", () => {
  const supplyOf = (name: HookitFixtureName) => loadHookitFixture(name).tokens[0]?.totalSupply ?? 0n

  it("builds a single-market Master launch that starts in a pool", () => {
    const f = loadHookitFixture("hookit-hkt-launch")
    const d = one("hookit-hkt-launch", "masterLaunched")
    const configured = one("hookit-hkt-launch", "configured")
    const e = hookitMasterLaunchEvent(
      d,
      {
        configured,
        markets: [],
        supply: supplyOf("hookit-hkt-launch"),
        name: "Hookit",
        ticker: "HKT",
        metadata: null,
      },
      META,
    )
    expect(e).toMatchObject({
      type: "launchpad.launch",
      v: SCHEMA_VERSION,
      launchpad: "hookit",
      token: d.token,
      launchId: pad(d.token, { size: 32 }),
      hook: d.hooks,
      creator: d.creator,
      quoteAsset: ETH,
      targetRaise: null,
      startsInPool: true,
      poolId: d.poolId,
      poolManager: UNISWAP_V4_POOL_MANAGER,
      customHook: false,
      totalSupply: f.tokens[0]?.totalSupply.toString(),
      hookModules: ["Anti-Snipe", "Anti-MEV", "Auto-Burn", "Deepen LPs", "Creator → Hook"],
    })
    expect(e.markets ?? null).toBeNull()
  })

  it("lists every market of HMU in order, market 0 first", () => {
    const d = one("hookit-hmu-launch", "masterLaunched")
    const markets = all("hookit-hmu-launch", "market")
    const e = hookitMasterLaunchEvent(
      d,
      {
        configured: one("hookit-hmu-launch", "configured"),
        markets,
        supply: supplyOf("hookit-hmu-launch"),
        name: "HMU",
        ticker: "HMU",
        metadata: null,
      },
      META,
    )
    expect(e.markets).toEqual(markets.map((m) => ({ quoteAsset: m.quote, poolId: m.poolId })))
    expect(e.poolId).toBe(markets[0]?.poolId)
    expect(e.quoteAsset).toBe(markets[0]?.quote)
  })

  it("keeps a custom hook flag and cleans the name (synthetic)", () => {
    const d = { ...one("hookit-hkt-launch", "masterLaunched"), customHook: true }
    const e = hookitMasterLaunchEvent(
      d,
      {
        configured: one("hookit-hkt-launch", "configured"),
        markets: [],
        supply: 1n,
        name: `bad\u0000${"x".repeat(200)}`,
        ticker: "T".repeat(80),
        metadata: null,
      },
      META,
    )
    expect(e.customHook).toBe(true)
    expect(e.name).not.toContain("\u0000")
    expect(e.name?.length).toBeLessThanOrEqual(100)
    expect(e.ticker?.length).toBeLessThanOrEqual(32)
  })

  it("builds a Classic launch on the curve under the graduated-fee hook", () => {
    const d = one("hookit-hooc-launch", "classicLaunched")
    const e = hookitClassicLaunchEvent(
      d,
      { supply: supplyOf("hookit-hooc-launch"), name: "HOOC", ticker: "HOOC", metadata: null },
      META,
    )
    expect(e).toMatchObject({
      launchpad: "hookit",
      hook: HOOKIT_GRADUATED_FEE_HOOK,
      targetRaise: d.graduationQuote.toString(),
      startsInPool: false,
      customHook: false,
      hookModules: null,
      poolId: null,
      poolManager: null,
      launchId: hookitLaunchId(d.token),
      quoteAsset: d.quote,
    })
    expect(e.markets ?? null).toBeNull()
  })

  const history = loadHookitHistory()
  const hooc = loadHookitFixture("hookit-hooc-launch")
  const curve = classicCurveOf(hooc.classic[0]?.at as never)
  const token = hooc.classic[0]?.at.token as Address

  it("a buy reports the tokens out and the quote in, with the curve after the trade", () => {
    let sold = 0n
    for (const l of history.logs) {
      const d = decodeHookitLog(l)
      if (d?.kind === "bought") {
        sold += d.tokensOut
        const e = hookitTradeEvent(
          d,
          {
            token,
            quote: ETH,
            curve,
            sold,
            supply: history.state.totalSupply,
            trader: d.buyer,
            progressBpsBefore: 3,
            athMarketCap: 9n,
          },
          META,
        )
        expect(e).toMatchObject({
          side: "buy",
          tokenAmount: d.tokensOut.toString(),
          quoteAmount: d.quoteIn.toString(),
          curveValue: classicState(curve, sold).realQuote.toString(),
          target: curve.graduationQuote.toString(),
          price: classicPrice(curve, sold).toString(),
          marketCap: classicMarketCap(curve, sold, history.state.totalSupply).toString(),
          progressBpsAfter: classicProgressBps(curve, sold),
          soldBps: classicProgressBps(curve, sold),
          progressBpsBefore: 3,
          athMarketCap: "9",
          launchId: hookitLaunchId(token),
        })
        return
      }
      if (d?.kind === "drop") sold += d.tokensOut
      if (d?.kind === "sold") sold -= d.tokensIn
    }
    throw new Error("no Bought")
  })

  it("a sell reports the tokens in and the quote out", () => {
    const sell = history.logs.map((l) => decodeHookitLog(l)).find((d) => d?.kind === "sold")
    if (sell?.kind !== "sold") throw new Error("no Sold")
    const e = hookitTradeEvent(
      sell,
      {
        token,
        quote: ETH,
        curve,
        sold: 1n,
        supply: 1n,
        trader: sell.seller,
        progressBpsBefore: 0,
        athMarketCap: 0n,
      },
      META,
    )
    expect(e.side).toBe("sell")
    expect(e.tokenAmount).toBe(sell.tokensIn.toString())
    expect(e.quoteAmount).toBe(sell.quoteOut.toString())
    expect(e.trader).toBe(sell.seller)
  })

  it("a graduation carries the liquidity put into the pool (synthetic)", () => {
    const d: HookitLog = {
      kind: "graduated",
      launchId: 1n,
      poolId: `0x${"ab".repeat(32)}`,
      quoteLp: 4_000n,
      tokenLp: 5_000n,
      liquidity: 9n,
    }
    const e = hookitBondEvent(d, { token, quote: ETH }, META)
    expect(e).toMatchObject({
      type: "launchpad.bond",
      launchpad: "hookit",
      poolId: d.poolId,
      poolManager: UNISWAP_V4_POOL_MANAGER,
      liquidityQuote: "4000",
      liquidityTokens: "5000",
      launchId: hookitLaunchId(token),
    })
  })
})

describe("pool liquidity in range", () => {
  const state = loadHookitPoolState()
  const [hkt, quill] = state.pools
  if (!hkt || !quill) throw new Error("pool state missing")
  // Both pools are ETH-quoted: ETH is currency0 and the token currency1.

  it("$HKT's quote side in range is 21.85 ETH and token side 80.94M at the recorded state, within 1%", () => {
    const r = reservesInRange(hkt.sqrtPriceX96, hkt.liquidity, -887220, 201240)
    within(whole(r.amount0), 21.85)
    within(whole(r.amount1), 80_940_000)
  })

  it("QUILL's quote side in range is 0.54 ETH", () => {
    const r = reservesInRange(quill.sqrtPriceX96, quill.liquidity, -887220, 201240)
    within(whole(r.amount0), 0.54)
    within(whole(r.amount1), 851_400_000)
  })

  it("the full-range formula overstates a concentrated pool's quote side", () => {
    const full = quoteReserve(quill.liquidity, quill.sqrtPriceX96, false)
    const r = reservesInRange(quill.sqrtPriceX96, quill.liquidity, -887220, 201240)
    expect(full / r.amount0).toBeGreaterThanOrEqual(4n)
  })

  it("a fresh pool at P_upper has no quote side", () => {
    const init = loadHookitFixture("hookit-hkt-launch").logs.find(
      (l) => l.topics[0] === `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438`,
    )
    if (!init) throw new Error("no Initialize")
    const { args } = decodeEventLog({
      abi: parseAbi([
        "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
      ]),
      topics: init.topics as [Hex, ...Hex[]],
      data: init.data,
    })
    const r = reservesInRange(args.sqrtPriceX96, 10n ** 24n, -887220, 201240)
    expect(r.amount0).toBe(0n)
    expect(r.amount1).toBeGreaterThan(0n)
  })

  it("a price outside the range gives one side zero and no negative amount (synthetic)", () => {
    const above = reservesInRange(hkt.sqrtPriceX96 * 4n, 10n ** 24n, -887220, 150000)
    expect(above.amount0).toBe(0n)
    expect(above.amount1).toBeGreaterThan(0n)
    const below = reservesInRange(1n << 90n, 10n ** 24n, 100, 200000)
    expect(below.amount1).toBe(0n)
    expect(below.amount0).toBeGreaterThan(0n)
  })

  it("a range with a lower tick above the price gives only currency0, which is what a stock-quoted pool holds", () => {
    const r = reservesInRange(hkt.sqrtPriceX96, 10n ** 24n, 160000, 887220)
    expect(r.amount1).toBe(0n)
    expect(r.amount0).toBeGreaterThan(0n)
  })
})

describe("state reads", () => {
  it("reads launches(id) of each bonding launch in one multicall", async () => {
    const at = loadHookitFixture("hookit-hooc-launch").classic[0]?.at
    if (!at) throw new Error("no read")
    const calls: unknown[] = []
    const client = {
      multicall: async (args: { contracts: unknown[]; blockNumber: bigint }) => {
        calls.push(args)
        return [
          [
            at.token,
            at.creator,
            at.quote,
            0,
            0,
            at.totalSupply,
            at.curveSupply,
            at.tokensSold,
            at.realQuote,
            at.virtualQuote,
            at.virtualToken,
            at.graduationQuote,
            at.poolId,
            0n,
            0n,
          ],
        ]
      },
    }
    const out = await readClassicLaunches(client as never, [1n], 56_519_366n)
    expect(out).toEqual([at])
    expect(calls).toHaveLength(1)
    expect(await readClassicLaunches(client as never, [], 1n)).toEqual([])
  })

  it("reads metadata URIs and gives null for a failing call", async () => {
    const client = {
      multicall: async () => [
        { status: "success", result: "ipfs://x" },
        { status: "failure", error: new Error("reverted") },
      ],
    }
    expect(await readMetadataUris(client as never, ["0x01", "0x02"] as never, 1n)).toEqual([
      "ipfs://x",
      null,
    ])
  })
})
