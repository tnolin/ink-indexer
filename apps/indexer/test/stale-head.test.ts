import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { INKYPUMP_START_BLOCK as S } from "@ink-indexer/sdk"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Level } from "../src/log"
import { Indexer } from "../src/loop"
import { inkypumpSource } from "../src/sources/inkypump/index"
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
    sources: [inkypumpSource({ sql, chain, logger })],
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
    expect(staleWarnings(lines)).toHaveLength(1)
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
  it("warns once per incident and logs the recovery once", async () => {
    const { chain, idx, lines } = await caughtUpTo(S + 200n)
    chain.staleHead = S + 100n
    for (const head of [300n, 310n, 320n]) {
      chain.head = S + head
      chain.transportHeads = [
        { name: A, head: S + 100n },
        { name: B, head: S + head },
      ]
      await idx.tick()
    }
    expect(await cursorBlock()).toBe(S + 320n)
    expect(staleWarnings(lines)).toHaveLength(1)
    expect(recoveries(lines)).toHaveLength(0)

    // the provider moves again, so its head is above the cursor
    chain.staleHead = undefined
    for (const head of [330n, 340n]) {
      chain.head = S + head
      await idx.tick()
    }
    expect(recoveries(lines)).toEqual([{ level: "info", msg: "head source recovered" }])
    expect(staleWarnings(lines)).toHaveLength(1)
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

  it("warns again when the head goes stale a second time", async () => {
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

    expect(staleWarnings(lines)).toHaveLength(2)
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
