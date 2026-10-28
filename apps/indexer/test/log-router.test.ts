import {
  ContractFunctionExecutionError,
  HttpRequestError,
  RpcRequestError,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
} from "viem"
import { describe, expect, it } from "vitest"
import {
  type GetLogsParams,
  isConnectionError,
  isSocketError,
  type LogFilter,
  LogRouter,
  type LogTransport,
  seedFor,
} from "../src/rpc"

function fakeClock() {
  const c = {
    t: 0,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms
    },
  }
  return c
}

function transport(
  name: string,
  seed: number,
  fail: (from: bigint, to: bigint, call: number) => boolean = () => false,
  head = 10n ** 18n,
) {
  const calls: [bigint, bigint][] = []
  const t: LogTransport & { calls: [bigint, bigint][]; head: bigint; headCalls: number } = {
    name,
    seed,
    calls,
    head,
    headCalls: 0,
    getBlockNumber: async () => {
      t.headCalls++
      return t.head
    },
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push([fromBlock, toBlock])
      if (fail(fromBlock, toBlock, calls.length))
        throw new Error("Temporary internal error. Please retry")
      return []
    },
  }
  return t
}

const quiet = () => {}
const FAR = 10n ** 9n
const NO_FILTER: LogFilter = { topics: [] }

describe("seedFor", () => {
  it("uses the measured caps by hostname", () => {
    expect(seedFor("wss://ink.drpc.org")).toBe(100)
    expect(seedFor("wss://rpc-qnd.inkonchain.com")).toBe(10_000)
    expect(seedFor("wss://ws-gel.inkonchain.com")).toBe(1_000)
    expect(seedFor("wss://example.com/rpc")).toBe(1_000)
  })
})

describe("LogRouter", () => {
  it("passes the filter through unchanged", async () => {
    const seen: GetLogsParams[] = []
    const t = transport("t", 1_000)
    t.getLogs = async (p) => {
      seen.push(p)
      return []
    }
    const filter: LogFilter = {
      address: [
        "0x00005ea00ac477b1030ce78506496e8c2de24bf5",
        "0x0000000000000000000000000000000000000001",
      ],
      topics: [["0xaa", "0xbb"], null, `0x${"0".repeat(64)}`],
    }
    await new LogRouter([t], fakeClock(), quiet).getLogs(5n, 10n, filter)
    expect(seen).toEqual([{ fromBlock: 5n, toBlock: 10n, ...filter }])
    expect(seen[0]!.topics).toBe(filter.topics)
  })

  it("routes to the healthy transport with the largest range", async () => {
    const drpc = transport("drpc", 100)
    const qn = transport("qn", 10_000)
    const router = new LogRouter([drpc, qn], fakeClock(), quiet)
    expect(await router.getLogs(1n, 50_000n, NO_FILTER)).toEqual({ logs: [], toBlock: 10_000n })
    expect(qn.calls).toEqual([[1n, 10_000n]])
    expect(drpc.calls).toEqual([])
  })

  it("halves on any error, whatever the message, and retries from the same block", async () => {
    const drpc = transport("drpc", 100)
    const qn = transport("qn", 10_000, (from, to) => to - from + 1n > 2_500n)
    const router = new LogRouter([drpc, qn], fakeClock(), quiet)
    expect((await router.getLogs(1n, FAR, NO_FILTER)).toBlock).toBe(2_500n)
    expect(qn.calls).toEqual([
      [1n, 10_000n],
      [1n, 5_000n],
      [1n, 2_500n],
    ])
    expect(router.ranges()).toEqual([
      { name: "drpc", range: 100, healthy: true },
      { name: "qn", range: 2_500, healthy: true },
    ])
  })

  describe("a failure at the transport's own tip", () => {
    const BEYOND = () =>
      new RpcRequestError({
        body: {},
        url: "x",
        error: { code: -32602, message: "block range extends beyond current head block" },
      })
    const record = () => {
      const lines: [string, string][] = []
      return { lines, logger: (level: string, msg: string) => lines.push([level, msg]) }
    }

    it("neither halves nor warns, and the next call fetches the blocks", async () => {
      const { lines, logger } = record()
      let tipServed = false
      const gel = transport("gel", 1_000, () => false, 59_626_729n)
      gel.getLogs = async ({ fromBlock, toBlock }) => {
        gel.calls.push([fromBlock, toBlock])
        if (!tipServed) throw BEYOND()
        return []
      }
      const clock = fakeClock()
      const sleep = clock.sleep
      clock.sleep = async (ms) => {
        await sleep(ms)
        tipServed = true
      }
      const router = new LogRouter([gel], clock, logger)
      const r = await router.getLogs(59_626_727n, FAR, NO_FILTER)
      expect(r.toBlock).toBe(59_626_729n)
      expect(gel.calls).toEqual([
        [59_626_727n, 59_626_729n],
        [59_626_727n, 59_626_729n],
      ])
      expect(router.ranges()[0]!.range).toBe(1_000)
      expect(lines.filter(([l]) => l === "warn" || l === "error")).toEqual([])
    })

    it("still halves and warns when the failing span is well below the head", async () => {
      const { lines, logger } = record()
      const gel = transport("gel", 1_000, (_f, _t, call) => call === 1, 10_000n)
      gel.getLogs = async ({ fromBlock, toBlock }) => {
        gel.calls.push([fromBlock, toBlock])
        if (gel.calls.length === 1) throw BEYOND()
        return []
      }
      const router = new LogRouter([gel], fakeClock(), logger)
      await router.getLogs(100n, FAR, NO_FILTER)
      expect(router.ranges()[0]!.range).toBe(500)
      expect(lines).toContainEqual(["warn", "getLogs failed"])
    })

    it("treats a refusal as at the tip when the span starts exactly 5 blocks below the head", async () => {
      const { lines, logger } = record()
      const gel = transport("gel", 1_000, () => false, 59_626_729n)
      gel.getLogs = async ({ fromBlock, toBlock }) => {
        gel.calls.push([fromBlock, toBlock])
        throw BEYOND()
      }
      const ok = transport("ok", 1_000, () => false, 59_626_729n)
      const router = new LogRouter([gel, ok], fakeClock(), logger)
      await router.getLogs(59_626_724n, FAR, NO_FILTER)
      expect(router.ranges()[0]!.range).toBe(1_000)
      expect(lines.filter(([l]) => l === "warn" || l === "error")).toEqual([])
    })

    it("treats a refusal as at the tip for a 20-block span that ends at the head", async () => {
      const { lines, logger } = record()
      const gel = transport("gel", 1_000, () => false, 59_626_729n)
      gel.getLogs = async ({ fromBlock, toBlock }) => {
        gel.calls.push([fromBlock, toBlock])
        throw BEYOND()
      }
      const ok = transport("ok", 1_000, () => false, 59_626_729n)
      const router = new LogRouter([gel, ok], fakeClock(), logger)
      await router.getLogs(59_626_710n, FAR, NO_FILTER)
      expect(gel.calls).toEqual([[59_626_710n, 59_626_729n]])
      expect(router.ranges()[0]!.range).toBe(1_000)
      expect(lines.filter(([l]) => l === "warn" || l === "error")).toEqual([])
    })

    it("still halves a refusal on a span that starts 40 blocks below the head", async () => {
      const { lines, logger } = record()
      const gel = transport("gel", 1_000, () => false, 59_626_729n)
      gel.getLogs = async ({ fromBlock, toBlock }) => {
        gel.calls.push([fromBlock, toBlock])
        if (gel.calls.length === 1) throw BEYOND()
        return []
      }
      const router = new LogRouter([gel], fakeClock(), logger)
      await router.getLogs(59_626_689n, FAR, NO_FILTER)
      expect(router.ranges()[0]!.range).toBe(500)
      expect(lines).toContainEqual(["warn", "getLogs failed"])
    })

    it("still halves a large span that ends at the head", async () => {
      const gel = transport("gel", 1_000, (_f, _t, call) => call === 1, 5_000n)
      const router = new LogRouter([gel], fakeClock(), quiet)
      await router.getLogs(1n, FAR, NO_FILTER)
      expect(router.ranges()[0]!.range).toBe(500)
    })

    it("treats an HTTP 500 at the tip as not there yet, and never as a repeated failure", async () => {
      const { lines, logger } = record()
      const drpc = transport("drpc", 100, () => false, 59_300_000n)
      drpc.getLogs = async ({ fromBlock, toBlock }) => {
        drpc.calls.push([fromBlock, toBlock])
        throw new HttpRequestError({ url: "x", status: 500 })
      }
      const ok = transport("ok", 50, () => false, 59_300_000n)
      const router = new LogRouter([drpc, ok], fakeClock(), logger)
      for (let i = 0; i < 8; i++) await router.getLogs(59_299_998n, FAR, NO_FILTER)
      expect(drpc.calls.length).toBe(8)
      expect(router.ranges()[0]).toEqual({ name: "drpc", range: 100, healthy: true })
      expect(lines.filter(([l]) => l === "warn" || l === "error")).toEqual([])
    })

    it("still halves and warns on an HTTP 500 below the tip", async () => {
      const { lines, logger } = record()
      const drpc = transport("drpc", 100, () => false, 59_300_000n)
      drpc.getLogs = async ({ fromBlock, toBlock }) => {
        drpc.calls.push([fromBlock, toBlock])
        if (drpc.calls.length === 1) throw new HttpRequestError({ url: "x", status: 500 })
        return []
      }
      const router = new LogRouter([drpc], fakeClock(), logger)
      await router.getLogs(59_000_000n, FAR, NO_FILTER)
      expect(router.ranges()[0]!.range).toBe(50)
      expect(lines).toContainEqual(["warn", "getLogs failed"])
    })

    it("still treats a 429 at the tip as a rate limit", async () => {
      const { lines, logger } = record()
      const drpc = transport("drpc", 1_000, () => false, 100n)
      drpc.getLogs = async () => {
        throw new HttpRequestError({ url: "x", status: 429 })
      }
      const router = new LogRouter(
        [drpc, transport("ok", 1_000, () => false, 100n)],
        fakeClock(),
        logger,
      )
      await router.getLogs(99n, FAR, NO_FILTER)
      expect(router.ranges()[0]!.range).toBe(500)
      expect(lines).toContainEqual(["warn", "getLogs failed"])
    })

    it("does not stall when another transport can serve the range", async () => {
      const { lines, logger } = record()
      const clock = fakeClock()
      const gel = transport("gel", 1_000, () => false, 200n)
      gel.getLogs = async () => {
        throw BEYOND()
      }
      const qn = transport("qn", 100, () => false, 200n)
      const router = new LogRouter([gel, qn], clock, logger)
      for (let i = 0; i < 30; i++)
        expect((await router.getLogs(198n, FAR, NO_FILTER)).toBlock).toBe(200n)
      expect(clock.t).toBe(0)
      expect(router.ranges()[0]).toEqual({ name: "gel", range: 1_000, healthy: true })
      expect(lines.filter(([l]) => l === "warn" || l === "error")).toEqual([])
    })
  })

  it("doubles back after 20 consecutive successes, never past the seed", async () => {
    const gel = transport("gel", 1_000, (_f, _t, call) => call === 1)
    const router = new LogRouter([gel], fakeClock(), quiet)
    await router.getLogs(1n, FAR, NO_FILTER)
    expect(router.ranges()[0]!.range).toBe(500)
    for (let i = 0; i < 19; i++) await router.getLogs(1n, FAR, NO_FILTER)
    expect(router.ranges()[0]!.range).toBe(1_000)
    for (let i = 0; i < 20; i++) await router.getLogs(1n, FAR, NO_FILTER)
    expect(router.ranges()[0]!.range).toBe(1_000)
  })

  it("benches a transport for 60 s after it fails at range 1", async () => {
    const clock = fakeClock()
    const a = transport("a", 1, (_f, _t, call) => call === 1)
    const b = transport("b", 1)
    const router = new LogRouter([a, b], clock, quiet)
    await router.getLogs(1n, 5n, NO_FILTER)
    expect([a.calls.length, b.calls.length]).toEqual([1, 1])
    await router.getLogs(1n, 5n, NO_FILTER)
    expect([a.calls.length, b.calls.length]).toEqual([1, 2])
    clock.t += 60_000
    await router.getLogs(1n, 5n, NO_FILTER)
    expect(a.calls.length).toBe(2)
  })

  it("benches a transport after 5 consecutive failures", async () => {
    const a = transport("a", 10_000, () => true)
    const b = transport("b", 100)
    const router = new LogRouter([a, b], fakeClock(), quiet)
    expect((await router.getLogs(1n, FAR, NO_FILTER)).toBlock).toBe(100n)
    expect(a.calls.map(([f, t]) => t - f + 1n)).toEqual([10_000n, 5_000n, 2_500n, 1_250n, 625n])
    expect(router.ranges()[0]).toMatchObject({ healthy: false })
  })

  it("backs off when every transport is benched, then retries the same span", async () => {
    const clock = fakeClock()
    const a = transport("a", 1, (_f, _t, call) => call === 1)
    const router = new LogRouter([a], clock, quiet)
    expect((await router.getLogs(7n, 9n, NO_FILTER)).toBlock).toBe(7n)
    expect(clock.t).toBe(61_000) // 1 + 2 + 4 + 8 + 16 + 30 seconds of backoff
    expect(a.calls).toEqual([
      [7n, 7n],
      [7n, 7n],
    ])
  })

  it("clamps the span to the transport's own head and returns the clamped toBlock", async () => {
    const qn = transport("qn", 10_000, () => false, 5_000n)
    const router = new LogRouter([qn], fakeClock(), quiet)
    expect(await router.getLogs(1n, FAR, NO_FILTER)).toEqual({ logs: [], toBlock: 5_000n })
    expect(qn.calls).toEqual([[1n, 5_000n]])
  })

  it("skips a transport whose head is below the start block", async () => {
    const behind = transport("behind", 10_000, () => false, 10n)
    const ok = transport("ok", 100)
    const router = new LogRouter([behind, ok], fakeClock(), quiet)
    expect(await router.getLogs(50n, 1_000n, NO_FILTER)).toEqual({ logs: [], toBlock: 149n })
    expect(behind.calls).toEqual([])
    expect(ok.calls).toEqual([[50n, 149n]])
  })

  it("waits for a lagging transport to catch up instead of returning without progress", async () => {
    const clock = fakeClock()
    const gel = transport("gel", 1_000, () => false, 10n)
    const sleep = clock.sleep
    clock.sleep = async (ms) => {
      await sleep(ms)
      gel.head = 20n
    }
    const router = new LogRouter([gel], clock, quiet)
    expect(await router.getLogs(11n, FAR, NO_FILTER)).toEqual({ logs: [], toBlock: 20n })
    expect(clock.t).toBe(1_000)
  })

  it("caches a transport's head for one second", async () => {
    const clock = fakeClock()
    const qn = transport("qn", 10_000)
    const router = new LogRouter([qn], clock, quiet)
    await router.getLogs(1n, 10n, NO_FILTER)
    await router.getLogs(11n, 20n, NO_FILTER)
    expect(qn.headCalls).toBe(1)
    clock.t += 1_000
    await router.getLogs(21n, 30n, NO_FILTER)
    expect(qn.headCalls).toBe(2)
  })
})

describe("socket errors", () => {
  const pingError = () =>
    new WebSocketRequestError({
      url: "wss://ws-gel.inkonchain.com/",
      cause: new SocketClosedError({ url: "wss://ws-gel.inkonchain.com/" }),
    })

  it("classifies socket-level errors only", () => {
    expect(isSocketError(pingError())).toBe(true)
    expect(isSocketError(new SocketClosedError({ url: "wss://x" }))).toBe(true)
    expect(isSocketError({ type: "error", defaultPrevented: false })).toBe(true)
    expect(isSocketError(new Error("Temporary internal error. Please retry"))).toBe(false)
    expect(isSocketError(new Error("WebSocket request failed"))).toBe(false)
  })

  it("does not treat other viem errors as socket errors, but follows causes", () => {
    const rpc = new RpcRequestError({
      body: {},
      error: { code: -32000, message: "execution reverted" },
      url: "wss://x",
    })
    const timeout = new TimeoutError({ body: {}, url: "wss://x" })
    const exec = (cause: Error) =>
      new ContractFunctionExecutionError(cause as never, { abi: [], functionName: "f" })
    expect(isSocketError(rpc)).toBe(false)
    expect(isSocketError(timeout)).toBe(false)
    expect(isSocketError(exec(rpc))).toBe(false)
    expect(isSocketError(exec(pingError()))).toBe(true)
    expect(isSocketError(exec(new SocketClosedError({ url: "wss://x" })))).toBe(true)
  })

  it("logs a socket error, benches that transport at once and leaves the others alone", async () => {
    const logged: [string, string, Record<string, unknown> | undefined][] = []
    const gel = transport("ws-gel.inkonchain.com", 10_000)
    gel.getLogs = async () => {
      throw pingError()
    }
    const qn = transport("qn", 1_000)
    const router = new LogRouter([gel, qn], fakeClock(), (l, m, f) => logged.push([l, m, f]))
    expect(await router.getLogs(1n, FAR, NO_FILTER)).toEqual({ logs: [], toBlock: 1_000n })
    expect(router.ranges()).toEqual([
      { name: "ws-gel.inkonchain.com", range: 10_000, healthy: false },
      { name: "qn", range: 1_000, healthy: true },
    ])
    expect(logged).toHaveLength(1)
    expect(logged[0]![0]).toBe("warn")
    expect(logged[0]![2]).toMatchObject({ transport: "ws-gel.inkonchain.com" })
    expect(String(logged[0]![2]!.error)).toMatch(/WebSocketRequestError/)
  })

  it("benches a transport whose block-number read fails on the socket", async () => {
    const gel = transport("gel", 10_000)
    gel.getBlockNumber = async () => {
      throw pingError()
    }
    const qn = transport("qn", 1_000)
    const router = new LogRouter([gel, qn], fakeClock(), quiet)
    await router.getLogs(1n, 10n, NO_FILTER)
    expect(router.ranges()[0]!.healthy).toBe(false)
    expect(router.ranges()[1]!.healthy).toBe(true)
  })

  it("keeps waiting, without throwing, while every transport is benched", async () => {
    const clock = fakeClock()
    const gel = transport("gel", 1_000)
    let broken = true
    const getLogs = gel.getLogs
    gel.getLogs = async (p) => {
      if (broken) throw pingError()
      return getLogs(p)
    }
    const sleep = clock.sleep
    clock.sleep = async (ms) => {
      await sleep(ms)
      if (clock.t >= 60_000) broken = false
    }
    const router = new LogRouter([gel], clock, quiet)
    expect(await router.getLogs(1n, 10n, NO_FILTER)).toEqual({ logs: [], toBlock: 10n })
  })

  it("still halves the range on other errors", async () => {
    const t = transport("t", 1_000, (_f, _t, call) => call === 1)
    const router = new LogRouter([t], fakeClock(), quiet)
    await router.getLogs(1n, 10_000n, NO_FILTER)
    expect(t.calls[1]).toEqual([1n, 500n])
    expect(router.ranges()[0]!.healthy).toBe(true)
  })
})

describe("repeated failures", () => {
  it("logs an error when a transport has failed 5 times in a row, and not before", async () => {
    const logged: [string, string, Record<string, unknown> | undefined][] = []
    const t = transport("qn", 10_000, (_f, _t, call) => call <= 5)
    const router = new LogRouter([t], fakeClock(), (l, m, f) => logged.push([l, m, f]))
    await router.getLogs(1n, 10n, NO_FILTER)
    expect(logged.filter(([l]) => l === "warn")).toHaveLength(5)
    const errors = logged.filter(([l]) => l === "error")
    expect(errors).toHaveLength(1)
    expect(errors[0]![2]).toMatchObject({ transport: "qn", failures: 5 })
    expect(logged.indexOf(errors[0]!)).toBeGreaterThanOrEqual(5)
  })
})

describe("http failures", () => {
  const fetchFailure = () =>
    new HttpRequestError({
      url: "https://rpc-qnd.inkonchain.com/",
      cause: new TypeError("fetch failed"),
    })
  const status = (n: number) =>
    new HttpRequestError({ url: "https://rpc-qnd.inkonchain.com/", status: n })

  it("classifies fetch-level failures, also through causes, apart from HTTP status errors", () => {
    expect(isConnectionError(fetchFailure())).toBe(true)
    expect(isConnectionError(new Error("wrapped", { cause: fetchFailure() }))).toBe(true)
    expect(isConnectionError(status(503))).toBe(false)
    expect(isConnectionError(status(429))).toBe(false)
    expect(isConnectionError(new Error("boom"))).toBe(false)
  })

  it("benches at once without halving the range on a fetch-level failure", async () => {
    const qn = transport("qn", 10_000)
    qn.getLogs = async () => {
      throw fetchFailure()
    }
    const ok = transport("ok", 1_000)
    const router = new LogRouter([qn, ok], fakeClock(), quiet)
    await router.getLogs(1n, FAR, NO_FILTER)
    expect(router.ranges()[0]).toEqual({ name: "qn", range: 10_000, healthy: false })
    expect(router.ranges()[1]!.healthy).toBe(true)
  })

  it("halves the range on an HTTP status error and benches only after the usual count", async () => {
    const qn = transport("qn", 10_000)
    qn.getLogs = async () => {
      throw status(503)
    }
    const ok = transport("ok", 1_000)
    const router = new LogRouter([qn, ok], fakeClock(), quiet)
    await router.getLogs(1n, FAR, NO_FILTER)
    expect(router.ranges()[0]).toEqual({ name: "qn", range: 625, healthy: true })
  })

  it("keeps logging the repeated-failure error at range 1, where every failure benches", async () => {
    const logged: [string, string, Record<string, unknown> | undefined][] = []
    const t = transport("qn", 1, (_f, _t, call) => call <= 6)
    const router = new LogRouter([t], fakeClock(), (l, m, f) => logged.push([l, m, f]))
    await router.getLogs(1n, 10n, NO_FILTER)
    const errors = logged.filter(([l]) => l === "error")
    expect(errors.map(([, , f]) => f!.failures)).toEqual([5, 6])
  })
})

describe("LogRouter.heads", () => {
  it("reads every transport's own head", async () => {
    const a = transport("a", 1_000, undefined, 40n)
    const b = transport("b", 1_000, undefined, 90n)
    const router = new LogRouter([a, b], fakeClock(), quiet)
    expect(await router.heads(0n)).toEqual([
      { name: "a", head: 40n },
      { name: "b", head: 90n },
    ])
  })

  it("skips a transport whose read fails", async () => {
    const a = transport("a", 1_000, undefined, 40n)
    const b = transport("b", 1_000, undefined, 90n)
    a.getBlockNumber = async () => {
      throw new Error("boom")
    }
    const router = new LogRouter([a, b], fakeClock(), quiet)
    expect(await router.heads(0n)).toEqual([{ name: "b", head: 90n }])
  })

  it("skips a benched transport without reading it", async () => {
    const a = transport("a", 10_000, undefined, 40n)
    const b = transport("b", 1_000, undefined, 90n)
    a.getLogs = async () => {
      throw new HttpRequestError({ url: "https://a.example" })
    }
    const clock = fakeClock()
    const router = new LogRouter([a, b], clock, quiet)
    await router.getLogs(1n, 10n, NO_FILTER)
    const reads = a.headCalls

    expect(await router.heads(0n)).toEqual([{ name: "b", head: 90n }])
    expect(a.headCalls).toBe(reads)
  })

  it("is empty when no transport answers", async () => {
    const a = transport("a", 1_000)
    a.getBlockNumber = async () => {
      throw new Error("boom")
    }
    const router = new LogRouter([a], fakeClock(), quiet)
    expect(await router.heads(0n)).toEqual([])
  })

  it("shares the one-second head cache with getLogs", async () => {
    const a = transport("a", 1_000, undefined, 40n)
    const clock = fakeClock()
    const router = new LogRouter([a], clock, quiet)
    await router.getLogs(1n, 10n, NO_FILTER)
    await router.heads(0n)
    expect(a.headCalls).toBe(1)

    clock.t += 1_000
    await router.heads(0n)
    expect(a.headCalls).toBe(2)
  })

  it("refreshes a cached head that is below `from`", async () => {
    const a = transport("a", 1_000, undefined, 40n)
    const router = new LogRouter([a], fakeClock(), quiet)
    await router.heads(0n)
    a.head = 60n
    expect(await router.heads(50n)).toEqual([{ name: "a", head: 60n }])
  })
})
