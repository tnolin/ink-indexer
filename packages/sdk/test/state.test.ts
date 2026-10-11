import { describe, expect, it } from "vitest"
import { readLaunchStates, type StateReader } from "../src/index"

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
