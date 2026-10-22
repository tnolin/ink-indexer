import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import { logStarted, readTickMinIntervalMs } from "../src/wiring"

/** An indexer whose ticks only record when they started, and run until `release` is called. */
class Probe extends Indexer {
  starts: number[] = []
  hold = false
  private waiting: (() => void)[] = []
  constructor(tickMinIntervalMs?: number) {
    super({ tickMinIntervalMs } as ConstructorParameters<typeof Indexer>[0])
  }
  override async tick() {
    this.starts.push(Date.now())
    if (this.hold) await new Promise<void>((r) => this.waiting.push(r))
  }
  release() {
    for (const r of this.waiting.splice(0)) r()
  }
}

const T0 = 1_000_000
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => vi.useRealTimers())

describe("TICK_MIN_INTERVAL_MS in the loop", () => {
  it("0 starts a tick on every trigger, and folds triggers during a tick into one more", async () => {
    const p = new Probe(0)
    await p.trigger()
    await p.trigger()
    expect(p.starts).toEqual([T0, T0])
    p.hold = true
    const first = p.trigger()
    p.trigger()
    p.trigger()
    await vi.advanceTimersByTimeAsync(0)
    p.hold = false
    p.release()
    await first
    expect(p.starts).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("unset behaves like 0", async () => {
    const p = new Probe()
    await p.trigger()
    await p.trigger()
    expect(p.starts).toEqual([T0, T0])
  })

  it("five triggers within 1 s of a tick start make one tick, at +2500 ms", async () => {
    const p = new Probe(2500)
    await p.trigger()
    const settled: number[] = []
    const all: Promise<void>[] = []
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(200)
      all.push(p.trigger().then(() => void settled.push(Date.now())))
    }
    expect(p.starts).toEqual([T0])
    await vi.advanceTimersByTimeAsync(1_499)
    expect(p.starts).toEqual([T0])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all(all)
    expect(p.starts).toEqual([T0, T0 + 2500])
    expect(settled).toEqual(Array(5).fill(T0 + 2500))
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a trigger after the interval starts at once", async () => {
    const p = new Probe(2500)
    await p.trigger()
    await vi.advanceTimersByTimeAsync(2500)
    await p.trigger()
    expect(p.starts).toEqual([T0, T0 + 2500])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a trigger during a running tick makes one follow-up that still waits out the interval", async () => {
    const p = new Probe(2500)
    p.hold = true
    const first = p.trigger()
    await vi.advanceTimersByTimeAsync(100)
    p.trigger()
    const last = p.trigger()
    await vi.advanceTimersByTimeAsync(300) // the first tick takes 400 ms
    p.hold = false
    p.release()
    await vi.advanceTimersByTimeAsync(2_099)
    expect(p.starts).toEqual([T0])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, last])
    expect(p.starts).toEqual([T0, T0 + 2500])
  })

  it("stop clears the pending timer, settles the waiting triggers and starts no tick", async () => {
    const p = new Probe(2500)
    await p.trigger()
    const waiting = p.trigger()
    expect(vi.getTimerCount()).toBe(1)
    p.stop()
    expect(vi.getTimerCount()).toBe(0)
    await waiting
    await vi.advanceTimersByTimeAsync(10_000)
    expect(p.starts).toEqual([T0])
  })
})

describe("TICK_MIN_INTERVAL_MS setting", () => {
  const run = (env: Record<string, string | undefined>) => {
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = []
    const log: Logger = (level, msg, fields) => void logs.push({ level, msg, fields })
    return { value: readTickMinIntervalMs(env, log), logs }
  }

  it("unset, empty and 0 are 0", () => {
    for (const v of [undefined, "", " ", "0"])
      expect(run({ TICK_MIN_INTERVAL_MS: v }), String(v)).toEqual({ value: 0, logs: [] })
  })

  it("reads a whole number", () => {
    expect(run({ TICK_MIN_INTERVAL_MS: " 2500 " }).value).toBe(2500)
  })

  it("an invalid value falls back to 0 with one warning that does not contain the value", () => {
    for (const v of ["-1", "1.5", "abc", "60001", "9f2c41d07be35a68"]) {
      const { value, logs } = run({ TICK_MIN_INTERVAL_MS: v })
      expect(value, v).toBe(0)
      expect(logs, v).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        level: "warn",
        fields: { variable: "TICK_MIN_INTERVAL_MS", using: 0 },
      })
      expect(JSON.stringify(logs), v).not.toContain(v)
    }
  })

  it("the startup log includes the value", () => {
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = []
    logStarted((level, msg, fields) => void logs.push({ level, msg, fields }), {
      transports: [],
      tickMinIntervalMs: 2500,
    })
    expect(logs).toEqual([
      {
        level: "info",
        msg: "indexer started",
        fields: { transports: [], tickMinIntervalMs: 2500 },
      },
    ])
  })
})
