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

describe("watchHeads reconnects and logs each outage once", () => {
  type Opts = {
    emitOnBegin: boolean
    onBlockNumber: (n: bigint) => void
    onError: (e: unknown) => void
  }
  function fakeClient() {
    const subs: { opts: Opts; stopped: boolean }[] = []
    const client = {
      watchBlockNumber: (opts: Opts) => {
        const sub = { opts, stopped: false }
        subs.push(sub)
        return () => {
          sub.stopped = true
        }
      },
    } as unknown as Pick<PublicClient, "watchBlockNumber">
    return { client, subs, live: () => subs.at(-1)! }
  }
  function logs() {
    const lines: { level: string; msg: string }[] = []
    const logger = (level: string, msg: string) => {
      lines.push({ level, msg })
    }
    return { lines, logger, count: (re: RegExp) => lines.filter((l) => re.test(l.msg)).length }
  }

  it("warns once when heads stop, and keeps ticking every 10 s", () => {
    vi.useFakeTimers()
    const { client } = fakeClient()
    const l = logs()
    let ticks = 0
    const stop = watchHeads(client, () => ticks++, l.logger as never)
    vi.advanceTimersByTime(5 * 60_000)
    expect(l.count(/no new head/)).toBe(1)
    expect(ticks).toBeGreaterThanOrEqual(25)
    stop()
  })

  it("logs the recovery once when a new head arrives, and warns again on the next outage", () => {
    vi.useFakeTimers()
    const f = fakeClient()
    const l = logs()
    const stop = watchHeads(f.client, () => {}, l.logger as never)
    vi.advanceTimersByTime(60_000)
    f.live().opts.onBlockNumber(2n)
    f.live().opts.onBlockNumber(3n)
    expect(l.count(/recovered/)).toBe(1)
    expect(l.lines.find((x) => /recovered/.test(x.msg))!.level).toBe("info")
    vi.advanceTimersByTime(60_000)
    expect(l.count(/no new head/)).toBe(2)
    stop()
  })

  it("subscribes again after the subscription errors, without emitting the current head as a new one", () => {
    vi.useFakeTimers()
    const f = fakeClient()
    const l = logs()
    const stop = watchHeads(f.client, () => {}, l.logger as never)
    expect(f.subs).toHaveLength(1)
    expect(f.subs[0]!.opts.emitOnBegin).toBe(true)
    f.subs[0]!.opts.onError(new Error("SocketClosedError: The socket has been closed."))
    vi.advanceTimersByTime(5_000)
    expect(f.subs).toHaveLength(2)
    expect(f.subs[0]!.stopped).toBe(true)
    expect(f.subs[1]!.opts.emitOnBegin).toBe(false)
    expect(l.count(/head subscription error/)).toBe(1)
    stop()
  })

  it("logs a repeating subscription error once per outage, then again after a new head", () => {
    vi.useFakeTimers()
    const f = fakeClient()
    const l = logs()
    const stop = watchHeads(f.client, () => {}, l.logger as never)
    const closed = new Error("SocketClosedError: The socket has been closed.")
    // Every resubscription fails again, and one subscription can report the same error many times.
    for (let minute = 0; minute < 10; minute++) {
      for (let i = 0; i < 100; i++) f.live().opts.onError(closed)
      vi.advanceTimersByTime(60_000)
    }
    expect(l.count(/head subscription error/)).toBe(1)
    expect(l.count(/no new head/)).toBe(0)
    f.live().opts.onBlockNumber(5n)
    expect(l.count(/recovered/)).toBe(1)
    f.live().opts.onError(closed)
    f.live().opts.onError(closed)
    expect(l.count(/head subscription error/)).toBe(2)
    stop()
  })

  it("subscribes again when heads stop without an error, backing off while it stays down", () => {
    vi.useFakeTimers()
    const f = fakeClient()
    const stop = watchHeads(f.client, () => {}, (() => {}) as never)
    vi.advanceTimersByTime(60_000)
    const afterFirstMinute = f.subs.length
    expect(afterFirstMinute).toBeGreaterThanOrEqual(2)
    vi.advanceTimersByTime(30 * 60_000)
    // Backoff doubles to a 5-minute ceiling, so 30 more minutes add a handful of attempts, not hundreds.
    expect(f.subs.length - afterFirstMinute).toBeLessThanOrEqual(12)
    expect(f.subs.length - afterFirstMinute).toBeGreaterThanOrEqual(5)
    stop()
  })

  it("stops resubscribing and ticking after stop()", () => {
    vi.useFakeTimers()
    const f = fakeClient()
    let ticks = 0
    const stop = watchHeads(f.client, () => ticks++, (() => {}) as never)
    f.live().opts.onError(new Error("closed"))
    stop()
    const subs = f.subs.length
    vi.advanceTimersByTime(10 * 60_000)
    expect(f.subs.length).toBe(subs)
    expect(ticks).toBe(0)
    expect(f.live().stopped).toBe(true)
  })
})
