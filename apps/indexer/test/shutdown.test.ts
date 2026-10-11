import { describe, expect, it } from "vitest"
import { createShutdown } from "../src/shutdown"

function setup(inFlight: () => Promise<unknown> | undefined = () => undefined) {
  const events: string[] = []
  const s = createShutdown({
    stop: () => events.push("stop"),
    inFlight,
    end: async () => {
      events.push("end")
    },
    exit: (code) => events.push(`exit ${code}`),
    logger: () => {},
    waitMs: 50,
  })
  return { s, events }
}

describe("createShutdown", () => {
  it("exits 1 on a failure while running", () => {
    const { s, events } = setup()
    s.fail(new Error("db down"))
    expect(events).toEqual(["exit 1"])
  })

  it("exits 0 on a signal, ignoring tick failures that follow it", async () => {
    let reject!: (e: Error) => void
    const tick = new Promise<void>((_, r) => {
      reject = r
    })
    const { s, events } = setup(() => tick)
    const done = s.signal()
    s.fail(new Error("socket closed mid-tick"))
    reject(new Error("socket closed mid-tick"))
    await done
    expect(events).toEqual(["stop", "end", "exit 0"])
  })

  it("ignores a second signal", async () => {
    const { s, events } = setup()
    await Promise.all([s.signal(), s.signal()])
    await s.signal()
    expect(events).toEqual(["stop", "end", "exit 0"])
  })

  it("waits for the in-flight tick, but only for waitMs", async () => {
    const { s, events } = setup(() => new Promise(() => {}))
    await s.signal()
    expect(events).toEqual(["stop", "end", "exit 0"])
  })

  it("exits 1 when closing the database fails", async () => {
    const events: string[] = []
    const s = createShutdown({
      stop: () => {},
      inFlight: () => undefined,
      end: async () => {
        throw new Error("hang")
      },
      exit: (c) => events.push(`exit ${c}`),
      logger: () => {},
    })
    await s.signal()
    expect(events).toEqual(["exit 1"])
  })
})

describe("createShutdown abort", () => {
  it("stops, closes the database and exits non-zero; later signals and failures are ignored", async () => {
    const { s, events } = setup()
    await s.abort("indexer stalled")
    await s.signal()
    s.fail(new Error("late"))
    expect(events).toEqual(["stop", "end", "exit 1"])
  })

  it("exits non-zero even if closing the database hangs", async () => {
    const events: string[] = []
    const s = createShutdown({
      stop: () => events.push("stop"),
      inFlight: () => undefined,
      end: () => new Promise(() => {}),
      exit: (c) => events.push(`exit ${c}`),
      logger: () => {},
      waitMs: 20,
    })
    await s.abort("stalled")
    expect(events).toEqual(["stop", "exit 1"])
  })
})
