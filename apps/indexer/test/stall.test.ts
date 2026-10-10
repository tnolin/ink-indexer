import { afterEach, describe, expect, it, vi } from "vitest"
import { createShutdown } from "../src/shutdown"
import { createStallWatchdog, startStallWatch } from "../src/stall"

function setup(stallMs = 300_000) {
  const state = { t: 0, cursor: 100n as bigint | null, head: 200n as bigint | undefined }
  const logs: [string, string][] = []
  let stalled = 0
  const w = createStallWatchdog({
    getCursor: async () => state.cursor,
    getHead: () => state.head,
    now: () => state.t,
    stallMs,
    logger: (l, m) => logs.push([l, m]),
    onStall: () => {
      stalled++
    },
  })
  const advance = async (ms: number) => {
    state.t += ms
    await w.check()
  }
  return { state, logs, advance, stalled: () => stalled, w }
}

describe("createStallWatchdog", () => {
  it("fires an error and onStall when the cursor stays behind head for 5 minutes", async () => {
    const { advance, logs, stalled } = setup()
    await advance(0)
    await advance(299_000)
    expect(stalled()).toBe(0)
    await advance(1_000)
    expect(stalled()).toBe(1)
    expect(logs).toEqual([["error", "indexer stalled: cursor 100 behind head 200 for 300 s"]])
  })

  it("does not fire while the cursor advances", async () => {
    const { state, advance, stalled } = setup()
    await advance(0)
    for (let i = 0; i < 20; i++) {
      state.cursor = state.cursor! + 1n
      await advance(60_000)
    }
    expect(stalled()).toBe(0)
  })

  it("does not fire when the cursor is at head, however long it idles", async () => {
    const { state, advance, stalled } = setup()
    state.cursor = 200n
    await advance(0)
    await advance(3_600_000)
    expect(stalled()).toBe(0)
  })

  it("resets the timer on movement and when it catches up to head", async () => {
    const { state, advance, stalled } = setup()
    await advance(0)
    await advance(240_000)
    state.cursor = 101n
    await advance(0)
    await advance(240_000)
    expect(stalled()).toBe(0)
    state.cursor = 200n
    await advance(600_000)
    state.head = 300n
    await advance(240_000)
    expect(stalled()).toBe(0)
    await advance(60_000)
    expect(stalled()).toBe(1)
  })

  it("does nothing before a head has been observed", async () => {
    const { state, advance, stalled } = setup()
    state.head = undefined
    await advance(0)
    await advance(3_600_000)
    expect(stalled()).toBe(0)
  })

  it("treats a missing cursor as behind head", async () => {
    const { state, advance, stalled } = setup()
    state.cursor = null
    await advance(0)
    await advance(300_000)
    expect(stalled()).toBe(1)
  })
})

afterEach(() => vi.useRealTimers())

function withHeads() {
  const state = {
    t: 0,
    cursor: 100n as bigint | null,
    head: undefined as bigint | undefined,
    fetches: 0,
  }
  const logs: [string, string][] = []
  let stalled = 0
  const w = createStallWatchdog({
    getCursor: async () => state.cursor,
    getHead: () => state.head,
    getHeadFetches: () => state.fetches,
    now: () => state.t,
    logger: (l, m) => logs.push([l, m]),
    onStall: () => {
      stalled++
    },
  })
  const advance = async (ms: number) => {
    state.t += ms
    await w.check()
  }
  return { state, logs, advance, stalled: () => stalled }
}

describe("createStallWatchdog with head fetches", () => {
  it("exits after 5 minutes when no head has ever been fetched", async () => {
    const { advance, stalled, logs } = withHeads()
    await advance(0)
    await advance(299_000)
    expect(stalled()).toBe(0)
    await advance(1_000)
    expect(stalled()).toBe(1)
    expect(logs[0]![1]).toMatch(/^indexer stalled: cursor 100 .*no chain head fetched.* 300 s$/)
  })

  it("does not exit at head while head fetches keep arriving", async () => {
    const { state, advance, stalled } = withHeads()
    state.cursor = 200n
    for (let i = 0; i < 60; i++) {
      state.head = 200n
      state.fetches++
      await advance(60_000)
    }
    expect(stalled()).toBe(0)
  })

  it("exits when the cursor sits at a head that has not been refreshed for 5 minutes", async () => {
    const { state, advance, stalled } = withHeads()
    state.cursor = 200n
    state.head = 200n
    state.fetches = 1
    await advance(0)
    await advance(240_000)
    expect(stalled()).toBe(0)
    await advance(60_000)
    expect(stalled()).toBe(1)
  })

  it("still exits when behind a fresh head", async () => {
    const { state, advance, stalled } = withHeads()
    state.head = 200n
    for (let i = 0; i < 6; i++) {
      state.fetches++
      await advance(60_000)
    }
    expect(stalled()).toBe(1)
  })
})

describe("startStallWatch", () => {
  it("wires a stall to shutdown.abort and exit code 1, reading the cursor from memory", async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const logs: [string, string][] = []
    const shutdown = createShutdown({
      stop: () => events.push("stop"),
      inFlight: () => undefined,
      end: async () => {
        events.push("end")
      },
      exit: (c) => events.push(`exit ${c}`),
      logger: (l, m) => logs.push([l, m]),
    })
    const indexer = {
      cursorBlock: 100n as bigint | null,
      lastHead: 200n as bigint | undefined,
      headFetches: 3,
    }
    const timer = startStallWatch({
      indexer,
      shutdown,
      logger: (l, m) => logs.push([l, m]),
      now: () => Date.now(),
    })
    await vi.advanceTimersByTimeAsync(240_000)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(events).toEqual(["stop", "end", "exit 1"])
    expect(logs.some(([l, m]) => l === "error" && /indexer stalled/.test(m))).toBe(true)
    clearInterval(timer)
  })

  it("does not fire while the in-memory cursor advances", async () => {
    vi.useFakeTimers()
    const abort = vi.fn(async () => {})
    const indexer = {
      cursorBlock: 100n as bigint | null,
      lastHead: 10_000n as bigint | undefined,
      headFetches: 1,
    }
    const timer = startStallWatch({
      indexer,
      shutdown: { abort },
      logger: () => {},
      now: () => Date.now(),
    })
    for (let i = 0; i < 40; i++) {
      indexer.cursorBlock = indexer.cursorBlock! + 1n
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(abort).not.toHaveBeenCalled()
    clearInterval(timer)
  })
})

function withTicks() {
  const state = {
    t: 0,
    cursor: 200n as bigint | null,
    head: 200n as bigint | undefined,
    fetches: 0,
    successes: 0,
  }
  const logs: [string, string][] = []
  let stalled = 0
  const w = createStallWatchdog({
    getCursor: async () => state.cursor,
    getHead: () => state.head,
    getHeadFetches: () => state.fetches,
    getTickSuccesses: () => state.successes,
    now: () => state.t,
    logger: (l, m) => logs.push([l, m]),
    onStall: () => {
      stalled++
    },
  })
  const advance = async (ms: number, tick: "ok" | "fail" | "none") => {
    state.t += ms
    state.fetches++ // a fresh head every time
    if (tick === "ok") state.successes++
    await w.check()
  }
  return { state, logs, advance, stalled: () => stalled }
}

describe("createStallWatchdog with tick successes", () => {
  it("exits when fresh heads keep arriving but no tick completes for 5 minutes, cursor at head", async () => {
    const { advance, stalled, logs } = withTicks()
    await advance(0, "fail")
    for (let i = 0; i < 4; i++) await advance(60_000, "fail")
    expect(stalled()).toBe(0)
    await advance(60_000, "fail")
    expect(stalled()).toBe(1)
    expect(logs[0]![1]).toMatch(/no successful tick and cursor static for 300 s/)
  })

  it("does not exit on an idle chain whose ticks keep completing", async () => {
    const { advance, stalled } = withTicks()
    for (let i = 0; i < 60; i++) await advance(60_000, "ok")
    expect(stalled()).toBe(0)
  })

  it("resets on a successful tick", async () => {
    const { advance, stalled } = withTicks()
    await advance(0, "fail")
    for (let i = 0; i < 4; i++) await advance(60_000, "fail")
    await advance(60_000, "ok")
    for (let i = 0; i < 4; i++) await advance(60_000, "fail")
    expect(stalled()).toBe(0)
    await advance(60_000, "fail")
    expect(stalled()).toBe(1)
  })

  it("does not exit while the cursor advances even if ticks keep aborting after progress", async () => {
    const { state, advance, stalled } = withTicks()
    state.head = 10_000n
    for (let i = 0; i < 30; i++) {
      state.cursor = state.cursor! + 1n
      await advance(60_000, "fail")
    }
    expect(stalled()).toBe(0)
  })
})

describe("createStallWatchdog tick failures need a cursor static for the full window", () => {
  it("does not exit when the cursor moved within the last 5 minutes but not since the previous check", async () => {
    const { state, advance, stalled } = withTicks()
    state.head = 100_000n
    state.cursor = 100n
    await advance(0, "fail")
    for (let i = 0; i < 7; i++) {
      state.cursor = state.cursor! + 1_000n
      await advance(60_000, "fail") // one long tick: the cursor moves, no tick completes
    }
    await advance(30_000, "fail") // first check without movement, 390 s since the last success
    expect(stalled()).toBe(0)
    await advance(200_000, "fail")
    expect(stalled()).toBe(0)
  })

  it("exits once the cursor has been static for 5 minutes and no tick has completed for 5 minutes", async () => {
    const { state, advance, stalled, logs } = withTicks()
    state.head = 100_000n
    state.cursor = 100n
    await advance(0, "fail")
    for (let i = 0; i < 7; i++) {
      state.cursor = state.cursor! + 1_000n
      await advance(60_000, "fail")
    }
    await advance(240_000, "fail")
    expect(stalled()).toBe(0)
    await advance(60_000, "fail")
    expect(stalled()).toBe(1)
    expect(logs[0]![1]).toMatch(/no successful tick and cursor static for 300 s/)
  })
})

describe("startStallWatch with tick successes", () => {
  it("aborts when the indexer's tick successes stop while heads stay fresh", async () => {
    vi.useFakeTimers()
    const abort = vi.fn(async () => {})
    const indexer = {
      cursorBlock: 200n as bigint | null,
      lastHead: 200n as bigint | undefined,
      headFetches: 0,
      tickSuccesses: 0,
    }
    const timer = startStallWatch({
      indexer,
      shutdown: { abort },
      logger: () => {},
      now: () => Date.now(),
    })
    for (let i = 0; i < 9; i++) {
      indexer.headFetches++
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(abort).not.toHaveBeenCalled()
    for (let i = 0; i < 2; i++) {
      indexer.headFetches++
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(abort).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })
})
