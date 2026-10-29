import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { INKYPUMP_START_BLOCK as S } from "@ink-indexer/sdk"
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Level } from "../src/log"
import { Indexer } from "../src/loop"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import { launch } from "./scenario"

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

const A = "a.example"
const B = "b.example"

type Line = { level: Level; msg: string; fields?: Record<string, unknown> }

/** An indexer that has ingested up to `cursor`, with every line it logs from then on kept in `lines`. */
async function caughtUpTo(cursor: bigint) {
  const chain = new FakeChain(cursor)
  const lines: Line[] = []
  const logger = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields })
  }
  const idx = new Indexer({
    chain,
    store,
    logger,
    sources: [inkypumpSource({ sql, chain, pools: new PoolRegistry(), logger })],
  })
  await idx.init()
  await idx.tick()
  lines.length = 0
  chain.getLogsCalls.length = 0
  chain.getBlockNumberCalls = 0
  return { chain, idx, lines }
}

const cursorBlock = async () => (await store.getCursor())?.block
const staleWarnings = (lines: Line[]) => lines.filter((l) => l.msg.startsWith("stale head from"))
const recoveries = (lines: Line[]) => lines.filter((l) => l.msg === "head source recovered")
const notServed = (lines: Line[]) =>
  lines.filter((l) => l.msg === "block not yet served; retrying on next head")
const summaries = (lines: Line[]) => lines.filter((l) => l.msg.endsWith("; stretch ended"))
const MIN = 60_000
const levels = (ls: Line[]) => ls.map((l) => l.level)

describe("a head at or below the cursor", () => {
  it("ingests up to the highest transport head when the fallback head is stale", async () => {
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    launch(chain, { n: 1, block: S + 250n })
    chain.head = S + 300n
    chain.staleHead = S + 100n
    chain.transportHeads = [
      { name: A, head: S + 100n },
      { name: B, head: S + 300n },
    ]

    await idx.tick()

    expect(await cursorBlock()).toBe(S + 300n)
    expect(chain.getLogsCalls).toEqual([[S + 201n, S + 300n]])
    expect(idx.lastHead).toBe(S + 300n)
    expect(staleWarnings(lines)).toEqual([
      {
        level: "warn",
        msg: `stale head from ${A}`,
        fields: { host: A, staleHead: S + 100n, highestHead: S + 300n },
      },
    ])
  })

  it("reads the transports from the block after the cursor", async () => {
    const { chain, idx } = await caughtUpTo(S + 200n)
    chain.staleHead = S + 100n
    await idx.tick()
    expect(chain.transportHeadReads).toEqual([S + 201n])
  })

  it("neither ingests nor warns while every transport is at the cursor", async () => {
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    chain.transportHeads = [
      { name: A, head: S + 200n },
      { name: B, head: S + 200n },
    ]

    await idx.tick()

    expect(chain.transportHeadReads).toHaveLength(1)
    expect(chain.getLogsCalls).toEqual([])
    expect(await cursorBlock()).toBe(S + 200n)
    expect(lines).toEqual([])
  })

  it("warns about a stale transport even when nothing is ingested", async () => {
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    chain.staleHead = S + 100n
    chain.transportHeads = [
      { name: A, head: S + 100n },
      { name: B, head: S + 200n },
    ]

    await idx.tick()

    expect(chain.getLogsCalls).toEqual([])
    expect(levels(staleWarnings(lines))).toEqual(["warn"])
  })

  it("keeps the original head when no transport answers", async () => {
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    chain.staleHead = S + 100n
    chain.transportHeads = []
    const before = idx.tickSuccesses

    await idx.tick()

    expect(chain.getLogsCalls).toEqual([])
    expect(idx.lastHead).toBe(S + 100n)
    expect(idx.tickSuccesses).toBe(before + 1)
    expect(lines).toEqual([])
  })

  it("keeps the original head when no transport is higher", async () => {
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    chain.staleHead = S + 200n
    chain.transportHeads = [
      { name: A, head: S + 150n },
      { name: B, head: S + 200n },
    ]

    await idx.tick()

    expect(idx.lastHead).toBe(S + 200n)
    expect(lines).toEqual([])
  })
})

describe("stale head incidents", () => {
  afterEach(() => vi.useRealTimers())

  it("warns once per incident and logs the recovery once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    chain.staleHead = S + 100n
    for (const head of [300n, 310n, 320n]) {
      chain.head = S + head
      chain.transportHeads = [
        { name: A, head: S + 100n },
        { name: B, head: S + head },
      ]
      await idx.tick()
      vi.advanceTimersByTime(1_000)
    }
    expect(await cursorBlock()).toBe(S + 320n)
    expect(levels(staleWarnings(lines))).toEqual(["warn", "debug", "debug"])
    expect(recoveries(lines)).toHaveLength(0)

    // the provider moves again, so its head is above the cursor
    chain.staleHead = undefined
    for (const head of [330n, 340n]) {
      chain.head = S + head
      await idx.tick()
    }
    expect(levels(staleWarnings(lines))).toEqual(["warn", "debug", "debug"])
    expect(recoveries(lines)).toEqual([
      { level: "debug", msg: "head source recovered", fields: { durationMs: 3_000, ticks: 3 } },
    ])
    expect(chain.transportHeadReads).toHaveLength(3)
  })

  it("recovers when the fallback head matches the highest transport head again", async () => {
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    chain.staleHead = S + 100n
    chain.transportHeads = [
      { name: A, head: S + 100n },
      { name: B, head: S + 200n },
    ]
    await idx.tick()

    chain.staleHead = undefined
    chain.transportHeads = [
      { name: A, head: S + 200n },
      { name: B, head: S + 200n },
    ]
    await idx.tick()
    await idx.tick()

    expect(recoveries(lines)).toHaveLength(1)
  })

  it("logs a second incident within ten minutes at debug", async () => {
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    const stale = async (head: bigint) => {
      chain.head = S + head
      chain.staleHead = S + 100n
      chain.transportHeads = [
        { name: A, head: S + 100n },
        { name: B, head: S + head },
      ]
      await idx.tick()
    }
    await stale(300n)
    chain.staleHead = undefined
    chain.head = S + 310n
    await idx.tick()
    await stale(320n)

    expect(levels(staleWarnings(lines))).toEqual(["warn", "debug"])
    expect(recoveries(lines)).toHaveLength(1)
  })
})

describe("a head above the cursor", () => {
  it("makes no extra eth_blockNumber reads", async () => {
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    for (const head of [201n, 202n, 250n]) {
      chain.head = S + head
      await idx.tick()
    }
    expect(chain.getBlockNumberCalls).toBe(3)
    expect(chain.transportHeadReads).toEqual([])
    expect(await cursorBlock()).toBe(S + 250n)
    expect(lines).toEqual([])
  })
})

describe("conditions that come and go", () => {
  afterEach(() => vi.useRealTimers())

  async function atClock() {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-28T19:33:00Z"))
    return caughtUpTo(S + 200n)
  }
  /** One short episode: the block at the new head is withheld for one tick, then served. */
  async function shortNotServed(chain: FakeChain, idx: Indexer) {
    chain.head += 1n
    chain.nullOnce.add(chain.head)
    await idx.tick()
    await idx.tick()
  }
  /** One short episode: the fallback head is stale for one tick, then moves. */
  async function shortStale(chain: FakeChain, idx: Indexer) {
    chain.head += 1n
    chain.staleHead = S + 100n
    chain.transportHeads = [
      { name: A, head: S + 100n },
      { name: B, head: chain.head },
    ]
    await idx.tick()
    chain.staleHead = undefined
    await idx.tick()
  }

  it("logs one warning and one summary for six minutes of back-to-back short episodes", async () => {
    const { chain, idx, lines } = await atClock()
    for (let i = 0; i < 36; i++) {
      await shortNotServed(chain, idx)
      vi.advanceTimersByTime(10_000)
    }
    expect(levels(notServed(lines)).filter((l) => l === "warn")).toHaveLength(1)
    expect(summaries(lines)).toEqual([])

    vi.advanceTimersByTime(10 * MIN)
    await idx.tick()

    expect(lines.filter((l) => l.level !== "debug").map((l) => l.level)).toEqual(["warn", "info"])
    expect(summaries(lines)).toEqual([
      {
        level: "info",
        msg: "block not yet served; stretch ended",
        fields: {
          condition: "block not yet served",
          start: "2026-10-28T19:33:00.000Z",
          end: "2026-10-28T19:38:50.000Z",
          episodes: 36,
        },
      },
    ])
  })

  it("names the hosts in the summary of a stale head stretch", async () => {
    const { chain, idx, lines } = await atClock()
    for (let i = 0; i < 18; i++) {
      await shortStale(chain, idx)
      vi.advanceTimersByTime(20_000)
    }
    vi.advanceTimersByTime(10 * MIN)
    await idx.tick()

    expect(lines.filter((l) => l.level !== "debug").map((l) => l.level)).toEqual(["warn", "info"])
    expect(summaries(lines)[0]!.fields).toEqual({
      condition: "stale head",
      start: "2026-10-28T19:33:00.000Z",
      end: "2026-10-28T19:38:40.000Z",
      episodes: 18,
      hosts: [A],
    })
  })

  it("keeps the two conditions apart", async () => {
    const { chain, idx, lines } = await atClock()
    await shortNotServed(chain, idx)
    await shortStale(chain, idx)
    expect(levels(notServed(lines))).toEqual(["warn"])
    expect(levels(staleWarnings(lines))).toEqual(["warn"])
  })

  it("warns again for an episode 11 minutes after the last warning", async () => {
    const { chain, idx, lines } = await atClock()
    await shortNotServed(chain, idx)
    vi.advanceTimersByTime(11 * MIN)
    await shortNotServed(chain, idx)

    expect(levels(notServed(lines))).toEqual(["warn", "warn"])
    expect(summaries(lines)).toEqual([])
  })

  it("warns again ten minutes after the last warning while the stretch goes on", async () => {
    const { chain, idx, lines } = await atClock()
    for (let i = 0; i < 12; i++) {
      await shortNotServed(chain, idx)
      vi.advanceTimersByTime(MIN)
    }
    expect(levels(notServed(lines)).filter((l) => l === "warn")).toHaveLength(2)
  })

  it("logs one warning for a single long episode and ends it at debug", async () => {
    const { chain, idx, lines } = await atClock()
    chain.head = S + 220n
    for (let i = 0; i < 40; i++) {
      chain.nullOnce.add(S + 220n)
      await idx.tick()
      vi.advanceTimersByTime(1_000)
    }
    await idx.tick()
    vi.advanceTimersByTime(20 * MIN)
    await idx.tick()

    expect(levels(notServed(lines))).toEqual(["warn", ...Array(39).fill("debug")])
    expect(notServed(lines)[0]!.fields).toEqual({ block: S + 220n })
    expect(lines.filter((l) => l.level === "info")).toEqual([])
    expect(await cursorBlock()).toBe(S + 220n)
  })
})
