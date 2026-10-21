import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { LOG_TOPICS } from "@ink-indexer/sdk"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { Indexer } from "../src/loop"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { createStore } from "../src/store"
import { goldenEvents, loadCalls, ReplayChain } from "./replay-chain"

const FILTER = { topics: [LOG_TOPICS] }

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

async function run(chain: ReplayChain, from: bigint, to: bigint) {
  const logger = () => {}
  const sources = [inkypumpSource({ sql, chain, logger })]
  const idx = new Indexer({ chain, store: createStore(sql), logger, sources })
  await idx.init()
  await idx.backfill(from, to)
}

describe("recorded InkyPump range", () => {
  it("covers a launch, a bond, many trades, and an xStocks launch and trade", () => {
    const events = goldenEvents()
    const count = (t: string) => events.filter((e) => e.type === t).length
    expect(count("launchpad.launch")).toBeGreaterThanOrEqual(1)
    expect(count("launchpad.bond")).toBeGreaterThanOrEqual(1)
    expect(count("launchpad.trade")).toBeGreaterThan(100)
    const quote = (e: { payload: unknown }) => (e.payload as { quoteAsset: string }).quoteAsset
    const zero = "0x0000000000000000000000000000000000000000"
    expect(events.some((e) => e.type === "launchpad.launch" && quote(e) !== zero)).toBe(true)
    expect(events.some((e) => e.type === "launchpad.trade" && quote(e) !== zero)).toBe(true)
  })

  it("is written by the loop with only the InkyPump source exactly as recorded, using every recorded call", async () => {
    const calls = loadCalls()
    const chain = new ReplayChain(calls)
    await run(chain, calls.range.from, calls.range.to)
    expect(chain.unused()).toEqual([])
    const rows = await sql<{ block: bigint }[]>`
      select type, entity, payload, block, block_hash, tx_hash, log_index, confirmed, sub
      from indexer.events order by id`
    // golden.json predates the sub column; every InkyPump row has sub ''.
    expect(rows.map((r) => ({ ...r, block: r.block.toString() }))).toEqual(
      goldenEvents().map((e) => ({ ...e, sub: "" })),
    )
  })

  it("refuses a call it has no recording for", async () => {
    const calls = loadCalls()
    const chain = new ReplayChain(calls)
    await expect(chain.getBlock(1n)).rejects.toThrow(/no recorded answer/)
    await expect(chain.getLogs(calls.range.from - 1n, calls.range.to, FILTER)).rejects.toThrow(
      /no recorded logs/,
    )
    await expect(chain.readErc20Meta("0x0000000000000000000000000000000000000001")).rejects.toThrow(
      /no recorded answer/,
    )
  })

  it("clamps getLogs to the recorded head", async () => {
    const calls = loadCalls()
    const r = await new ReplayChain(calls).getLogs(calls.range.from, calls.head + 1_000n, FILTER)
    expect(r.toBlock).toBe(calls.head)
    expect(r.logs).toHaveLength(calls.logs.length)
  })

  it("applies the address and topic filter to the recorded logs", async () => {
    const calls = loadCalls()
    const chain = new ReplayChain(calls)
    const first = calls.logs[0]!
    const { range } = calls
    const logs = async (filter: Parameters<ReplayChain["getLogs"]>[2]) =>
      (await chain.getLogs(range.from, range.to, filter)).logs
    expect(await logs({ address: first.address, topics: [first.topics[0]!] })).toContainEqual(first)
    expect(await logs({ topics: [[]] })).toEqual([])
    expect(
      await logs({ address: "0x0000000000000000000000000000000000000001", topics: [] }),
    ).toEqual([])
  })
})
