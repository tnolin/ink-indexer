import { describe, expect, it } from "vitest"
import { LogRouter, type LogTransport, seedFor } from "../src/rpc"

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

describe("seedFor", () => {
  it("uses the measured caps by hostname", () => {
    expect(seedFor("wss://ink.drpc.org")).toBe(100)
    expect(seedFor("wss://rpc-qnd.inkonchain.com")).toBe(10_000)
    expect(seedFor("wss://ws-gel.inkonchain.com")).toBe(1_000)
    expect(seedFor("wss://example.com/rpc")).toBe(1_000)
  })
})

describe("LogRouter", () => {
  it("routes to the healthy transport with the largest range", async () => {
    const drpc = transport("drpc", 100)
    const qn = transport("qn", 10_000)
    const router = new LogRouter([drpc, qn], fakeClock(), quiet)
    expect(await router.getLogs(1n, 50_000n, [])).toEqual({ logs: [], toBlock: 10_000n })
    expect(qn.calls).toEqual([[1n, 10_000n]])
    expect(drpc.calls).toEqual([])
  })

  it("halves on any error, whatever the message, and retries from the same block", async () => {
    const drpc = transport("drpc", 100)
    const qn = transport("qn", 10_000, (from, to) => to - from + 1n > 2_500n)
    const router = new LogRouter([drpc, qn], fakeClock(), quiet)
    expect((await router.getLogs(1n, FAR, [])).toBlock).toBe(2_500n)
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

  it("doubles back after 20 consecutive successes, never past the seed", async () => {
    const gel = transport("gel", 1_000, (_f, _t, call) => call === 1)
    const router = new LogRouter([gel], fakeClock(), quiet)
    await router.getLogs(1n, FAR, [])
    expect(router.ranges()[0]!.range).toBe(500)
    for (let i = 0; i < 19; i++) await router.getLogs(1n, FAR, [])
    expect(router.ranges()[0]!.range).toBe(1_000)
    for (let i = 0; i < 20; i++) await router.getLogs(1n, FAR, [])
    expect(router.ranges()[0]!.range).toBe(1_000)
  })

  it("benches a transport for 60 s after it fails at range 1", async () => {
    const clock = fakeClock()
    const a = transport("a", 1, (_f, _t, call) => call === 1)
    const b = transport("b", 1)
    const router = new LogRouter([a, b], clock, quiet)
    await router.getLogs(1n, 5n, [])
    expect([a.calls.length, b.calls.length]).toEqual([1, 1])
    await router.getLogs(1n, 5n, [])
    expect([a.calls.length, b.calls.length]).toEqual([1, 2])
    clock.t += 60_000
    await router.getLogs(1n, 5n, [])
    expect(a.calls.length).toBe(2)
  })

  it("benches a transport after 5 consecutive failures", async () => {
    const a = transport("a", 10_000, () => true)
    const b = transport("b", 100)
    const router = new LogRouter([a, b], fakeClock(), quiet)
    expect((await router.getLogs(1n, FAR, [])).toBlock).toBe(100n)
    expect(a.calls.map(([f, t]) => t - f + 1n)).toEqual([10_000n, 5_000n, 2_500n, 1_250n, 625n])
    expect(router.ranges()[0]).toMatchObject({ healthy: false })
  })

  it("backs off when every transport is benched, then retries the same span", async () => {
    const clock = fakeClock()
    const a = transport("a", 1, (_f, _t, call) => call === 1)
    const router = new LogRouter([a], clock, quiet)
    expect((await router.getLogs(7n, 9n, [])).toBlock).toBe(7n)
    expect(clock.t).toBe(61_000) // 1 + 2 + 4 + 8 + 16 + 30 seconds of backoff
    expect(a.calls).toEqual([
      [7n, 7n],
      [7n, 7n],
    ])
  })

  it("clamps the span to the transport's own head and returns the clamped toBlock", async () => {
    const qn = transport("qn", 10_000, () => false, 5_000n)
    const router = new LogRouter([qn], fakeClock(), quiet)
    expect(await router.getLogs(1n, FAR, [])).toEqual({ logs: [], toBlock: 5_000n })
    expect(qn.calls).toEqual([[1n, 5_000n]])
  })

  it("skips a transport whose head is below the start block", async () => {
    const behind = transport("behind", 10_000, () => false, 10n)
    const ok = transport("ok", 100)
    const router = new LogRouter([behind, ok], fakeClock(), quiet)
    expect(await router.getLogs(50n, 1_000n, [])).toEqual({ logs: [], toBlock: 149n })
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
    expect(await router.getLogs(11n, FAR, [])).toEqual({ logs: [], toBlock: 20n })
    expect(clock.t).toBe(1_000)
  })

  it("caches a transport's head for one second", async () => {
    const clock = fakeClock()
    const qn = transport("qn", 10_000)
    const router = new LogRouter([qn], clock, quiet)
    await router.getLogs(1n, 10n, [])
    await router.getLogs(11n, 20n, [])
    expect(qn.headCalls).toBe(1)
    clock.t += 1_000
    await router.getLogs(21n, 30n, [])
    expect(qn.headCalls).toBe(2)
  })
})
