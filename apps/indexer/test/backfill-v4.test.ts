import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import { v4Source } from "../src/sources/v4/index"
import { createStore } from "../src/store"
import { FakeChain } from "./fake-chain"
import { bond, launch, trade } from "./scenario"
import { B, DEAD_KEY, Q96, swap } from "./v4-scenario"

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

/** A launch at B, a curve trade, the bond that registers the pool, and two swaps. */
function chainWithSwaps() {
  const chain = new FakeChain(B + 30n)
  // The v4 source joins a run after the span that registers the pool, so the swaps lie in later spans.
  chain.maxSpan = 4n
  launch(chain, { n: 1, block: B })
  trade(chain, { n: 1, block: B + 1n, sold: 1n, price: 1000n })
  bond(chain, { n: 1, block: B + 2n })
  swap(chain, { block: B + 5n })
  swap(chain, { block: B + 8n, sqrtPriceX96: Q96 / 2n })
  return chain
}

function indexerOn(
  db: Sql,
  chain: FakeChain,
  opts: { logger?: Logger; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
) {
  const logger = opts.logger ?? (() => {})
  const pools = new PoolRegistry()
  return new Indexer({
    chain,
    store: createStore(db),
    logger,
    sources: [
      inkypumpSource({ sql: db, chain, logger, pools }),
      v4Source({ sql: db, chain, logger, pools }),
    ],
    sleep: opts.sleep,
    now: opts.now,
  })
}

const rows = async (db: Sql) => ({
  events:
    await db`select type, entity, payload, block, tx_hash, log_index, sub from indexer.events order by block, log_index`,
  ath: await db`select ath_market_cap::text as ath, ath_block from indexer.tokens`,
  trades:
    await db`select tx_hash, log_index, venue, block from indexer.trades order by block, log_index`,
})

describe("backfill values and reads", () => {
  it("retries a span whose block is not served yet and finishes with the same rows", async () => {
    const chain = chainWithSwaps()
    const reference = indexerOn(sql, chain)
    await reference.init()
    await reference.backfill(B, B + 9n)
    const expected = await rows(sql)

    await sql.end()
    sql = await resetDb(inject("databaseUrl"))
    const read = chain.readBalances.bind(chain)
    let refusals = 3
    chain.readBalances = async (pairs, block) => {
      if (refusals-- > 0) throw Object.assign(new Error("header not found"), { code: -32000 })
      return read(pairs, block)
    }
    const waits: number[] = []
    const warnings: string[] = []
    const idx = indexerOn(sql, chain, {
      logger: (level, msg) => {
        if (level === "warn") warnings.push(msg)
      },
      sleep: async (ms) => void waits.push(ms),
    })
    await idx.init()
    await idx.backfill(B, B + 9n)
    expect(await rows(sql)).toEqual(expected)
    expect(waits).toEqual([1_000, 2_000, 4_000])
    expect(warnings).toEqual(["backfill block not yet served; retrying"])
  })

  it("exits with an error naming the block to resume from after one block is refused for 10 minutes", async () => {
    const chain = chainWithSwaps()
    chain.readBalances = async () => {
      throw Object.assign(new Error("header not found"), { code: -32000 })
    }
    const clock = { now: 0 }
    const waits: number[] = []
    const idx = indexerOn(sql, chain, {
      sleep: async (ms) => {
        waits.push(ms)
        clock.now += ms
      },
      now: () => clock.now,
    })
    await idx.init()
    await expect(idx.backfill(B, B + 9n)).rejects.toThrow(
      new RegExp(`block ${B + 30n} was not served.*--from ${B + 4n}\\b`),
    )
    expect(clock.now).toBeGreaterThanOrEqual(600_000)
    expect(clock.now).toBeLessThan(600_000 + 30_000)
    expect(Math.max(...waits)).toBe(30_000)
  })

  it("reads the dead balance at the live cursor block when the cursor is past the span", async () => {
    const chain = chainWithSwaps()
    chain.balances.set(DEAD_KEY, 7n)
    const store = createStore(sql)
    await store.writeBatch([], [], {
      cursor: { block: B + 20n, hash: chain.hashOf(B + 20n) },
      head: B + 20n,
    })
    const idx = indexerOn(sql, chain)
    await idx.init()
    await idx.backfill(B, B + 9n)
    expect(chain.balanceReads).toEqual([B + 20n])
  })
})
