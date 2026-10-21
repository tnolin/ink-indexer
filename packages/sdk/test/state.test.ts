import { describe, expect, it } from "vitest"
import { readErc20Names, readLaunchStates, type StateReader } from "../src/index"

const raw = {
  token: "0xABCDEF0000000000000000000000000000000001",
  launchTimestamp: 1n,
  antiSnipeDuration: 0,
  creator: "0x0000000000000000000000000000000000000002",
  salePortionBps: 6362,
  creatorFeeSplitBps: 10_000,
  gainBps: 50_000,
  finalized: false,
  saleSupply: 5n,
  liquiditySupply: 6n,
  sold: 1n,
  raised: 2n,
  netContributions: 3n,
  targetRaise: 4n,
  sqrtPriceX96: 0n,
}

describe("readLaunchStates", () => {
  it("maps multicall results to lowercase LaunchState", async () => {
    const client = { multicall: async () => [raw] } as unknown as StateReader
    const hook = "0x893183da2411c7df81f103bfef09e4e46c326ac4"
    const launchId = `0x${"11".repeat(32)}` as const
    expect(await readLaunchStates(client, [{ hook, launchId }], 10n)).toEqual([
      {
        token: "0xabcdef0000000000000000000000000000000001",
        sold: 1n,
        raised: 2n,
        netContributions: 3n,
        targetRaise: 4n,
        saleSupply: 5n,
        gainBps: 50_000,
        finalized: false,
      },
    ])
  })

  it("makes no call for no keys", async () => {
    const client = {
      multicall: async () => {
        throw new Error("should not be called")
      },
    } as unknown as StateReader
    expect(await readLaunchStates(client, [], 10n)).toEqual([])
  })
})

describe("readErc20Names", () => {
  const A = "0x00000000000000000000000000000000000000a1"
  const B = "0x00000000000000000000000000000000000000b2"

  it("reads symbol and name of each token at a block; a call that fails gives null", async () => {
    let args: { allowFailure?: boolean; blockNumber?: bigint; contracts?: unknown[] } = {}
    const client = {
      multicall: async (a: typeof args) => {
        args = a
        return [
          { status: "success", result: "AAA" },
          { status: "success", result: "Token A" },
          { status: "failure", error: new Error("reverted") },
          { status: "success", result: "Token B" },
        ]
      },
    } as unknown as StateReader
    expect(await readErc20Names(client, [A, B], 77n)).toEqual([
      { symbol: "AAA", name: "Token A" },
      { symbol: null, name: "Token B" },
    ])
    expect(args.allowFailure).toBe(true)
    expect(args.blockNumber).toBe(77n)
    expect(args.contracts).toHaveLength(4)
  })

  it("treats an empty string as no value, and makes no call for no tokens", async () => {
    const client = {
      multicall: async () => [
        { status: "success", result: "" },
        { status: "success", result: "" },
      ],
    } as unknown as StateReader
    expect(await readErc20Names(client, [A], 1n)).toEqual([{ symbol: null, name: null }])
    const none = {
      multicall: async () => {
        throw new Error("should not be called")
      },
    } as unknown as StateReader
    expect(await readErc20Names(none, [], 1n)).toEqual([])
  })
})
