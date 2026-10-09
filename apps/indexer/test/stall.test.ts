import { describe, expect, it } from "vitest"
import { createStallWatchdog } from "../src/stall"

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
