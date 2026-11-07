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
import { B, burn, DEAD_KEY, Q96, swap } from "./v4-scenario"

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

/** A launch at B, a curve trade, the bond that registers the pool, and two swaps. */
function chainWithSwaps() {
  const chain = new FakeChain(B + 30n)
  // The pool is registered in the first span and its swaps lie in later spans.
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
  it("values a pool's swaps against the ath before its range, whatever was written above the range", async () => {
    const chain = chainWithSwaps()
    const sequential = indexerOn(sql, chain)
    await sequential.init()
    await sequential.backfill(B, B + 9n)
    const expected = await rows(sql)
    const swaps = expected.events.filter((e) => e.type === "launchpad.swap")
    expect(swaps).toHaveLength(2)
    // The second swap raises the ath, so the first swap is told apart from the final ath.
    expect(swaps[0]!.payload.athMarketCap).not.toBe(swaps[1]!.payload.athMarketCap)

    await sql.end()
    sql = await resetDb(inject("databaseUrl"))
    const early = indexerOn(sql, chain)
    await early.init()
    await early.backfill(B, B + 3n)
    const above = indexerOn(sql, chain)
    await above.init()
    await above.backfill(B + 8n, B + 9n)
    // Started after the swap above its range was written: its registry begins at the final ath.
    const middle = indexerOn(sql, chain)
    await middle.init()
    await middle.backfill(B + 4n, B + 7n)
    expect(await rows(sql)).toEqual(expected)
  })

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
    await expect(idx.backfill(B, B + 9n, ["inkypump", "v4-swaps"])).rejects.toThrow(
      `block ${B + 30n} was not served for 10 minutes; resume with --from ${B} --to ${B + 9n} --sources inkypump,v4-swaps`,
    )
    expect(clock.now).toBeGreaterThanOrEqual(600_000)
    expect(clock.now).toBeLessThan(600_000 + 30_000)
    expect(Math.max(...waits)).toBe(30_000)
  })

  it("names the later span to resume from when a block is refused after earlier spans were written", async () => {
    const chain = chainWithSwaps()
    const refused = B + 5n
    const read = chain.getBlockSenders.bind(chain)
    chain.getBlockSenders = async (n: bigint) => {
      if (n === refused) throw Object.assign(new Error("header not found"), { code: -32000 })
      return read(n)
    }
    const clock = { now: 0 }
    const idx = indexerOn(sql, chain, {
      sleep: async (ms) => {
        clock.now += ms
      },
      now: () => clock.now,
    })
    await idx.init()
    await expect(idx.backfill(B, B + 9n, ["inkypump", "v4-swaps"])).rejects.toThrow(
      `block ${refused} was not served for 10 minutes; resume with --from ${B + 4n} --to ${B + 9n} --sources inkypump,v4-swaps`,
    )
    // The first span's rows were kept.
    const [row] = await sql`select count(*)::int as n from indexer.events`
    expect(row!.n).toBeGreaterThan(0)
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

  it("a live process that starts following a token after a reload re-reads its dead balance instead of trusting the stored one", async () => {
    const chain = chainWithSwaps()
    chain.head = B + 14n
    // The balance at a block: a burn at B+12 and another at B+16.
    chain.balances.set(DEAD_KEY, (block) => (block >= B + 16n ? 45n : block >= B + 12n ? 40n : 0n))
    burn(chain, { block: B + 12n, value: 40n })
    const store = createStore(sql)
    await store.writeBatch([], [], {
      cursor: { block: B + 10n, hash: chain.hashOf(B + 10n) },
      head: B + 10n,
    })
    // The live process starts before the token has a pool, so nothing follows it.
    const live = indexerOn(sql, chain)
    await live.init()
    // A backfill registers the pool and reads the balance at the live cursor's block.
    const backfill = indexerOn(sql, chain)
    await backfill.init()
    await backfill.backfill(B, B + 9n)
    const dead = () =>
      sql`select dead_balance::text as balance, dead_balance_block as block from indexer.tokens`
    expect(await dead()).toEqual([{ balance: "0", block: B + 10n }])
    await live.trigger()

    // The live process reloads and now follows the token; the next burn is the first it sees.
    burn(chain, { block: B + 16n, value: 5n })
    chain.head = B + 18n
    await live.init()
    await live.trigger()
    expect(await dead()).toEqual([{ balance: "45", block: B + 18n }])
  })

  it("logs where to resume when a backfill fails for another reason", async () => {
    const chain = chainWithSwaps()
    const read = chain.getLogs.bind(chain)
    chain.getLogs = async (from, to, filter) => {
      if (from > B + 3n) throw new Error("boom")
      return read(from, to, filter)
    }
    const errors: { msg: string; fields?: Record<string, unknown> }[] = []
    const idx = indexerOn(sql, chain, {
      logger: (level, msg, fields) => {
        if (level === "error") errors.push({ msg, fields })
      },
    })
    await idx.init()
    await expect(idx.backfill(B, B + 9n)).rejects.toThrow("boom")
    expect(errors).toEqual([
      { msg: "backfill failed", fields: { resumeFrom: B + 4n, to: B + 9n, sources: "all" } },
    ])
  })
})
