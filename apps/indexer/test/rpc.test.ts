import type { PublicClient, RpcLog } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toChainLog, watchHeads } from "../src/rpc"

afterEach(() => {
  vi.useRealTimers()
})

describe("toChainLog", () => {
  const rpcLog = {
    address: "0xABCDEF0000000000000000000000000000000001",
    topics: ["0x01"],
    data: "0x",
    blockNumber: "0x10",
    blockHash: "0xAB",
    transactionHash: "0xCD",
    transactionIndex: "0x0",
    logIndex: "0x2",
    removed: false,
  } as unknown as RpcLog

  it("normalizes a mined RPC log", () => {
    expect(toChainLog(rpcLog)).toEqual({
      address: "0xabcdef0000000000000000000000000000000001",
      topics: ["0x01"],
      data: "0x",
      blockNumber: 16n,
      blockHash: "0xab",
      transactionHash: "0xcd",
      logIndex: 2,
    })
  })

  it("rejects pending logs", () => {
    expect(() => toChainLog({ ...rpcLog, blockNumber: null } as unknown as RpcLog)).toThrow(
      /pending/,
    )
  })
})

describe("watchHeads", () => {
  it("ticks on every head, and on its own when heads stop for 30 s", () => {
    vi.useFakeTimers()
    let emit = () => {}
    const client = {
      watchBlockNumber: (opts: { onBlockNumber: (n: bigint) => void }) => {
        emit = () => opts.onBlockNumber(1n)
        return () => {}
      },
    } as unknown as Pick<PublicClient, "watchBlockNumber">
    let ticks = 0
    const warnings: string[] = []
    const stop = watchHeads(
      client,
      () => ticks++,
      (level, msg) => {
        if (level === "warn") warnings.push(msg)
      },
    )

    emit()
    vi.advanceTimersByTime(20_000)
    emit()
    expect(ticks).toBe(2)
    expect(warnings).toEqual([])

    vi.advanceTimersByTime(40_000)
    expect(ticks).toBeGreaterThan(2)
    expect(warnings[0]).toMatch(/no new head/)
    stop()
  })
})

describe("watchHeads polling", () => {
  it("passes poll through to the subscription", () => {
    const seen: unknown[] = []
    const client = {
      watchBlockNumber: (opts: { poll: boolean }) => {
        seen.push(opts.poll)
        return () => {}
      },
    } as unknown as Pick<PublicClient, "watchBlockNumber">
    watchHeads(
      client,
      () => {},
      () => {},
      30_000,
      true,
    ).call(null)
    watchHeads(
      client,
      () => {},
      () => {},
    ).call(null)
    expect(seen).toEqual([true, false])
  })
})
