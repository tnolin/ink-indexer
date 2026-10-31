import { SCHEMA_VERSION } from "@ink-indexer/events"
import { type Address, type Hex, toEventSelector } from "viem"
import { describe, expect, it } from "vitest"
import {
  CALAMARI_POOL_MANAGER,
  decodeSwap,
  decodeTsunamiLog,
  MIGRATION_BASE,
  poolIdOf,
  poolPrice,
  TSUNAMI_EVENTS,
  TSUNAMI_HOOKS,
  TSUNAMI_LOG_TOPICS,
  TSUNAMI_TOPICS,
  type TsunamiCurveState,
  type TsunamiLog,
  tsunamiBondEvent,
  tsunamiLaunchEvent,
  tsunamiLaunchId,
  tsunamiMarketCap,
  tsunamiPrice,
  tsunamiProgressBps,
  tsunamiTradeEvent,
} from "../src/index"
import {
  loadCalamariFixture,
  loadTsunamiFixture,
  TSUNAMI_FIXTURES,
  type TsunamiFixtureName,
} from "./fixtures"

const META = {
  txHash: `0x${"aa".repeat(32)}`,
  logIndex: 4,
  blockNumber: 59_000_000n,
  blockTimestamp: 1_790_000_000,
} as const
const ETH = "0x0000000000000000000000000000000000000000" as Address

const decodedOf = (name: TsunamiFixtureName) => {
  const f = loadTsunamiFixture(name)
  return {
    f,
    logs: f.logs.flatMap((l) => {
      const d = decodeTsunamiLog(l)
      return d ? [{ log: l, d }] : []
    }),
  }
}
const one = <K extends TsunamiLog["kind"]>(name: TsunamiFixtureName, kind: K) => {
  const { f, logs } = decodedOf(name)
  const hit = logs.find((x) => x.d.kind === kind)
  if (!hit) throw new Error(`no ${kind} in ${name}`)
  return { f, log: hit.log, d: hit.d as TsunamiLog & { kind: K } }
}
describe("Tsunami constants", () => {
  it("every TSUNAMI_TOPICS entry matches its signature", () => {
    for (const [name, topic] of Object.entries(TSUNAMI_TOPICS)) {
      expect(TSUNAMI_EVENTS[name as keyof typeof TSUNAMI_EVENTS], name).toBeDefined()
      expect(toEventSelector(TSUNAMI_EVENTS[name as keyof typeof TSUNAMI_EVENTS]), name).toBe(topic)
    }
    expect(TSUNAMI_LOG_TOPICS).toHaveLength(Object.keys(TSUNAMI_TOPICS).length)
  })
})

describe("decodeTsunamiLog", () => {
  it.each(TSUNAMI_FIXTURES)("%s: every recorded log decodes", (name) => {
    const f = loadTsunamiFixture(name)
    expect(f.logs.length).toBeGreaterThan(0)
    for (const l of f.logs) expect(decodeTsunamiLog(l), `log ${l.logIndex}`).not.toBeNull()
  })

  it("decodes the legacy TokenLaunched of SMOKE", () => {
    const { d, log } = one("tsunami-legacy-smoke", "launched")
    expect(log.address).toBe("0x5934a5c377309453746ee8aa5194f671930c09fa")
    expect(d.legacy).toBe(true)
    expect(d.name).toBe("Smoke Test")
    expect(d.symbol).toBe("SMOKE")
    expect(d.targetRaise).toBe(1_000_000_000_000_000n)
    expect(d.feeShare).toBeNull()
    expect(d.quote).toBe(ETH)
  })

  it("decodes the creator-fee TokenLaunched of SHITCOIN", () => {
    const { d } = one("tsunami-launch-riptide", "launched")
    expect(d.legacy).toBe(false)
    expect(d.feeShare).toMatch(/^0xc52c.*d644$/)
    expect(d.targetRaise).toBe(4_200_000_000_000_000_000n)
    expect(d.token).toBe("0x46de71837e07630c79e0970019bd959354786e06")
    expect(d.state).toEqual({
      realBase: 793_100_000_000_000_000_000_000_000n,
      realQuote: 0n,
      virtualBase: 1_073_025_605_595_359_945_411_122_484n,
      virtualQuote: 1_482_395_087_001_023_542n,
    })
  })

  it("the SHITCOIN seed buy's buyer is the factory", () => {
    const { d } = one("tsunami-launch-riptide", "bought")
    expect(d.buyer).toBe("0x5934a5c377309453746ee8aa5194f671930c09fa")
  })

  it("decodes TokenSold with amount as tokens in and amountOut as net quote", () => {
    const { d, f } = one("tsunami-sell", "sold")
    expect(d.timestamp).toBe(f.timestamp)
    // The curve holds the net quote the seller was paid out of: realQuote fell to 4 wei.
    expect(d.state).toEqual(f.curves[0]!.state)
    expect(d.amount).toBeGreaterThan(d.amountOut)
  })

  it("the GM TokenMigrated pool key hashes to 0x62e1…0a46", () => {
    const { d } = one("tsunami-graduation-gm", "migrated")
    expect(poolIdOf(d.key)).toBe(
      "0x62e1beee65ed1467a36c6592d85443db355e4679e2d1a347ec790bb9235c0a46",
    )
    expect(d.baseForPool).toBe(206_900_000n * 10n ** 18n)
    expect(d.key.hooks).toBe(TSUNAMI_HOOKS.current)
    expect(d.hook).toBe(TSUNAMI_HOOKS.current)
  })

  it("the USDC TokenMigrated pool key hashes to 0xd53d…e8f0, with USDC as currency0 and the token as currency1", () => {
    const { d } = one("tsunami-usdc-graduation", "migrated")
    // The recorded Calamari swap in that pool names the pool id.
    const swap = loadCalamariFixture("calamari-swap-usdc").logs.find((l) => decodeSwap(l))!
    expect(poolIdOf(d.key)).toBe(swap.topics[1])
    expect(poolIdOf(d.key).startsWith("0xd53d")).toBe(true)
    expect(poolIdOf(d.key).endsWith("e8f0")).toBe(true)
    expect(d.token).toBe("0xb600d140dd47d92985304cb2fd061d70a8217bb4")
    expect(d.key.currency0).toBe("0x2d270e6886d130d724215a266106e6832161eaed")
    expect(d.key.currency1).toBe(d.token)
  })

  it("the wNVDAx TokenMigrated has the token as currency0, and its pool id names the recorded swap", () => {
    const { d } = one("tsunami-wnvdax-graduation", "migrated")
    const swap = loadCalamariFixture("calamari-swap-wnvdax").logs.find((l) => decodeSwap(l))!
    expect(poolIdOf(d.key)).toBe(swap.topics[1])
    expect(d.key.currency0).toBe(d.token)
    expect(d.key.currency1).toBe("0xa8ddb5cd96b5222afe198316e9a57caa642850d5")
  })

  it("decodes CreatorPoolMigrated 0x4e38…f327 to 0xed7b…08d0", () => {
    const { d } = one("tsunami-pool-move", "poolMoved")
    expect(d.source.startsWith("0x4e38")).toBe(true)
    expect(d.source.endsWith("f327")).toBe(true)
    expect(d.destination.startsWith("0xed7b")).toBe(true)
    expect(d.destination.endsWith("08d0")).toBe(true)
  })

  it("decodes the Calamari Initialize of a launch transaction", () => {
    const { d, log } = one("tsunami-launch-riptide", "initialize")
    expect(log.address).toBe(CALAMARI_POOL_MANAGER)
    expect(d.hooks).toBe(TSUNAMI_HOOKS.current)
    const launched = one("tsunami-launch-riptide", "launched").d
    expect([d.currency0, d.currency1]).toContain(launched.token)
  })

  it("a TokenBought with truncated data decodes to null", () => {
    const { log } = one("tsunami-launch-riptide", "bought")
    expect(
      decodeTsunamiLog({ topics: log.topics, data: log.data.slice(0, 2 + 64 * 3) as Hex }),
    ).toBeNull()
  })

  it("a topic0 it does not read decodes to null", () => {
    expect(decodeTsunamiLog({ topics: [`0x${"11".repeat(32)}`], data: "0x" })).toBeNull()
    expect(decodeTsunamiLog({ topics: [], data: "0x" })).toBeNull()
  })

  it("bounds name and symbol", () => {
    const { log } = one("tsunami-legacy-smoke", "launched")
    const d = decodeTsunamiLog(log)
    expect(d?.kind === "launched" && d.name.length <= 100 && d.symbol.length <= 32).toBe(true)
  })
})

describe("Tsunami constants against recorded graduations", () => {
  it.each([
    "tsunami-graduation-gm",
    "tsunami-legacy-smoke",
    "tsunami-usdc-graduation",
    "tsunami-wnvdax-graduation",
  ] as const)("%s: baseForPool is MIGRATION_BASE and the hook is one of TSUNAMI_HOOKS", (name) => {
    const { d } = one(name, "migrated")
    expect(d.baseForPool).toBe(MIGRATION_BASE)
    expect(Object.values(TSUNAMI_HOOKS)).toContain(d.hook)
    expect(d.key.hooks).toBe(d.hook)
  })
})

describe("Tsunami curve math", () => {
  it("progress of SHITCOIN at 1,833,836… wei raised is 4366 bps", () => {
    const { f } = decodedOf("tsunami-launch-riptide")
    const head = f.curves[0]!.stateAtHead
    expect(head.realQuote).toBe(1_833_836_401_592_886_950n)
    expect(tsunamiProgressBps(head, 4_200_000_000_000_000_000n)).toBe(4366)
  })

  it("the GM closing buy reports 10000 bps", () => {
    const { d, f } = one("tsunami-graduation-gm", "bought")
    const target = 4_200_000_000_000_000_000n
    expect(d.state.realBase).toBe(0n)
    expect(tsunamiProgressBps(d.state, target)).toBe(10_000)
    expect(f.curves[0]!.state.realQuote).toBeGreaterThan(target)
  })

  it("a closing state with realQuote one wei under target still reports 10000 (synthetic)", () => {
    const target = 4_200_000_000_000_000_000n
    const s: TsunamiCurveState = {
      realBase: 0n,
      realQuote: target - 1n,
      virtualBase: 279_925_605_595_359_945_411_122_484n,
      virtualQuote: 5_682_395_087_001_023_544n,
    }
    expect(tsunamiProgressBps(s, target)).toBe(10_000)
  })

  it("progress is capped at 10000 bps and a zero target is 0 (synthetic)", () => {
    const s: TsunamiCurveState = { realBase: 1n, realQuote: 5n, virtualBase: 1n, virtualQuote: 1n }
    expect(tsunamiProgressBps(s, 4n)).toBe(10_000)
    expect(tsunamiProgressBps(s, 0n)).toBe(0)
  })

  it("the GM curve price at the close equals the PoolSeeded pool price within 1 wei per token", () => {
    const { d } = one("tsunami-graduation-gm", "bought")
    // PoolSeeded.sqrtPriceX96 of the GM graduation, 0xad4250… log 16 of the transaction.
    const seeded = 556_077_321_844_189_015_180_659_061_415_667n
    const diff = tsunamiPrice(d.state) - poolPrice(seeded, false)
    expect(diff < 0n ? -diff : diff).toBeLessThanOrEqual(1n)
  })

  it("the USDC buy's price and market cap are in 6-decimal units", () => {
    const { d, f } = one("tsunami-usdc-buy", "bought")
    const supply = f.curves[0]!.totalSupply
    const cap = tsunamiMarketCap(d.state, supply)
    // ~3,682 USDC of virtual quote: the cap is a few thousand USDC in base units, not 1e-9 of one.
    expect(d.state.virtualQuote).toBe(3_682_282_488n)
    expect(cap).toBe((d.state.virtualQuote * supply) / d.state.virtualBase)
    expect(cap).toBeGreaterThan(d.state.virtualQuote / 2n)
    expect(cap).toBeLessThan(d.state.virtualQuote)
  })

  it("the kBTC buy's price and market cap are in 8-decimal units", () => {
    const { d, f } = one("tsunami-kbtc-buy", "bought")
    const supply = f.curves[0]!.totalSupply
    const cap = tsunamiMarketCap(d.state, supply)
    expect(d.state.virtualQuote).toBe(4_794_649n)
    expect(cap).toBeGreaterThan(d.state.virtualQuote / 2n)
    expect(cap).toBeLessThan(d.state.virtualQuote)
  })
})

describe("Tsunami event builders", () => {
  it("launch builder: SHITCOIN with the hook, supply and metadata passed in", () => {
    const { d } = one("tsunami-launch-riptide", "launched")
    const ev = tsunamiLaunchEvent(
      d,
      {
        hook: TSUNAMI_HOOKS.current,
        supply: 10n ** 27n,
        metadata: {
          description: "d",
          imageUrl: null,
          links: { telegram: null, twitter: null, website: null },
        },
      },
      META,
    )
    expect(ev).toMatchObject({
      type: "launchpad.launch",
      v: SCHEMA_VERSION,
      launchpad: "tsunami",
      token: d.token,
      launchId: tsunamiLaunchId(d.curve),
      hook: TSUNAMI_HOOKS.current,
      creator: d.creator,
      quoteAsset: ETH,
      targetRaise: "4200000000000000000",
      totalSupply: "1000000000000000000000000000",
      startsInPool: false,
      poolId: null,
      poolManager: null,
      customHook: null,
      hookModules: null,
      description: "d",
    })
  })

  it("trade builder: a buy's quoteAmount is the gross amount and its trader is the one passed in", () => {
    const { d, f } = one("tsunami-usdc-buy", "bought")
    const c = f.curves[0]!
    const trader = "0x00000000000000000000000000000000000000aa" as Address
    const ev = tsunamiTradeEvent(
      d,
      {
        token: c.token,
        launchId: tsunamiLaunchId(c.curve),
        quote: "0x2d270e6886d130d724215a266106e6832161eaed",
        targetRaise: 12_000_000n,
        supply: c.totalSupply,
        trader,
        progressBpsBefore: 0,
        athMarketCap: 0n,
      },
      META,
    )
    expect(ev.side).toBe("buy")
    expect(ev.trader).toBe(trader)
    expect(ev.quoteAmount).toBe(d.amount.toString())
    expect(ev.tokenAmount).toBe(d.amountOut.toString())
    expect(ev.curveValue).toBe(d.state.realQuote.toString())
    expect(ev.target).toBe("12000000")
    expect(ev.progressBpsAfter).toBe(ev.soldBps)
    expect(ev.price).toBe(tsunamiPrice(d.state).toString())
    expect(ev.marketCap).toBe(tsunamiMarketCap(d.state, c.totalSupply).toString())
    expect(ev.quoteAsset).toBe("0x2d270e6886d130d724215a266106e6832161eaed")
  })

  it("trade builder: a sell's tokenAmount is the tokens in and quoteAmount the net quote out", () => {
    const { d, f } = one("tsunami-sell", "sold")
    const c = f.curves[0]!
    const ev = tsunamiTradeEvent(
      d,
      {
        token: c.token,
        launchId: tsunamiLaunchId(c.curve),
        quote: ETH,
        targetRaise: 4_200_000_000_000_000_000n,
        supply: c.totalSupply,
        trader: f.sender,
        progressBpsBefore: 1,
        athMarketCap: 5n,
      },
      META,
    )
    expect(ev.side).toBe("sell")
    expect(ev.tokenAmount).toBe(d.amount.toString())
    expect(ev.quoteAmount).toBe(d.amountOut.toString())
    expect(ev.trader).toBe(f.sender)
    expect(ev.progressBpsBefore).toBe(1)
    expect(ev.athMarketCap).toBe("5")
  })

  it("bond builder: the pool id comes from the key and the pool manager is Calamari's", () => {
    const { d, f } = one("tsunami-graduation-gm", "migrated")
    const c = f.curves[0]!
    const ev = tsunamiBondEvent(d, { launchId: tsunamiLaunchId(c.curve), quote: ETH }, META)
    expect(ev).toMatchObject({
      type: "launchpad.bond",
      launchpad: "tsunami",
      token: d.token,
      poolId: "0x62e1beee65ed1467a36c6592d85443db355e4679e2d1a347ec790bb9235c0a46",
      poolManager: CALAMARI_POOL_MANAGER,
      liquidityQuote: d.quoteRaised.toString(),
      liquidityTokens: d.baseForPool.toString(),
      quoteAsset: ETH,
    })
  })
})
