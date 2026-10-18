import type { PublicClient, RpcLog } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { connectRpc, toChainLog, watchHeads } from "../src/rpc"

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

describe("transport getLogs", () => {
  const A = `0x${"a".repeat(64)}` as const
  const B = `0x${"b".repeat(64)}` as const
  const ZERO = `0x${"0".repeat(64)}` as const
  const SEADROP = "0x00005ea00ac477b1030ce78506496e8c2de24bf5" as const

  /** Answers the startup and head reads and records the params of every eth_getLogs. */
  async function wire(
    filter: Parameters<Awaited<ReturnType<typeof connectRpc>>["router"]["getLogs"]>[2],
  ) {
    const sent: unknown[] = []
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.method === "eth_getLogs") sent.push(body.params)
      const result: Record<string, unknown> = { eth_chainId: "0xdef1", eth_blockNumber: "0x64" }
      const res = { jsonrpc: "2.0", id: body.id, result: result[body.method] ?? [] }
      return new Response(JSON.stringify(res), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    const { router } = await connectRpc(["https://a.test"], () => {}, { fetchFn, rank: false })
    await router.getLogs(16n, 32n, filter)
    return sent
  }

  it("sends address and positional topics", async () => {
    expect(await wire({ address: SEADROP, topics: [[A, B], null, ZERO] })).toEqual([
      [{ fromBlock: "0x10", toBlock: "0x20", address: SEADROP, topics: [[A, B], null, ZERO] }],
    ])
  })

  it("omits address when the filter has none", async () => {
    expect(await wire({ topics: [[A, B]] })).toEqual([
      [{ fromBlock: "0x10", toBlock: "0x20", topics: [[A, B]] }],
    ])
  })
})
