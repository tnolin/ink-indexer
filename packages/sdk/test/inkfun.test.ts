import { SCHEMA_VERSION } from "@ink-indexer/events"
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hash,
  type Hex,
  pad,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
} from "viem"
import { describe, expect, it } from "vitest"
import {
  decodeInkfunLog,
  INKFUN_FACTORY,
  INKFUN_HOOK,
  INKFUN_MIGRATION,
  INKFUN_TOPICS,
  type InkfunCurve,
  type InkfunLog,
  inkfunBondEvent,
  inkfunCurveValue,
  inkfunLaunchEvent,
  inkfunLaunchId,
  inkfunPrice,
  inkfunProgressBps,
  inkfunTradeEvent,
  poolPrice,
  readCurveSold,
  readInkfunLaunches,
  type StateReader,
  UNISWAP_V4_POOL_MANAGER,
} from "../src/index"
import { INKFUN_FIXTURES, type InkfunFixtureName, loadInkfunFixture } from "./fixtures"

const META = {
  txHash: `0x${"aa".repeat(32)}`,
  logIndex: 4,
  blockNumber: 59_000_000n,
  blockTimestamp: 1_790_000_000,
} as const
const ETH = "0x0000000000000000000000000000000000000000"
const CURVE_ADDR = "0x00000000000000000000000000000000000000c1" as Address
const TOKEN = "0x00000000000000000000000000000000000000d1" as Address
const CREATOR = "0x00000000000000000000000000000000000000e1" as Address

const CURVE: InkfunCurve = {
  virtualQuote: 1_400_000_000_000_000_000n,
  virtualTokens: 1_066_666_666_666_666_666_666_666_666n,
  curveSupply: 800_000_000n * 10n ** 18n,
  graduationTarget: 4_200_000_000_000_000_000n,
}

const logsOf = (name: InkfunFixtureName) =>
  loadInkfunFixture(name).logs.flatMap((l) => {
    const d = decodeInkfunLog(l)
    return d ? [{ log: l, d }] : []
  })
const only = <K extends InkfunLog["kind"]>(name: InkfunFixtureName, kind: K) => {
  const found = logsOf(name).filter((x) => x.d.kind === kind)
  expect(found).toHaveLength(1)
  return found[0]?.d as Extract<InkfunLog, { kind: K }>
}

describe("decodeInkfunLog", () => {
  it("decodes LaunchCreated from the launch fixture", () => {
    const f = loadInkfunFixture("inkfun-launch")
    const created = only("inkfun-launch", "launchCreated")
    expect(created.name).toBe("Ink Fun")
    expect(created.symbol).toBe("INKFUN")
    expect(created.token).toBe(created.token.toLowerCase())
    expect(created.curve).toBe(f.curves[0]?.curve)
    expect(created.creator).toMatch(/^0x[0-9a-f]{40}$/)
    const emitter = f.logs.find((l) => l.topics[0] === INKFUN_TOPICS.launchCreated)?.address
    expect(emitter).toBe(INKFUN_FACTORY)
  })

  it("the seed buy's beneficiary is the creator and its payer the factory", () => {
    const created = only("inkfun-launch-seed-buy", "launchCreated")
    const bought = only("inkfun-launch-seed-buy", "bought")
    expect(bought.payer).toBe(INKFUN_FACTORY)
    expect(bought.beneficiary).toBe(created.creator)
  })

  it("decodes Bought and Sold with tokensSold after the trade", () => {
    const f = loadInkfunFixture("inkfun-buy")
    const bought = only("inkfun-buy", "bought")
    expect(bought.quoteIn).toBeGreaterThan(0n)
    expect(bought.tokensOut).toBeGreaterThan(0n)
    expect(bought.tokensSold).toBeGreaterThanOrEqual(bought.tokensOut)
    expect(bought.tokensSold).toBe(f.curves[0]?.sold)
    const sold = only("inkfun-sell", "sold")
    expect(sold.tokensIn).toBeGreaterThan(0n)
    expect(sold.quoteOut).toBeGreaterThan(0n)
    expect(sold.tokensSold).toBe(loadInkfunFixture("inkfun-sell").curves[0]?.sold)
  })

  it("decodes a Migrated log built from the verified ABI", () => {
    const abi = parseAbi([
      "event Migrated(bytes32 indexed poolId, address indexed launchToken, uint256 tokenAmount, uint256 quoteAmount, uint256 tokenId, uint160 sqrtPriceX96)",
    ])
    const poolId = pad("0x1234", { size: 32 })
    const topics = encodeEventTopics({
      abi,
      eventName: "Migrated",
      args: { poolId, launchToken: TOKEN },
    })
    const data = encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, uint160"), [
      197_619_047n * 10n ** 18n,
      4_150_000_000_000_000_000n,
      7n,
      79_228_162_514_264_337_593_543_950_336n,
    ])
    const d = decodeInkfunLog({ topics: topics as Hex[], data })
    expect(d).toEqual({
      kind: "migrated",
      poolId,
      token: TOKEN,
      tokenAmount: 197_619_047n * 10n ** 18n,
      quoteAmount: 4_150_000_000_000_000_000n,
      tokenId: 7n,
      sqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n,
    })
  })

  it("returns null for a log with a known topic0 and a different layout", () => {
    for (const topic0 of Object.values(INKFUN_TOPICS)) {
      expect(decodeInkfunLog({ topics: [topic0], data: "0x1234" })).toBeNull()
    }
  })

  it("ignores a topic0 it does not know", () => {
    expect(decodeInkfunLog({ topics: [pad("0x1")], data: "0x" })).toBeNull()
    expect(decodeInkfunLog({ topics: [], data: "0x" })).toBeNull()
  })

  it("every INKFUN_TOPICS entry matches its signature", () => {
    expect(INKFUN_TOPICS).toEqual({
      launchCreated: toEventSelector(
        "LaunchCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol)",
      ),
      bought: toEventSelector(
        "Bought(address indexed payer, address indexed beneficiary, uint256 quoteIn, uint256 fee, uint256 tokensOut, uint256 refund, uint256 tokensSold)",
      ),
      sold: toEventSelector(
        "Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tokensSold)",
      ),
      migrated: toEventSelector(
        "Migrated(bytes32 indexed poolId, address indexed launchToken, uint256 tokenAmount, uint256 quoteAmount, uint256 tokenId, uint160 sqrtPriceX96)",
      ),
    })
  })
})

describe("curve math", () => {
  it("curve value is within 0.0001% of the curve's realQuote at each fixture block", () => {
    const checked: string[] = []
    for (const name of INKFUN_FIXTURES) {
      for (const c of loadInkfunFixture(name).curves) {
        if (c.realQuote < 1_000_000n) continue
        const value = inkfunCurveValue(c.params, c.sold)
        const diff = value > c.realQuote ? value - c.realQuote : c.realQuote - value
        expect(diff * 1_000_000n, `${name} value ${value} vs ${c.realQuote}`).toBeLessThanOrEqual(
          c.realQuote,
        )
        checked.push(name)
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(2)
  })

  it("progress of 9_875_000_000_000_000 wei raised is 23 bps", () => {
    const raised = 9_875_000_000_000_000n
    const sold =
      CURVE.virtualTokens -
      (CURVE.virtualQuote * CURVE.virtualTokens) / (raised + CURVE.virtualQuote)
    expect(inkfunProgressBps(CURVE, sold)).toBe(23)
  })

  it("progress is 10,000 bps when tokensSold equals curveSupply", () => {
    expect(inkfunProgressBps(CURVE, CURVE.curveSupply)).toBe(10_000)
  })

  it("progress is 10,000 bps after a fill to the target with the contract's rounding", () => {
    // The live curve rounds virtualTokens and tokensOut down and closes when the net quote raised
    // reaches the target, so a full curve ends one base unit short of curveSupply.
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b
    const soldAt = (raised: bigint) =>
      CURVE.virtualTokens -
      ceilDiv(CURVE.virtualQuote * CURVE.virtualTokens, CURVE.virtualQuote + raised)
    let raised = 0n
    let sold = 0n
    const step = CURVE.graduationTarget / 7n
    while (raised < CURVE.graduationTarget) {
      raised = raised + step > CURVE.graduationTarget ? CURVE.graduationTarget : raised + step
      sold = soldAt(raised)
    }
    expect(sold).toBe(CURVE.curveSupply - 1n)
    expect(inkfunProgressBps(CURVE, sold)).toBe(10_000)
    // One wei short of the target the curve is still open.
    expect(inkfunProgressBps(CURVE, soldAt(CURVE.graduationTarget - 1n))).toBe(9_999)
  })

  it("progress is 0 for nothing sold", () => {
    expect(inkfunProgressBps(CURVE, 0n)).toBe(0)
    expect(inkfunCurveValue(CURVE, 0n)).toBe(0n)
  })

  it("price at the close equals the pool's opening price", () => {
    const quote = 4_150_000_000_000_000_000n
    const tokens = (200_000_000n * 10n ** 18n * 415n) / 420n
    // sqrtPriceX96 of currency1 (token) per currency0 (native ETH).
    const isqrt = (n: bigint) => {
      let x = n
      let y = (x + 1n) / 2n
      while (y < x) {
        x = y
        y = (x + n / x) / 2n
      }
      return x
    }
    const sqrtPriceX96 = isqrt((tokens << 192n) / quote)
    const pool = poolPrice(sqrtPriceX96, false)
    const curve = inkfunPrice(CURVE, CURVE.curveSupply)
    const diff = pool > curve ? pool - curve : curve - pool
    expect(diff).toBeLessThanOrEqual(1n)
  })
})

describe("builders", () => {
  const launchId = inkfunLaunchId(CURVE_ADDR)

  it("launch id is the curve address left-padded to 32 bytes", () => {
    expect(launchId).toBe(`0x${"0".repeat(24)}${CURVE_ADDR.slice(2)}`)
  })

  it("launch builder leaves text fields null without metadata", () => {
    const ev = inkfunLaunchEvent(
      {
        kind: "launchCreated",
        token: TOKEN,
        curve: CURVE_ADDR,
        creator: CREATOR,
        name: "",
        symbol: "",
      },
      { totalSupply: 1n, graduationTarget: 2n, metadata: null },
      META,
    )
    expect(ev.name).toBeNull()
    expect(ev.ticker).toBeNull()
    expect(ev.description).toBeNull()
    expect(ev.imageUrl).toBeNull()
    expect(ev.links).toEqual({ telegram: null, twitter: null, website: null })
  })

  const metaOf = (
    f: { blockNumber: bigint; timestamp: number },
    l: { transactionHash: Hash; logIndex: number },
  ) => ({
    txHash: l.transactionHash,
    logIndex: l.logIndex,
    blockNumber: f.blockNumber,
    blockTimestamp: f.timestamp,
  })

  it("launch builder on the recorded launch: launchpad inkfun, launchId pad(curve), hook INKFUN_HOOK and the curve's graduation target", () => {
    const f = loadInkfunFixture("inkfun-launch")
    const log = f.logs[0]!
    const created = only("inkfun-launch", "launchCreated")
    const c = f.curves[0]!
    const ev = inkfunLaunchEvent(
      created,
      { totalSupply: c.totalSupply, graduationTarget: c.params.graduationTarget, metadata: null },
      metaOf(f, log),
    )
    expect(ev).toMatchObject({
      type: "launchpad.launch",
      v: SCHEMA_VERSION,
      launchpad: "inkfun",
      token: created.token,
      launchId: inkfunLaunchId(created.curve),
      hook: INKFUN_HOOK,
      creator: created.creator,
      name: "Ink Fun",
      ticker: "INKFUN",
      quoteAsset: ETH,
      targetRaise: c.params.graduationTarget.toString(),
      totalSupply: c.totalSupply.toString(),
      startsInPool: false,
      blockNumber: f.blockNumber.toString(),
    })
    expect(ev.targetRaise).toBe("4200000000000000000")
  })

  it("trade builder on the recorded buy: quoteAmount is quoteIn plus fee and the trader the beneficiary", () => {
    const f = loadInkfunFixture("inkfun-buy")
    const c = f.curves[0]!
    const log = f.logs[0]!
    const d = only("inkfun-buy", "bought")
    const ev = inkfunTradeEvent(
      d,
      {
        token: c.token,
        launchId: inkfunLaunchId(c.curve),
        curve: c.params,
        totalSupply: c.totalSupply,
        progressBpsBefore: 0,
        athMarketCap: 0n,
      },
      metaOf(f, log),
    )
    expect(ev).toMatchObject({
      launchpad: "inkfun",
      side: "buy",
      trader: d.beneficiary,
      tokenAmount: d.tokensOut.toString(),
      quoteAmount: (d.quoteIn + d.fee).toString(),
      price: inkfunPrice(c.params, d.tokensSold).toString(),
      curveValue: inkfunCurveValue(c.params, d.tokensSold).toString(),
      target: c.params.graduationTarget.toString(),
      progressBpsAfter: inkfunProgressBps(c.params, d.tokensSold),
      quoteAsset: ETH,
    })
    expect(ev.soldBps).toBe(ev.progressBpsAfter)
    // The curve's own record of the net quote raised matches the event.
    const raised = BigInt(ev.curveValue)
    const diff = raised > c.realQuote ? raised - c.realQuote : c.realQuote - raised
    expect(diff * 1_000_000n).toBeLessThanOrEqual(c.realQuote)
  })

  it("trade builder on the recorded sell: the trader is the seller and quoteAmount is quoteOut", () => {
    const f = loadInkfunFixture("inkfun-sell")
    const c = f.curves[0]!
    const d = only("inkfun-sell", "sold")
    const ev = inkfunTradeEvent(
      d,
      {
        token: c.token,
        launchId: inkfunLaunchId(c.curve),
        curve: c.params,
        totalSupply: c.totalSupply,
        progressBpsBefore: 0,
        athMarketCap: 0n,
      },
      metaOf(f, f.logs[0]!),
    )
    expect(ev).toMatchObject({
      side: "sell",
      trader: d.seller,
      tokenAmount: d.tokensIn.toString(),
      quoteAmount: d.quoteOut.toString(),
    })
  })

  it("bond builder carries the Uniswap PoolManager", () => {
    const poolId = pad("0xabcd", { size: 32 }) as Hash
    const ev = inkfunBondEvent(
      {
        kind: "migrated",
        poolId,
        token: TOKEN,
        tokenAmount: 7n,
        quoteAmount: 9n,
        tokenId: 1n,
        sqrtPriceX96: 2n,
      },
      { launchId },
      META,
    )
    expect(ev).toMatchObject({
      type: "launchpad.bond",
      launchpad: "inkfun",
      token: TOKEN,
      launchId,
      poolId,
      poolManager: UNISWAP_V4_POOL_MANAGER,
      liquidityQuote: "9",
      liquidityTokens: "7",
      quoteAsset: ETH,
    })
  })

  it("the ink.fun constants are lowercase", () => {
    for (const a of [INKFUN_FACTORY, INKFUN_HOOK, INKFUN_MIGRATION]) expect(a).toBe(a.toLowerCase())
  })
})

describe("state reads", () => {
  it("readInkfunLaunches returns null metadataURI when the call reverts", async () => {
    const ok = (result: unknown) => ({ status: "success", result })
    const client = {
      multicall: async () => [
        ok(1n), // virtualQuote
        ok(2n), // virtualTokens
        ok(3n), // curveSupply
        ok(4n), // lpSupply
        ok(5n), // graduationTarget
        ok(6n), // totalSupply
        { status: "failure", error: new Error("reverted") }, // metadataURI
      ],
    } as unknown as StateReader
    const [r] = await readInkfunLaunches(client, [{ token: TOKEN, curve: CURVE_ADDR }], 10n)
    expect(r).toEqual({
      curve: { virtualQuote: 1n, virtualTokens: 2n, curveSupply: 3n, graduationTarget: 5n },
      lpSupply: 4n,
      totalSupply: 6n,
      metadataURI: null,
    })
  })

  it("readInkfunLaunches throws when a curve parameter cannot be read", async () => {
    const client = {
      multicall: async () => [
        { status: "failure", error: new Error("boom") },
        ...Array.from({ length: 6 }, () => ({ status: "success", result: 1n })),
      ],
    } as unknown as StateReader
    await expect(
      readInkfunLaunches(client, [{ token: TOKEN, curve: CURVE_ADDR }], 10n),
    ).rejects.toThrow()
  })

  it("reads nothing for no launches or no curves", async () => {
    const client = {
      multicall: async () => {
        throw new Error("should not be called")
      },
    } as unknown as StateReader
    expect(await readInkfunLaunches(client, [], 1n)).toEqual([])
    expect(await readCurveSold(client, [], 1n)).toEqual([])
  })

  it("readCurveSold reads tokensSold of each curve at the block", async () => {
    let args: { blockNumber?: bigint; contracts?: { address: string; functionName: string }[] } = {}
    const client = {
      multicall: async (a: typeof args) => {
        args = a
        return [5n, 6n]
      },
    } as unknown as StateReader
    expect(await readCurveSold(client, [CURVE_ADDR, TOKEN], 42n)).toEqual([5n, 6n])
    expect(args.blockNumber).toBe(42n)
    expect(args.contracts?.map((c) => c.functionName)).toEqual(["tokensSold", "tokensSold"])
  })
})
