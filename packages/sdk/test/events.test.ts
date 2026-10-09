import { describe, expect, it } from "vitest"
import {
  bondEvent,
  decodeLog,
  type LaunchCreated,
  type LaunchMetadata,
  launchEvent,
  tradeEvent,
} from "../src/index"
import { loadFixture } from "./fixtures"

const META = {
  txHash: `0x${"aa".repeat(32)}`,
  logIndex: 3,
  blockNumber: 45_300_000n,
  blockTimestamp: 1_790_000_000,
} as const
const LAUNCH_ID = `0x${"11".repeat(32)}` as const
const TOKEN = "0x00000000000000000000000000000000000000d1"
const HOOK = "0x893183da2411c7df81f103bfef09e4e46c326ac4"
const ETH = "0x0000000000000000000000000000000000000000"
const PARAMS = { targetRaise: 10n ** 18n, saleSupply: 8n * 10n ** 26n, gainBps: 0 }
const BASE = {
  v: 1,
  chainId: 57073,
  launchpad: "inkypump",
  token: TOKEN,
  launchId: LAUNCH_ID,
  txHash: META.txHash,
  logIndex: 3,
  blockNumber: "45300000",
  blockTimestamp: 1_790_000_000,
}

const created: LaunchCreated = {
  kind: "launchCreated",
  launchId: LAUNCH_ID,
  creator: "0x00000000000000000000000000000000000000c1",
  token: TOKEN,
  targetRaise: 10n ** 18n,
}
const metadata: LaunchMetadata = {
  kind: "launchMetadata",
  launchId: LAUNCH_ID,
  name: "Shark",
  ticker: "FIN",
  description: "",
  imageUrl: "https://img/x.png",
  telegram: "",
  twitter: "https://x.com/fin",
  website: "",
}

describe("event builders", () => {
  it("builds a launch event, turning empty metadata strings into null", () => {
    expect(
      launchEvent(
        created,
        metadata,
        { hook: HOOK, quoteAsset: ETH, totalSupply: 10n ** 27n },
        META,
      ),
    ).toEqual({
      type: "launchpad.launch",
      ...BASE,
      hook: HOOK,
      creator: created.creator,
      name: "Shark",
      ticker: "FIN",
      description: null,
      imageUrl: "https://img/x.png",
      links: { telegram: null, twitter: "https://x.com/fin", website: null },
      quoteAsset: ETH,
      targetRaise: "1000000000000000000",
      totalSupply: "1000000000000000000000000000",
    })
  })

  it("builds a launch event without metadata", () => {
    const e = launchEvent(
      created,
      null,
      { hook: HOOK, quoteAsset: ETH, totalSupply: 10n ** 27n },
      META,
    )
    expect([e.name, e.ticker, e.links.website]).toEqual([null, null, null])
  })

  it("builds a trade event with curve progress and market cap", () => {
    const trade = {
      kind: "trade",
      launchId: LAUNCH_ID,
      trader: "0x00000000000000000000000000000000000000e1",
      side: "buy",
      price: 1000n,
      sold: 4n * 10n ** 26n,
      timestamp: 1_790_000_000,
      tokenAmount: 7n,
      quoteAmount: 9n,
      refund: 0n,
    } as const
    const ctx = {
      token: TOKEN,
      params: PARAMS,
      totalSupply: 10n ** 27n,
      quoteAsset: ETH,
      progressBpsBefore: 1234,
    } as const
    expect(tradeEvent(trade, ctx, META)).toEqual({
      type: "launchpad.trade",
      ...BASE,
      side: "buy",
      trader: trade.trader,
      tokenAmount: "7",
      quoteAmount: "9",
      price: "1000",
      curveValue: "500000000000000000",
      target: "1000000000000000000",
      progressBpsBefore: 1234,
      progressBpsAfter: 5000,
      marketCap: "1000000000000",
      quoteAsset: ETH,
    })
  })

  it("builds a bond event", () => {
    const fin = {
      kind: "launchFinalized",
      launchId: LAUNCH_ID,
      poolId: LAUNCH_ID,
      liquidityQuote: 2n,
      liquidityTokens: 3n,
    } as const
    expect(bondEvent(fin, { token: TOKEN, quoteAsset: ETH }, META)).toEqual({
      type: "launchpad.bond",
      ...BASE,
      poolId: LAUNCH_ID,
      liquidityQuote: "2",
      liquidityTokens: "3",
      quoteAsset: ETH,
    })
  })

  it("merges real LaunchCreated and LaunchMetadata logs", () => {
    const f = loadFixture("legacy-launch")
    const decoded = f.logs.map((l) => decodeLog(l))
    const c = decoded.find((d): d is LaunchCreated => d?.kind === "launchCreated")!
    const m = decoded.find((d): d is LaunchMetadata => d?.kind === "launchMetadata") ?? null
    const e = launchEvent(
      c,
      m,
      { hook: f.logs[0]!.address, quoteAsset: ETH, totalSupply: 10n ** 27n },
      META,
    )
    expect(e.token).toBe(f.states[0]!.at.token)
    expect(typeof e.name).toBe("string")
  })
})
