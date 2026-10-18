import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { INKYPUMP_START_BLOCK as S } from "@ink-indexer/sdk"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { Indexer } from "../src/loop"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import { bond, HOOK, launch, launchIdOf, stateFor, tokenOf, trade, xstocksHook } from "./scenario"

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

async function indexerFor(chain: FakeChain) {
  const warnings: string[] = []
  const idx = new Indexer({
    chain,
    store,
    logger: (level, msg) => {
      if (level === "warn") warnings.push(msg)
    },
  })
  await idx.init()
  return { idx, warnings }
}

const count = async (table: string) =>
  Number((await sql.unsafe(`select count(*)::int as n from indexer.${table}`))[0]!.n)
const eventTypes = async () =>
  (await sql<{ type: string }[]>`select type from indexer.events order by id`).map((r) => r.type)
const LAUNCH_KEY = `${HOOK}:${launchIdOf(1)}`

describe("Indexer", () => {
  it("backfills from the start block in spans, reading state only at launch and bond", async () => {
    const chain = new FakeChain(S + 2_500n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 1_500n, sold: 4n * 10n ** 26n })
    bond(chain, { n: 1, block: S + 2_500n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()

    expect(chain.getLogsCalls).toEqual([
      [S, S + 999n],
      [S + 1_000n, S + 1_999n],
      [S + 2_000n, S + 2_500n],
    ])
    expect(chain.stateReads).toEqual([S + 10n, S + 2_500n])
    expect(await sql`select type, confirmed from indexer.events order by id`).toEqual([
      { type: "launchpad.launch", confirmed: true },
      { type: "launchpad.trade", confirmed: true },
      { type: "launchpad.bond", confirmed: false },
    ])
    expect(await store.getCursor()).toEqual({ block: S + 2_500n, hash: chain.hashOf(S + 2_500n) })
    expect((await sql`select phase from indexer.tokens`)[0]!.phase).toBe("bonded")
  })

  it("re-scans a range without duplicates or moving the cursor", async () => {
    const chain = new FakeChain(S + 2_500n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 1_500n, sold: 1n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()
    const cursor = await store.getCursor()
    await idx.backfill(S)
    expect([await count("events"), await count("trades"), await count("tokens")]).toEqual([2, 1, 1])
    expect(await store.getCursor()).toEqual(cursor)
  })

  it("follows new heads and confirms one block later", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()
    chain.head = S + 105n
    trade(chain, { n: 1, block: S + 105n, sold: 1n })
    await idx.trigger()
    expect(
      (await sql`select confirmed from indexer.events order by id`).map((r) => r.confirmed),
    ).toEqual([true, false])
    chain.head = S + 106n
    await idx.trigger()
    expect((await sql`select bool_and(confirmed) as ok from indexer.events`)[0]!.ok).toBe(true)
  })

  it("folds concurrent triggers into one extra tick", async () => {
    const chain = new FakeChain(S + 10n)
    const { idx } = await indexerFor(chain)
    await Promise.all([idx.trigger(), idx.trigger(), idx.trigger()])
    expect(chain.getBlockNumberCalls).toBe(2)
  })

  it("loses no logs when the log transport lags the head by 2 blocks", async () => {
    const chain = new FakeChain(S + 100n)
    chain.logLag = 2n
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 99n, sold: 1n })
    trade(chain, { n: 1, block: S + 100n, sold: 2n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()

    expect(chain.getLogsCalls).toEqual([
      [S, S + 98n],
      [S + 99n, S + 100n],
    ])
    expect(await eventTypes()).toEqual(["launchpad.launch", "launchpad.trade", "launchpad.trade"])
    expect(await store.getCursor()).toEqual({ block: S + 100n, hash: chain.hashOf(S + 100n) })
  })

  it("rolls back a one-block reorg and re-ingests the new block", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 100n, sold: 4n * 10n ** 26n })
    const { idx, warnings } = await indexerFor(chain)
    await idx.trigger()

    chain.reorg(S + 100n)
    trade(chain, { n: 1, block: S + 100n, sold: 2n * 10n ** 26n })
    chain.states.set(LAUNCH_KEY, stateFor(tokenOf(1), 0n)) // state at the fork block
    await idx.trigger()

    expect(await eventTypes()).toEqual(["launchpad.launch", "launchpad.trade"])
    expect(
      (
        await sql`select payload->>'progressBpsAfter' as p from indexer.events where type = 'launchpad.trade'`
      )[0]!.p,
    ).toBe("2500")
    expect((await sql`select progress_bps from indexer.curve_state`)[0]!.progress_bps).toBe(2500)
    expect(await store.getCursor()).toEqual({ block: S + 100n, hash: chain.hashOf(S + 100n) })
    expect(warnings).toContain("reorg: rolled back to fork block")
  })

  it("rolls back a five-block reorg, un-bonds and restores curve state from the fork block", async () => {
    const chain = new FakeChain(S + 200n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 100n, sold: 2n * 10n ** 26n })
    trade(chain, { n: 1, block: S + 197n, sold: 4n * 10n ** 26n })
    bond(chain, { n: 1, block: S + 199n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()

    chain.reorg(S + 196n)
    chain.states.set(LAUNCH_KEY, stateFor(tokenOf(1), 2n * 10n ** 26n))
    await idx.trigger()

    expect(await eventTypes()).toEqual(["launchpad.launch", "launchpad.trade"])
    expect(await sql`select phase, bonded_block from indexer.tokens`).toEqual([
      { phase: "curve", bonded_block: null },
    ])
    expect(await sql`select progress_bps, updated_block from indexer.curve_state`).toEqual([
      { progress_bps: 2500, updated_block: S + 100n },
    ])
    expect(chain.stateReads.at(-1)).toBe(S + 100n)
  })

  it("stops instead of guessing when no stored block hash matches", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()
    chain.reorg(S)
    await expect(idx.trigger()).rejects.toThrow(/refusing to guess/)
  })

  it("reloads the hook registry when a batch write fails, so the retry persists the new hook", async () => {
    const XHOOK = "0x799def4ec4a0a293a59b53a6479afc5a9df76ac4" as const
    const WRAPPER = "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171" as const
    const chain = new FakeChain(S + 100n)
    chain.erc20.set(WRAPPER, { decimals: 18, symbol: "TSLAx" })
    xstocksHook(chain, { block: S + 10n, hook: XHOOK, wrapper: WRAPPER })
    launch(chain, { n: 1, block: S + 20n, hook: XHOOK })
    let failed = false
    const flaky: Store = {
      ...store,
      writeBatch: async (...args) => {
        if (!failed) {
          failed = true
          throw new Error("db down")
        }
        return store.writeBatch(...args)
      },
    }
    const idx = new Indexer({ chain, store: flaky, logger: () => {} })
    await idx.init()
    await expect(idx.trigger()).rejects.toThrow("db down")
    await idx.trigger()

    expect((await sql`select address from indexer.hooks where address = ${XHOOK}`).length).toBe(1)
    expect(await eventTypes()).toEqual(["launchpad.launch"])
  })
})

describe("Indexer with a lagging block endpoint", () => {
  const NOT_SERVED = "block not yet served; retrying on next head"
  const ids = async () =>
    (await sql<{ id: string }[]>`select id from indexer.events order by id`).map((r) => r.id)

  it("does not fail the tick when the end block of a span is not served, and loses or duplicates nothing", async () => {
    const chain = new FakeChain(S + 20n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 15n, sold: 1n })
    const { idx, warnings } = await indexerFor(chain)
    chain.nullOnce.add(S + 20n)
    await idx.trigger()
    expect(warnings).toContain(NOT_SERVED)
    expect(await store.getCursor()).toBeNull()
    expect(idx.cursorBlock).toBeNull()
    expect(await count("events")).toBe(0)

    await idx.trigger()
    expect(await eventTypes()).toEqual(["launchpad.launch", "launchpad.trade"])
    expect(await store.getCursor()).toEqual({ block: S + 20n, hash: chain.hashOf(S + 20n) })
  })

  it("does not roll back when the cursor block is not served", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 50n, sold: 1n })
    const { idx, warnings } = await indexerFor(chain)
    await idx.trigger()
    const before = await ids()

    chain.head = S + 101n
    trade(chain, { n: 1, block: S + 101n, sold: 2n })
    chain.nullOnce.add(S + 100n)
    await idx.trigger()
    expect(warnings).toContain(NOT_SERVED)
    expect(warnings).not.toContain("reorg: rolled back to fork block")
    expect(await ids()).toEqual(before)
    expect(await store.getCursor()).toEqual({ block: S + 100n, hash: chain.hashOf(S + 100n) })

    await idx.trigger()
    expect(warnings).not.toContain("reorg: rolled back to fork block")
    expect((await ids()).slice(0, before.length)).toEqual(before)
    expect(await eventTypes()).toEqual(["launchpad.launch", "launchpad.trade", "launchpad.trade"])
    expect(await store.getCursor()).toEqual({ block: S + 101n, hash: chain.hashOf(S + 101n) })
  })

  it("does not roll back when a block in the recent-blocks walk is not served", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 50n, sold: 1n })
    const { idx, warnings } = await indexerFor(chain)
    await idx.trigger()
    const before = await ids()
    const cursorBefore = await store.getCursor()

    chain.reorg(S + 100n) // the cursor block's hash now differs, so the walk starts
    chain.nullOnce.add(S + 50n)
    await idx.trigger()
    expect(warnings).toContain(NOT_SERVED)
    expect(warnings).not.toContain("reorg: rolled back to fork block")
    expect(await ids()).toEqual(before)
    expect(await store.getCursor()).toEqual(cursorBefore)
  })
})

describe("Indexer log and block endpoints disagreeing", () => {
  it("writes nothing when the newest log block was reorged away between getLogs and getBlock", async () => {
    const chain = new FakeChain(S + 20n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 15n, sold: 1n })
    const warnings: string[] = []
    const idx = new Indexer({
      chain,
      store,
      logger: (level, msg) => {
        if (level === "warn") warnings.push(msg)
      },
    })
    await idx.init()
    const getLogs = chain.getLogs.bind(chain)
    chain.getLogs = async (from, to, filter) => {
      const r = await getLogs(from, to, filter)
      chain.reorg(S + 15n) // the block endpoint now sees the other fork
      return r
    }
    await idx.trigger()
    expect(warnings).toContain("block not yet served; retrying on next head")
    expect([await count("events"), await count("trades")]).toEqual([0, 0])
    expect(await store.getCursor()).toBeNull()

    chain.getLogs = getLogs
    trade(chain, { n: 1, block: S + 16n, sold: 2n })
    await idx.trigger()
    expect(await eventTypes()).toEqual(["launchpad.launch", "launchpad.trade"])
    expect(await store.getCursor()).toEqual({ block: S + 20n, hash: chain.hashOf(S + 20n) })
  })
})

describe("Indexer confirmation is atomic with inserts", () => {
  /**
   * Invariant for a consumer polling `where confirmed and id > $1`: whenever a state is committed
   * with head H, no event with block <= H-1 is unconfirmed while a higher-id event is confirmed.
   * Equivalently: every unconfirmed event that is old enough to be confirmed has no confirmed
   * event above it.
   */
  async function violations(head: bigint) {
    return sql`
      select u.id as unconfirmed_id, c.id as confirmed_id
      from indexer.events u join indexer.events c on c.id > u.id and c.confirmed
      where not u.confirmed and u.block <= ${(head - 1n).toString()}`
  }

  /** Stronger form: no unconfirmed event has a confirmed event of higher id, whatever the block. */
  async function orderViolations() {
    return sql`
      select u.id as unconfirmed_id, c.id as confirmed_id
      from indexer.events u join indexer.events c on c.id > u.id and c.confirmed
      where not u.confirmed`
  }

  function watched() {
    const seen: unknown[] = []
    const checking: Store = {
      ...store,
      writeBatch: async (batch, opts) => {
        await store.writeBatch(batch, opts)
        seen.push(...(await violations(opts.head)), ...(await orderViolations()))
      },
    }
    return { checking, seen }
  }

  it("never commits a confirmed event above an old-enough unconfirmed one across a multi-span catch-up", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 100n, sold: 1n }) // tip row, unconfirmed at head S+100
    const first = watched()
    const idx1 = new Indexer({ chain, store: first.checking, logger: () => {} })
    await idx1.init()
    await idx1.trigger()
    expect(
      (await sql`select confirmed from indexer.events order by id`).map((r) => r.confirmed),
    ).toEqual([true, false])

    chain.maxSpan = 2n
    chain.head = S + 106n
    trade(chain, { n: 1, block: S + 102n, sold: 2n })
    trade(chain, { n: 1, block: S + 104n, sold: 3n })
    trade(chain, { n: 1, block: S + 106n, sold: 4n })
    const second = watched()
    const idx2 = new Indexer({ chain, store: second.checking, logger: () => {} })
    await idx2.init()
    await idx2.trigger()
    expect(second.seen).toEqual([])
    expect(await violations(S + 106n)).toEqual([])
  })

  it("holds after a tick aborted by a block that is not served after some spans were written", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 100n, sold: 1n })
    const warm = watched()
    const idx0 = new Indexer({ chain, store: warm.checking, logger: () => {} })
    await idx0.init()
    await idx0.trigger()

    chain.maxSpan = 2n
    chain.head = S + 110n
    trade(chain, { n: 1, block: S + 102n, sold: 2n })
    trade(chain, { n: 1, block: S + 108n, sold: 3n })
    chain.nullOnce.add(S + 106n) // the third span's end block is not served
    const w = watched()
    const idx = new Indexer({ chain, store: w.checking, logger: () => {} })
    await idx.init()
    await idx.trigger() // aborted mid-way: earlier spans committed, no store.confirm ran
    expect(await store.getCursor()).toEqual({ block: S + 104n, hash: chain.hashOf(S + 104n) })
    expect(w.seen).toEqual([])
    expect(await violations(S + 110n)).toEqual([])
    await idx.trigger()
    expect(await violations(S + 110n)).toEqual([])
  })
})

describe("Indexer.tickSuccesses", () => {
  it("counts ticks that complete, not ticks aborted by a block that is not served", async () => {
    const chain = new FakeChain(S + 20n)
    const { idx } = await indexerFor(chain)
    expect(idx.tickSuccesses).toBe(0)
    chain.nullOnce.add(S + 20n)
    await idx.trigger()
    expect(idx.tickSuccesses).toBe(0)
    await idx.trigger()
    expect(idx.tickSuccesses).toBe(1)
    await idx.trigger()
    expect(idx.tickSuccesses).toBe(2)
  })

  it("does not count a tick that throws", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()
    chain.reorg(S)
    await expect(idx.trigger()).rejects.toThrow(/refusing to guess/)
    expect(idx.tickSuccesses).toBe(1)
  })
})

describe("Indexer.lastHead", () => {
  it("is undefined before the first tick and the head the tick started from after it", async () => {
    const chain = new FakeChain(S + 5n)
    const { idx } = await indexerFor(chain)
    expect(idx.lastHead).toBeUndefined()
    await idx.trigger()
    expect(idx.lastHead).toBe(S + 5n)
  })
})

describe("Indexer in-memory cursor and head fetches", () => {
  it("tracks the stored cursor through ingest and rollback, and counts head fetches", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 100n, sold: 4n * 10n ** 26n })
    const { idx } = await indexerFor(chain)
    expect(idx.cursorBlock).toBeNull()
    expect(idx.headFetches).toBe(0)
    await idx.trigger()
    expect(idx.cursorBlock).toBe(S + 100n)
    expect(idx.cursorBlock).toBe((await store.getCursor())!.block)
    expect(idx.headFetches).toBe(1)

    chain.reorg(S + 100n)
    trade(chain, { n: 1, block: S + 100n, sold: 2n * 10n ** 26n })
    chain.states.set(LAUNCH_KEY, stateFor(tokenOf(1), 0n))
    await idx.trigger()
    expect(idx.cursorBlock).toBe((await store.getCursor())!.block)
    expect(idx.headFetches).toBe(2)
  })

  it("starts from the stored cursor", async () => {
    const chain = new FakeChain(S + 50n)
    const first = await indexerFor(chain)
    await first.idx.trigger()
    const second = await indexerFor(chain)
    expect(second.idx.cursorBlock).toBe(S + 50n)
  })
})
