import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { Hash } from "viem"
import { afterEach, describe, expect, inject, it } from "vitest"
import { loadCalamariFixture, loadTsunamiFixture } from "../../../packages/sdk/test/fixtures"
import { Indexer } from "../src/loop"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import type { BackfillSource } from "../src/sources/source"
import { tsunamiSource } from "../src/sources/tsunami/index"
import { v4Source } from "../src/sources/v4/index"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import { addCalamari, addFixture, seedToken } from "./tsunami-scenario"

const GATEWAY = "https://gw.example"
const fixtureDir = join(import.meta.dirname, "../../../packages/sdk/test/fixtures")
const recorded = (name: string) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"))
const DOCS: Record<string, unknown> = {
  QmcaeX23WJnjF1khSSyHcA9MdrK9ryz6uu4KN3zfE1kdiK: recorded("tsunami-metadata-shitcoin.json"),
  QmNZaPhzN42DT4Z4XkuCF6fgK9sS1XR7zEoDzyH7Mmtw7V: recorded("tsunami-metadata-gm.json"),
}
const metadataFetch = (async (url: string) => {
  const doc = DOCS[url.replace(`${GATEWAY}/ipfs/`, "")]
  return doc === undefined ? new Response("nope", { status: 404 }) : Response.json(doc)
}) as unknown as typeof fetch

/** History already indexed when the live process starts: the first stretch of the recorded launches. */
const SEED_FROM = 56_000_000n
const SEED_TO = 56_100_000n
/** Where the backfill starts, and the live cursor and the last block it covers. */
const BACKFILL_FROM = SEED_TO + 1n
const LIVE_CURSOR = 59_700_000n
const BACKFILL_TO = 59_890_000n
/** The heads the live process sees, one per tick: two land on a block holding a swap. */
const LIVE_HEADS = [59_751_391n, 59_800_000n, 59_850_000n, 59_911_867n, 59_950_000n]
const FINAL_HEAD = 59_960_000n
/**
 * The recorded swap, copied into one block below the live cursor (only the backfill covers it) and
 * one above (the backfill and the live tick both do).
 */
const COPIED_SWAPS = [
  { block: 59_600_000n, tx: `0x${"c0".repeat(32)}` as Hash },
  { block: 59_800_000n, tx: `0x${"c1".repeat(32)}` as Hash },
]

const LIVE_SOURCES: BackfillSource[] = ["inkypump", "v4-swaps"]
const BACKFILL_SOURCES: BackfillSource[] = ["tsunami", "v4-swaps"]

let open: Sql[] = []
afterEach(async () => {
  await Promise.all(open.map((s) => s.end()))
  open = []
})

/** The recorded Tsunami and Calamari transactions, with the recorded swap copied into two covered blocks. */
function chainWithFixtures() {
  const chain = new FakeChain(FINAL_HEAD - 10_000n)
  chain.maxSpan = 500_000n
  for (const name of [
    "tsunami-launch-gm",
    "tsunami-graduation-gm",
    "tsunami-launch-usdc-buyer",
    "tsunami-usdc-buy",
    "tsunami-launch-riptide",
    "tsunami-sell",
  ] as const)
    addFixture(chain, name)
  addCalamari(chain, "calamari-swap-gm-first")
  addCalamari(chain, "calamari-swap-gm")
  const first = loadCalamariFixture("calamari-swap-gm-first")
  for (const { block, tx } of COPIED_SWAPS) {
    for (const l of first.logs) chain.add({ ...l, blockNumber: block, transactionHash: tx })
    chain.senders.set(block, {
      hash: chain.hashOf(block),
      senders: new Map([[tx, Object.values(first.senders)[0]!]]),
      timestamp: first.timestamp + 1,
    })
  }
  chain.head = FINAL_HEAD
  return chain
}

/** One process: the InkyPump, Tsunami and v4 sources over a shared pool registry, as `main.ts` builds them. */
function processOf(
  sql: Sql,
  chain: FakeChain,
  store: Store,
  only?: readonly BackfillSource[],
  warnings: string[] = [],
) {
  const logger = (level: string, msg: string) => {
    if (level === "warn") warnings.push(msg)
  }
  const pools = new PoolRegistry()
  return new Indexer({
    chain,
    store,
    logger,
    only,
    sleep: async () => {
      chain.head += 1n
    },
    sources: [
      inkypumpSource({ sql, chain, logger, pools }),
      tsunamiSource({
        sql,
        chain,
        logger,
        pools,
        ipfs: { gateway: GATEWAY, fetch: metadataFetch },
      }),
      v4Source({ sql, chain, logger, pools }),
    ],
  })
}

/** Everything the readers and the tables hold, minus the columns that name when and in what order it was written. */
async function snapshot(sql: Sql) {
  const strip = <T extends Record<string, unknown>>(rows: T[]) =>
    rows.map(({ created_at: _a, updated_at: _b, id: _c, ...rest }) => rest)
  return {
    events: strip(
      await sql`select * from indexer.events order by block, log_index, sub, tx_hash`,
    ).map(({ confirmed: _confirmed, ...rest }) => rest),
    // The block a dead balance was first read at is the live cursor's at that moment, so it differs by run.
    tokens: strip(await sql`select * from indexer.tokens order by address`).map(
      ({ dead_balance_block: _block, ...rest }) => rest,
    ),
    trades: strip(await sql`select * from indexer.trades order by block, tx_hash, log_index`),
    pools: strip(await sql`select * from indexer.pools order by pool_id`),
    curve: strip(await sql`select * from indexer.curve_state order by token`),
  }
}

/** The history before the backfill range, and a live cursor in the middle of the recorded activity. */
async function seeded(chain: FakeChain) {
  const sql = await resetDb(inject("databaseUrl"))
  open.push(sql)
  const sell = loadTsunamiFixture("tsunami-sell").curves[0]!
  await seedToken(sql, { curve: sell.curve, token: sell.token })
  const store = createStore(sql)
  const seed = processOf(sql, chain, store)
  await seed.init()
  await seed.backfill(SEED_FROM, SEED_TO, BACKFILL_SOURCES)
  await store.writeBatch([], [], {
    cursor: { block: LIVE_CURSOR, hash: chain.hashOf(LIVE_CURSOR) },
    head: LIVE_CURSOR,
  })
  return sql
}

/** The tables of a backfill of the whole range followed by `start`. */
async function sequential() {
  const chain = chainWithFixtures()
  const sql = await seeded(chain)
  const store = createStore(sql)
  const back = processOf(sql, chain, store)
  await back.init()
  await back.backfill(BACKFILL_FROM, FINAL_HEAD, BACKFILL_SOURCES)
  const live = processOf(sql, chain, store, ["inkypump", "tsunami", "v4-swaps"])
  await live.init()
  for (const head of [...LIVE_HEADS, FINAL_HEAD]) {
    chain.head = head
    await live.trigger()
  }
  chain.head = FINAL_HEAD
  return snapshot(sql)
}

function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The deployed shape: `start` runs without the Tsunami source while a backfill of `tsunami` and
 * `v4-swaps` follows it with a fixed end, `ticksBefore[k]` live ticks run before the backfill's k-th
 * span (the first entry before the backfill starts), then a stop covers the last blocks and
 * `start` comes back with the Tsunami source.
 */
async function beside(ticksBefore: number[]) {
  const chain = chainWithFixtures()
  const sql = await seeded(chain)
  const liveStore = createStore(sql)
  const backStore = createStore(sql)
  const order: string[] = []
  const written: { stores: string; types: string[] }[] = []
  const watch = (name: string, store: Store): Store => ({
    ...store,
    writeBatch: async (batches, writers, opts) => {
      await store.writeBatch(batches, writers, opts)
      written.push({
        stores: name,
        types: batches.flatMap((b) => b.events.map((e) => e.event.type)),
      })
      const bad = await sql`
        select u.id from indexer.events u join indexer.events c on c.id > u.id and c.confirmed
        where not u.confirmed`
      if (bad.length > 0) order.push(`${name}: ${bad.length} rows below a confirmed row`)
      await poll()
    },
  })
  // A reader of `confirmed and id > cursor`, as the bot reads.
  let cursor = 0n
  const read: bigint[] = []
  async function poll() {
    const got = await sql<{ id: bigint }[]>`
      select id from indexer.events where confirmed and id > ${cursor.toString()} order by id`
    for (const r of got) read.push(r.id)
    if (got.length > 0) cursor = got.at(-1)!.id
  }

  const liveChain = Object.assign(Object.create(chain) as FakeChain, {
    getBlockNumber: async () => liveHead,
  })
  let liveHead = LIVE_CURSOR
  const live = processOf(sql, liveChain, watch("live", liveStore), LIVE_SOURCES)
  await live.init()
  let next = 0
  const tick = async (n: number) => {
    for (let i = 0; i < n && next < LIVE_HEADS.length; i++) {
      liveHead = LIVE_HEADS[next++]!
      await live.trigger()
      await poll()
    }
  }

  await tick(ticksBefore[0] ?? 0)
  let span = 0
  let lastFrom = -1n
  const backChain = Object.assign(Object.create(chain) as FakeChain, {
    getLogs: async (from: bigint, to: bigint, filter: Parameters<FakeChain["getLogs"]>[2]) => {
      if (from !== lastFrom && from >= BACKFILL_FROM) {
        lastFrom = from
        await tick(ticksBefore[++span] ?? 0)
      }
      return chain.getLogs(from, to, filter)
    },
  })
  const back = processOf(sql, backChain, watch("backfill", backStore))
  await back.init()
  await back.backfill(BACKFILL_FROM, BACKFILL_TO, BACKFILL_SOURCES)
  await tick(LIVE_HEADS.length)

  // The stop: the last blocks, and Tsunami joins the live sources.
  const gap = processOf(sql, chain, watch("backfill", backStore))
  await gap.init()
  await gap.backfill(BACKFILL_TO + 1n, LIVE_HEADS.at(-1)!, BACKFILL_SOURCES)
  liveHead = FINAL_HEAD
  chain.head = FINAL_HEAD
  const restarted = processOf(sql, liveChain, watch("live", liveStore), [
    "inkypump",
    "tsunami",
    "v4-swaps",
  ])
  await restarted.init()
  await restarted.trigger()
  await poll()

  const ids = (await sql<{ id: bigint }[]>`select id from indexer.events order by id`).map(
    (r) => r.id,
  )
  return { sql, order, written, read, ids, chain }
}

describe("backfill beside start", () => {
  it("writes the rows of a backfill followed by start, in every order of live ticks and spans", async () => {
    const expected = await sequential()
    expect(expected.events.length).toBeGreaterThan(8)
    expect(expected.trades.length).toBeGreaterThan(3)
    expect(expected.pools.length).toBeGreaterThan(0)

    const random = Array.from({ length: 20 }, (_, i) => {
      const r = rng(i + 1)
      return Array.from({ length: 12 }, () => (r() < 0.4 ? 1 : 0))
    })
    const interleavings: [string, number[]][] = [
      ["backfill first", []],
      ["live first", [LIVE_HEADS.length]],
      ["alternating", Array.from({ length: 12 }, () => 1)],
      ...random.map((ticks, i): [string, number[]] => [`seeded ${i + 1}`, ticks]),
    ]
    for (const [name, ticks] of interleavings) {
      const run = await beside(ticks)
      try {
        expect.soft(await snapshot(run.sql), name).toEqual(expected)
        expect.soft(run.order, name).toEqual([])
        // Every confirmed row was read, in id order, by a reader that only ever moves forward.
        expect.soft(run.read, name).toEqual(run.ids)
        // Until the Tsunami source joins, the live process writes pool swaps only.
        const liveTypes = new Set(
          run.written.filter((w) => w.stores === "live").flatMap((w) => w.types),
        )
        expect(
          [...liveTypes].every((t) => t === "launchpad.swap"),
          name,
        ).toBe(true)
      } finally {
        await run.sql.end()
        open = open.filter((s) => s !== run.sql)
      }
    }
  }, 180_000)
})
