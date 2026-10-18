import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { Indexer } from "../src/loop"
import { createStore } from "../src/store"
import { goldenEvents, loadCalls, ReplayChain } from "./replay-chain"

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

async function run(chain: ReplayChain, from: bigint, to: bigint) {
  const idx = new Indexer({ chain, store: createStore(sql), logger: () => {} })
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

  it("is written by today's loop exactly as recorded", async () => {
    const calls = loadCalls()
    await run(new ReplayChain(calls), calls.range.from, calls.range.to)
    const rows = await sql<{ block: bigint }[]>`
      select type, entity, payload, block, block_hash, tx_hash, log_index, confirmed
      from indexer.events order by id`
    expect(rows.map((r) => ({ ...r, block: r.block.toString() }))).toEqual(goldenEvents())
  })

  it("refuses a call it has no recording for", async () => {
    const calls = loadCalls()
    const chain = new ReplayChain(calls)
    await expect(chain.getBlock(1n)).rejects.toThrow(/no recorded answer/)
    await expect(chain.getLogs(calls.range.from - 1n, calls.range.to)).rejects.toThrow(
      /no recorded logs/,
    )
    await expect(chain.readErc20Meta("0x0000000000000000000000000000000000000001")).rejects.toThrow(
      /no recorded answer/,
    )
  })

  it("clamps getLogs to the recorded head", async () => {
    const calls = loadCalls()
    const r = await new ReplayChain(calls).getLogs(calls.range.from, calls.head + 1_000n)
    expect(r.toBlock).toBe(calls.head)
    expect(r.logs).toHaveLength(calls.logs.length)
  })
})
