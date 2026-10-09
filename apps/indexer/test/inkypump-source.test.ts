import { NATIVE_QUOTE_ASSET } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { describe, expect, it } from "vitest"
import type { Logger } from "../src/log"
import { HookRegistry, nativeHookRows } from "../src/sources/inkypump/hooks"
import { type KnownLaunch, processLogs } from "../src/sources/inkypump/index"
import { FakeChain } from "./fake-chain"
import {
  bond,
  CREATOR,
  HOOK,
  launch,
  launchIdOf,
  PARAMS,
  TRADER,
  tokenOf,
  trade,
  xstocksHook,
} from "./scenario"

const B = 45_290_000n

function setup(known: KnownLaunch[] = []) {
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
  const logger: Logger = (level, msg, fields) => {
    if (level === "warn") warnings.push({ msg, fields })
  }
  const chain = new FakeChain(45_300_000n)
  const registry = new HookRegistry(nativeHookRows(), logger)
  const run = () =>
    processLogs(chain.logsIn(0n, chain.head), {
      chain,
      registry,
      logger,
      loadLaunches: async () => known,
    })
  return { chain, registry, warnings, run }
}

const knownLaunch = (n: number, progressBps: number): KnownLaunch => ({
  token: tokenOf(n),
  hook: HOOK,
  launchId: launchIdOf(n),
  quoteAsset: NATIVE_QUOTE_ASSET,
  params: PARAMS,
  totalSupply: 10n ** 27n,
  progressBps,
})

describe("processLogs", () => {
  it("turns a launch with metadata and a buy into token, curve, trade and events", async () => {
    const { chain, run } = setup()
    launch(chain, { n: 1, block: B })
    trade(chain, { n: 1, block: B, sold: 4n * 10n ** 26n, logIndex: 2 })
    const batch = await run()

    expect(batch.tokens).toEqual([
      {
        address: tokenOf(1),
        hook: HOOK,
        launchId: launchIdOf(1),
        name: "Token 1",
        ticker: "T1",
        creator: CREATOR,
        createdBlock: B,
        createdAt: new Date(Number(B) * 1000),
        quoteAsset: NATIVE_QUOTE_ASSET,
        pairedStock: null,
        totalSupply: 10n ** 27n,
        targetRaise: PARAMS.targetRaise,
        saleSupply: PARAMS.saleSupply,
        gainBps: 0,
      },
    ])
    expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.launch", "launchpad.trade"])
    expect(batch.events[1]!.event).toMatchObject({
      progressBpsBefore: 0,
      progressBpsAfter: 5000,
      curveValue: "500000000000000000",
    })
    expect(batch.curve).toEqual([
      {
        token: tokenOf(1),
        progressBps: 5000,
        curveValue: 5n * 10n ** 17n,
        target: 10n ** 18n,
        marketCap: 10n ** 12n,
        updatedBlock: B,
      },
    ])
    expect(batch.trades).toEqual([
      {
        txHash: expect.any(String),
        logIndex: 2,
        token: tokenOf(1),
        side: "buy",
        trader: TRADER,
        amountIn: 1n,
        amountOut: 1n,
        block: B,
      },
    ])
    expect(batch.blocks).toEqual([{ number: B, hash: chain.hashOf(B) }])
    expect(chain.stateReads).toEqual([B])
  })

  it("prices a trade on a known launch without reading state", async () => {
    const { chain, run } = setup([knownLaunch(2, 1200)])
    trade(chain, { n: 2, block: B, sold: PARAMS.saleSupply })
    const batch = await run()
    expect(batch.events[0]!.event).toMatchObject({
      type: "launchpad.trade",
      progressBpsBefore: 1200,
      progressBpsAfter: 10_000,
    })
    expect(chain.stateReads).toEqual([])
  })

  it("records a bond, reads state once and warns when sold != saleSupply", async () => {
    const { chain, run, warnings } = setup([knownLaunch(3, 9000)])
    bond(chain, { n: 3, block: B, sold: PARAMS.saleSupply - 1n })
    const batch = await run()
    expect(batch.bonds).toEqual([{ token: tokenOf(3), block: B }])
    expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.bond"])
    expect(batch.curve[0]).toMatchObject({ progressBps: 10_000 })
    expect(warnings.map((w) => w.msg)).toEqual(["bond fired with sold != saleSupply"])
    expect(chain.stateReads).toEqual([B])
  })

  it("does not warn when the bond fills the curve", async () => {
    const { chain, run, warnings } = setup([knownLaunch(3, 9000)])
    bond(chain, { n: 3, block: B })
    await run()
    expect(warnings).toEqual([])
  })

  it("registers an xStocks hook from its factory and ingests a launch on it in the same span", async () => {
    const { chain, run, registry } = setup()
    const XHOOK: Address = "0x799def4ec4a0a293a59b53a6479afc5a9df76ac4"
    const WRAPPER: Address = "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171"
    chain.erc20.set(WRAPPER, { decimals: 18, symbol: "TSLAx" })
    xstocksHook(chain, { block: B - 10n, hook: XHOOK, wrapper: WRAPPER })
    launch(chain, { n: 4, block: B, hook: XHOOK })
    const batch = await run()
    expect(batch.hooks).toEqual([
      {
        address: XHOOK,
        kind: "xstocks",
        abiFamily: "xstocks",
        quoteAsset: WRAPPER,
        quoteDecimals: 18,
        quoteSymbol: "TSLAx",
        assetId: expect.any(String),
        discoveredBlock: B - 10n,
      },
    ])
    expect(batch.tokens[0]).toMatchObject({ quoteAsset: WRAPPER, pairedStock: "TSLAx" })
    expect(registry.get(XHOOK)).toBeDefined()
  })

  it("ignores InkyPump-shaped events from unknown contracts and warns once per address", async () => {
    const { chain, run, warnings } = setup()
    const FAKE: Address = "0x00000000000000000000000000000000000000ff"
    launch(chain, { n: 5, block: B, hook: FAKE })
    xstocksHook(chain, { block: B, hook: FAKE, wrapper: FAKE, factory: FAKE, logIndex: 5 })
    const batch = await run()
    expect([batch.tokens, batch.hooks, batch.events]).toEqual([[], [], []])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.fields).toMatchObject({ address: FAKE })
  })

  it("throws on a trade for a launch it has never seen", async () => {
    const { chain, run } = setup()
    trade(chain, { n: 6, block: B, sold: 1n })
    await expect(run()).rejects.toThrow(/unknown launch/)
  })
})
