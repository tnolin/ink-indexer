import {
  BlockNotFoundError,
  ContractFunctionExecutionError,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
} from "viem"
import { describe, expect, it } from "vitest"
import { type BlockReader, viemChain } from "../src/chain"
import type { LogRouter } from "../src/rpc"

const socketError = () =>
  new WebSocketRequestError({
    url: "wss://ws-gel.inkonchain.com/",
    cause: new SocketClosedError({ url: "wss://ws-gel.inkonchain.com/" }),
  })

function setup(getBlockNumber: () => Promise<bigint>) {
  const sleeps: number[] = []
  const logged: [string, string][] = []
  const client = {
    getBlockNumber,
    getBlock: async () => {
      throw new Error("not used")
    },
  } as unknown as Parameters<typeof viemChain>[0] & BlockReader
  const chain = viemChain(client, {} as LogRouter, {
    logger: (l, m) => logged.push([l, m]),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { chain, sleeps, logged }
}

describe("viemChain socket errors", () => {
  it("logs and retries a read that fails on the socket instead of throwing", async () => {
    let calls = 0
    const { chain, sleeps, logged } = setup(async () => {
      if (++calls <= 3) throw socketError()
      return 42n
    })
    expect(await chain.getBlockNumber()).toBe(42n)
    expect(calls).toBe(4)
    expect(sleeps).toEqual([1_000, 2_000, 4_000])
    expect(logged.map(([l, m]) => `${l} ${m}`)).toEqual(
      Array(3).fill("warn RPC read failed; retrying"),
    )
  })

  it("caps the retry backoff at 30 s", async () => {
    let calls = 0
    const { chain, sleeps } = setup(async () => {
      if (++calls <= 8) throw socketError()
      return 1n
    })
    await chain.getBlockNumber()
    expect(Math.max(...sleeps)).toBe(30_000)
  })

  it("still fails fast on any other error", async () => {
    const boom = new Error("execution reverted")
    const { chain, sleeps } = setup(async () => {
      throw boom
    })
    await expect(chain.getBlockNumber()).rejects.toBe(boom)
    expect(sleeps).toEqual([])
  })

  it("keeps returning null for a missing block", async () => {
    const client = {
      getBlockNumber: async () => 1n,
      getBlock: async () => {
        throw new BlockNotFoundError({ blockNumber: 5n })
      },
    } as unknown as Parameters<typeof viemChain>[0] & BlockReader
    expect(await viemChain(client, {} as LogRouter).getBlock(5n)).toBeNull()
  })
})

const timeoutError = () => new TimeoutError({ body: {}, url: "wss://ws-gel.inkonchain.com/" })
const KEY = { hook: "0x0000000000000000000000000000000000000001", launchId: "1" } as never
const TOKEN = "0x0000000000000000000000000000000000000002" as const

function fullChain(
  multicall: () => Promise<unknown>,
  getBlock: () => Promise<unknown>,
  opts: { isStopping?: () => boolean } = {},
) {
  const sleeps: number[] = []
  const logged: string[] = []
  const client = { getBlockNumber: async () => 1n, getBlock, multicall } as unknown as Parameters<
    typeof viemChain
  >[0] &
    BlockReader
  const chain = viemChain(client, {} as LogRouter, {
    logger: (l, m) => logged.push(`${l} ${m}`),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...opts,
  })
  return { chain, sleeps, logged }
}

describe("viemChain timeouts, stopping and every read", () => {
  it("retries a timed-out read with one warn per retry", async () => {
    let calls = 0
    const { chain, sleeps, logged } = setup(async () => {
      if (++calls <= 2) throw timeoutError()
      return 7n
    })
    expect(await chain.getBlockNumber()).toBe(7n)
    expect(sleeps).toEqual([1_000, 2_000])
    expect(logged).toHaveLength(2)
  })

  it("retries a ContractFunctionExecutionError caused by a socket error or timeout", async () => {
    for (const cause of [socketError(), timeoutError()]) {
      let calls = 0
      const { chain } = fullChain(
        async () => {
          if (++calls === 1)
            throw new ContractFunctionExecutionError(cause as never, { abi: [], functionName: "f" })
          return [1n]
        },
        async () => ({}),
      )
      expect(await chain.readTotalSupplies([TOKEN], 1n)).toEqual([1n])
      expect(calls).toBe(2)
    }
  })

  it("rethrows the last error without retrying once shutdown has begun", async () => {
    let calls = 0
    const err = socketError()
    const { chain, sleeps, logged } = fullChain(
      async () => {
        calls++
        throw err
      },
      async () => ({}),
      { isStopping: () => true },
    )
    await expect(chain.readErc20Meta(TOKEN)).rejects.toBe(err)
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
    expect(logged).toEqual([])
  })

  it("stops retrying when shutdown begins between attempts", async () => {
    let stopping = false
    let calls = 0
    const err = timeoutError()
    const { chain } = fullChain(
      async () => {
        calls++
        stopping = true
        throw err
      },
      async () => ({}),
      { isStopping: () => stopping },
    )
    await expect(chain.readLaunchStates([KEY], 1n)).rejects.toBe(err)
    expect(calls).toBe(1)
  })

  it("retries getBlock and each state read on socket errors and timeouts", async () => {
    for (const mk of [socketError, timeoutError]) {
      let n = 0
      const flaky =
        <T>(v: T) =>
        async () => {
          if (++n % 2 === 1) throw mk()
          return v
        }
      const hash = `0x${"AB".repeat(32)}`
      const { chain } = fullChain(
        flaky([{ token: TOKEN, sold: 1n }]),
        flaky({ hash, timestamp: 5n }),
      )
      expect(await chain.getBlock(1n)).toEqual({ hash: hash.toLowerCase(), timestamp: 5n })
      const supplyChain = fullChain(flaky([3n]), async () => ({}))
      expect(await supplyChain.chain.readTotalSupplies([TOKEN], 1n)).toEqual([3n])
      const metaChain = fullChain(flaky([18, "T"]), async () => ({}))
      expect(await metaChain.chain.readErc20Meta(TOKEN)).toEqual({ decimals: 18, symbol: "T" })
      const launchChain = fullChain(
        flaky([
          {
            token: TOKEN,
            sold: 1n,
            raised: 1n,
            netContributions: 1n,
            targetRaise: 1n,
            saleSupply: 1n,
            gainBps: 1n,
            finalized: false,
          },
        ]),
        async () => ({}),
      )
      expect(await launchChain.chain.readLaunchStates([KEY], 1n)).toHaveLength(1)
    }
  })

  it("retries a mint stats read on socket errors and returns null for a revert", async () => {
    const words = (...n: bigint[]) =>
      `0x${n.map((x) => x.toString(16).padStart(64, "0")).join("")}` as const
    let calls = 0
    const client = {
      getBlockNumber: async () => 1n,
      getBlock: async () => ({}),
      call: async () => {
        if (++calls === 1) throw socketError()
        return { data: words(0n, 7n, 10n) }
      },
    } as unknown as Parameters<typeof viemChain>[0] & BlockReader
    const chain = viemChain(client, {} as LogRouter, { logger: () => {}, sleep: async () => {} })
    expect(await chain.readMintStats(TOKEN, TOKEN, 1n)).toEqual({ totalSupply: 7n, maxSupply: 10n })
    expect(calls).toBe(2)

    const reverting = viemChain(
      {
        ...client,
        call: async () => {
          throw Object.assign(new Error("reverted"), { code: 3 })
        },
      } as never,
      {} as LogRouter,
    )
    expect(await reverting.readMintStats(TOKEN, TOKEN, 1n)).toBeNull()
  })

  it("still fails fast from every read on a non-socket error", async () => {
    const boom = new ContractFunctionExecutionError(new Error("execution reverted") as never, {
      abi: [],
      functionName: "f",
    })
    const reject = async () => {
      throw boom
    }
    const { chain, sleeps } = fullChain(reject, reject)
    await expect(chain.getBlock(1n)).rejects.toBe(boom)
    await expect(chain.readLaunchStates([KEY], 1n)).rejects.toBe(boom)
    await expect(chain.readTotalSupplies([TOKEN], 1n)).rejects.toBe(boom)
    await expect(chain.readErc20Meta(TOKEN)).rejects.toBe(boom)
    expect(sleeps).toEqual([])
  })
})

describe("viemChain repeated failures", () => {
  it("warns for the first four consecutive failures and logs errors from the fifth, naming call and endpoint", async () => {
    const logged: [string, string, Record<string, unknown> | undefined][] = []
    let calls = 0
    const client = {
      getBlockNumber: async () => {
        if (++calls <= 6) throw timeoutError()
        return 1n
      },
      getBlock: async () => ({}),
    } as unknown as Parameters<typeof viemChain>[0] & BlockReader
    const chain = viemChain(client, {} as LogRouter, {
      logger: (l, m, f) => logged.push([l, m, f]),
      sleep: async () => {},
    })
    await chain.getBlockNumber()
    expect(logged.map(([l]) => l)).toEqual(["warn", "warn", "warn", "warn", "error", "error"])
    expect(logged[4]![2]).toMatchObject({
      call: "getBlockNumber",
      failures: 5,
      url: "wss://ws-gel.inkonchain.com/",
    })
    expect(logged[0]![2]).toMatchObject({ call: "getBlockNumber", failures: 1 })
  })

  it("counts consecutive failures per call, starting again after a success", async () => {
    const levels: string[] = []
    let calls = 0
    const client = {
      getBlockNumber: async () => {
        // fail 3, succeed, fail 3, succeed
        if (calls++ % 4 !== 3) throw timeoutError()
        return 1n
      },
      getBlock: async () => ({}),
    } as unknown as Parameters<typeof viemChain>[0] & BlockReader
    const chain = viemChain(client, {} as LogRouter, {
      logger: (l) => levels.push(l),
      sleep: async () => {},
    })
    await chain.getBlockNumber()
    await chain.getBlockNumber()
    expect(levels).toEqual(Array(6).fill("warn"))
  })
})
