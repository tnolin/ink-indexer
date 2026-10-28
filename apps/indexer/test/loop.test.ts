import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { type ChainLog, INKYPUMP_START_BLOCK as S } from "@ink-indexer/sdk"
import { type Address, type Hash, type Hex, pad, toHex } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Chain } from "../src/chain"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import type { LogFilter } from "../src/rpc"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import type { Source, Tx } from "../src/sources/source"
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

/** An indexer with only the InkyPump source registered. */
function pumpIndexer(chain: Chain, s: Store, logger: Logger = () => {}) {
  return new Indexer({
    chain,
    store: s,
    logger,
    sources: [inkypumpSource({ sql, chain, pools: new PoolRegistry(), logger })],
  })
}

async function indexerFor(chain: FakeChain) {
  const warnings: string[] = []
  const idx = pumpIndexer(chain, store, (level, msg) => {
    if (level === "warn") warnings.push(msg)
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
    const idx = pumpIndexer(chain, flaky)
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
    const idx = pumpIndexer(chain, store, (level, msg) => {
      if (level === "warn") warnings.push(msg)
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
      writeBatch: async (batches, writers, opts) => {
        await store.writeBatch(batches, writers, opts)
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
    const idx1 = pumpIndexer(chain, first.checking)
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
    const idx2 = pumpIndexer(chain, second.checking)
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
    const idx0 = pumpIndexer(chain, warm.checking)
    await idx0.init()
    await idx0.trigger()

    chain.maxSpan = 2n
    chain.head = S + 110n
    trade(chain, { n: 1, block: S + 102n, sold: 2n })
    trade(chain, { n: 1, block: S + 108n, sold: 3n })
    chain.nullOnce.add(S + 106n) // the third span's end block is not served
    const w = watched()
    const idx = pumpIndexer(chain, w.checking)
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

describe("Indexer over several sources", () => {
  const A: Address = "0x00000000000000000000000000000000000000a1"
  const B: Address = "0x00000000000000000000000000000000000000b1"
  const T1 = pad("0x01", { size: 32 }) as Hex
  const T2 = pad("0x02", { size: 32 }) as Hex
  const filterA: LogFilter = { address: A, topics: [] }
  const filterB1: LogFilter = { address: B, topics: [T1] }
  const filterB2: LogFilter = { address: B, topics: [T2] }

  let n = 0
  const log = (address: Address, topic: Hex, block: bigint): ChainLog => ({
    address,
    topics: [topic],
    data: "0x",
    blockNumber: block,
    blockHash: "0x00",
    transactionHash: pad(toHex(0xab0000 + ++n), { size: 32 }) as Hash,
    logIndex: 0,
  })

  beforeEach(async () => {
    await sql`create table indexer.fake_writes (source text not null, block bigint not null)`
  })

  /** A source that records every call in `calls` and writes its log blocks to fake_writes. */
  function fakeSource(name: string, filters: LogFilter[], calls: string[], failWrite = false) {
    const seen: { logs: ChainLog[][]; toBlock: bigint }[] = []
    const live: boolean[] = []
    const rollbackTxs: Tx[] = []
    const source: Source<{ events: []; blocks: { number: bigint; hash: Hash }[] }, string> = {
      name,
      filters: () => filters,
      async process(logs, ctx) {
        seen.push({ logs, toBlock: ctx.toBlock })
        live.push(ctx.live)
        const blocks = new Map(logs.flat().map((l) => [l.blockNumber, l.blockHash]))
        return { events: [], blocks: [...blocks].map(([number, hash]) => ({ number, hash })) }
      },
      async write(tx, batch) {
        calls.push(`${name}.write`)
        if (failWrite) throw new Error(`${name} write failed`)
        for (const b of batch.blocks)
          await tx`insert into indexer.fake_writes values (${name}, ${b.number.toString()})`
      },
      async prepareRollback(fork) {
        calls.push(`${name}.prepare:${fork - S}`)
        return `${name}-prepared`
      },
      async rollback(tx, fork, prepared) {
        calls.push(`${name}.rollback:${fork - S}:${prepared}`)
        rollbackTxs.push(tx)
        await tx`delete from indexer.fake_writes where source = ${name} and block > ${fork.toString()}`
      },
      async reload() {
        calls.push(`${name}.reload`)
      },
    }
    return { source, seen, live, rollbackTxs }
  }

  /** Records [from - S, to - S, filter] for every getLogs call. */
  function recordGetLogs(chain: FakeChain) {
    const recorded: [bigint, bigint, LogFilter][] = []
    const getLogs = chain.getLogs.bind(chain)
    chain.getLogs = async (from, to, filter) => {
      recorded.push([from - S, to - S, filter])
      return getLogs(from, to, filter)
    }
    return recorded
  }

  const fakeWrites = async () =>
    (
      await sql<{ source: string; block: bigint }[]>`
        select source, block from indexer.fake_writes order by source, block`
    ).map((r) => `${r.source}:${r.block - S}`)

  it("runs every source's filters over the same range and moves one cursor", async () => {
    const chain = new FakeChain(S + 20n)
    const la = log(A, T1, S + 5n)
    const lb1 = log(B, T1, S + 7n)
    const lb2 = log(B, T2, S + 15n)
    for (const l of [la, lb1, lb2]) chain.add(l)
    const recorded = recordGetLogs(chain)
    const calls: string[] = []
    const a = fakeSource("a", [filterA], calls)
    const b = fakeSource("b", [filterB1, filterB2], calls)
    const idx = new Indexer({ chain, store, logger: () => {}, sources: [a.source, b.source] })
    await idx.init()
    await idx.trigger()

    // The three address-bound filters are one request; each source still gets its own logs.
    expect(recorded).toEqual([[0n, 20n, { address: [A, B], topics: [] }]])
    const hashed = (l: ChainLog) => ({ ...l, blockHash: chain.hashOf(l.blockNumber) })
    expect(a.seen).toEqual([{ logs: [[hashed(la)]], toBlock: S + 20n }])
    expect(b.seen).toEqual([{ logs: [[hashed(lb1)], [hashed(lb2)]], toBlock: S + 20n }])
    expect(calls).toEqual(["a.reload", "b.reload", "a.write", "b.write"])
    expect(await fakeWrites()).toEqual(["a:5", "b:7", "b:15"])
    expect(await sql`select source, block from indexer.cursors`).toEqual([
      { source: "inkypump", block: S + 20n },
    ])
    expect((await store.recentBlocks()).map((r) => r.number - S)).toEqual([20n, 15n, 7n, 5n])
    expect(idx.cursorBlock).toBe(S + 20n)
  })

  it("tells sources whether a span is the live tick or a backfill", async () => {
    const chain = new FakeChain(S + 20n)
    chain.add(log(A, T1, S + 5n))
    const a = fakeSource("a", [filterA], [])
    const idx = new Indexer({ chain, store, logger: () => {}, sources: [a.source] })
    await idx.init()
    await idx.trigger()
    await idx.backfill(S, S + 20n)
    expect(a.live).toEqual([true, false])
  })

  it("clamps the range to the smallest toBlock any filter returned and drops logs above it", async () => {
    const chain = new FakeChain(S + 20n)
    const early = log(A, T1, S + 5n)
    const late = log(A, T1, S + 15n)
    chain.add(early)
    chain.add(late)
    const recorded = recordGetLogs(chain)
    const recording = chain.getLogs
    // The transport serving filterB1 has only seen up to S + 10 on the first span.
    chain.getLogs = async (from, to, filter) => {
      const r = await recording(from, to, filter)
      if (filter !== filterB1 || from > S + 10n) return r
      const toBlock = S + 10n < to ? S + 10n : to
      return { logs: r.logs.filter((l) => l.blockNumber <= toBlock), toBlock }
    }
    const calls: string[] = []
    const a = fakeSource("a", [filterA], calls)
    const b = fakeSource("b", [filterB1, filterB2], calls)
    const idx = new Indexer({
      chain,
      store,
      logger: () => {},
      sources: [a.source, b.source],
      // One request per filter, so the clamp from one request reaches the next.
      mergeRequests: false,
    })
    await idx.init()
    await idx.trigger()

    expect(recorded).toEqual([
      [0n, 20n, filterA],
      [0n, 20n, filterB1],
      [0n, 10n, filterB2],
      [11n, 20n, filterA],
      [11n, 20n, filterB1],
      [11n, 20n, filterB2],
    ])
    const hashed = (l: ChainLog) => ({ ...l, blockHash: chain.hashOf(l.blockNumber) })
    expect(a.seen).toEqual([
      { logs: [[hashed(early)]], toBlock: S + 10n },
      { logs: [[hashed(late)]], toBlock: S + 20n },
    ])
    expect(b.seen.map((s) => s.toBlock)).toEqual([S + 10n, S + 20n])
    expect(await fakeWrites()).toEqual(["a:5", "a:15"])
    expect(await store.getCursor()).toEqual({ block: S + 20n, hash: chain.hashOf(S + 20n) })
  })

  it("a failing source write rolls back the whole batch and calls reload on every source", async () => {
    const chain = new FakeChain(S + 20n)
    launch(chain, { n: 1, block: S + 10n })
    chain.add(log(A, T1, S + 12n))
    const calls: string[] = []
    const a = fakeSource("a", [filterA], calls)
    const b = fakeSource("b", [filterB1], calls, true)
    const idx = new Indexer({
      chain,
      store,
      logger: () => {},
      sources: [
        inkypumpSource({ sql, chain, pools: new PoolRegistry(), logger: () => {} }),
        a.source,
        b.source,
      ],
    })
    await idx.init()
    await expect(idx.trigger()).rejects.toThrow("b write failed")

    expect(calls).toEqual(["a.reload", "b.reload", "a.write", "b.write", "a.reload", "b.reload"])
    expect([await count("events"), await count("tokens"), await count("recent_blocks")]).toEqual([
      0, 0, 0,
    ])
    expect(await fakeWrites()).toEqual([])
    expect(await store.getCursor()).toBeNull()
    expect(idx.cursorBlock).toBeNull()
  })

  it("rollback calls prepareRollback outside and rollback inside one transaction for every source", async () => {
    const chain = new FakeChain(S + 20n)
    chain.add(log(A, T1, S + 5n))
    chain.add(log(B, T1, S + 10n))
    const calls: string[] = []
    const a = fakeSource("a", [filterA], calls)
    const b = fakeSource("b", [filterB1], calls)
    const warnings: string[] = []
    const idx = new Indexer({
      chain,
      store,
      logger: (level, msg) => {
        if (level === "warn") warnings.push(msg)
      },
      sources: [a.source, b.source],
    })
    await idx.init()
    await idx.trigger()
    expect(await fakeWrites()).toEqual(["a:5", "b:10"])

    chain.reorg(S + 8n) // S + 10 and S + 20 change hash; S + 5 is the fork block
    calls.length = 0
    await idx.trigger()

    expect(calls).toEqual([
      "a.prepare:5",
      "b.prepare:5",
      "a.rollback:5:a-prepared",
      "b.rollback:5:b-prepared",
      "a.reload",
      "b.reload",
      "a.write",
      "b.write",
    ])
    expect(a.rollbackTxs).toHaveLength(1)
    expect(b.rollbackTxs[0]).toBe(a.rollbackTxs[0])
    expect(warnings).toContain("reorg: rolled back to fork block")
    expect(await fakeWrites()).toEqual(["a:5"])
    expect(await store.getCursor()).toEqual({ block: S + 20n, hash: chain.hashOf(S + 20n) })
  })
})
