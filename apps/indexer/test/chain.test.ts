import { BlockNotFoundError, SocketClosedError, WebSocketRequestError } from "viem"
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
      Array(3).fill("warn RPC read failed on the socket; retrying"),
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
