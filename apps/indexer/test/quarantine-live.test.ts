import { PostgresError, type Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { inkfunClosingSold, INKYPUMP_START_BLOCK as S } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { Indexer } from "../src/loop"
import { badDataError } from "../src/quarantine"
import { inkfunSource } from "../src/sources/inkfun/index"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import type { Source, SourceBatch, SourceName } from "../src/sources/source"
import { v4Source } from "../src/sources/v4/index"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import {
  CURVE_PARAMS,
  tokenOf as funToken,
  inkfunBuy,
  inkfunLaunch,
  inkfunMigrate,
  poolIdOf,
} from "./inkfun-scenario"
import {
  afterWrite,
  createFakeWrites,
  plainWriter,
  recordingLogger,
  recordingReporter,
  refusing,
  writerLog,
} from "./quarantine-harness"
import { bond, launch, tokenOf, trade } from "./scenario"
import { swap } from "./v4-scenario"

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  await createFakeWrites(sql)
})
afterEach(() => sql.end())

const FAKE: Address = "0x00000000000000000000000000000000000000f0"

const launchesOf =
  (...ns: number[]) =>
  (b: SourceBatch) =>
    b.events.some(({ event }) => {
      if (event.type !== "launchpad.launch") return false
      const token = event.token
      return ns.some((n) => token === tokenOf(n))
    })

/** A chain of 10-block spans from the start block, with every span ending at `head`. */
function chainTo(head: bigint) {
  const chain = new FakeChain(head)
  chain.maxSpan = 10n
  return chain
}

function rig(
  chain: FakeChain,
  build: (pump: Source, pools: PoolRegistry) => Source[],
  opts: { paused?: SourceName[]; store?: Store } = {},
) {
  const pools = new PoolRegistry()
  const logs = recordingLogger()
  const report = recordingReporter()
  const pump = inkypumpSource({ sql, chain, logger: () => {}, pools })
  const sources = build(pump, pools)
  const open = async (paused = opts.paused) => {
    const idx = new Indexer({
      chain,
      store: opts.store ?? store,
      logger: logs.logger,
      report,
      sources,
      paused,
    })
    await idx.init()
    return idx
  }
  return { open, logs, report, sources, pools }
}

const rows = () =>
  sql<
    {
      source: string
      kind: string
      mode: string
      from_block: bigint
      to_block: bigint | null
      sqlstate: string
      message: string
      replay_sources: string
      cleared_at: Date | null
    }[]
  >`select source, kind, mode, from_block, to_block, sqlstate, message, replay_sources, cleared_at
    from indexer.quarantine order by id`
const count = async (table: string) =>
  Number((await sql.unsafe(`select count(*)::int as n from indexer.${table}`))[0]!.n)
const tokens = async () =>
  (await sql<{ address: string }[]>`select address from indexer.tokens order by address`).map(
    (r) => r.address,
  )
const written = async () =>
  (
    await sql<
      { source: string; block: bigint }[]
    >`select source, block from indexer.fake_writes order by block`
  ).map((r) => `${r.source}:${r.block - S}`)
const eventBlocks = async () =>
  (
    await sql<{ type: string; block: bigint }[]>`select type, block from indexer.events order by id`
  ).map((r) => `${r.type}:${r.block - S}`)
const skipText = (source: string, from: bigint, to: bigint) =>
  `${source} skipped blocks ${from} to ${to} after a refused write; the other sources kept the span`
const pauseText = (source: string, from: bigint) =>
  `${source} paused from block ${from}; the other sources keep running`

/** The InkyPump source refusing the launches of `ns`, and a plain writer beside it. */
const pumpAndWriter =
  (ns: number[], calls: string[] = []) =>
  (pump: Source) => [
    refusing(pump, launchesOf(...ns), "numeric"),
    plainWriter("tsunami", ["tsunami"], FAKE, calls),
  ]

describe("a refused write in the live loop", () => {
  it("a source refused once is skipped: the others' rows and events for the span are written in chain order, the cursor passes the span, one skip row, one warning and no error report, and the next span runs every source", async () => {
    const chain = chainTo(S + 19n)
    launch(chain, { n: 1, block: S + 2n })
    chain.add(writerLog(FAKE, S + 3n))
    launch(chain, { n: 2, block: S + 12n })
    chain.add(writerLog(FAKE, S + 13n))
    const t = rig(chain, pumpAndWriter([1]))
    const idx = await t.open()
    await idx.trigger()

    expect(await tokens()).toEqual([tokenOf(2)])
    expect(await eventBlocks()).toEqual([
      "launchpad.trade:3",
      "launchpad.launch:12",
      "launchpad.trade:13",
    ])
    expect(await written()).toEqual(["tsunami:3", "tsunami:13"])
    expect(await store.getCursor()).toEqual({ block: S + 19n, hash: chain.hashOf(S + 19n) })
    expect(await rows()).toHaveLength(1)
    expect(t.report.warns.map((w) => w.message)).toEqual([skipText("inkypump", S, S + 9n)])
    expect(t.report.errors).toEqual([])
    expect(t.logs.at("error").map((l) => l.msg)).toEqual([skipText("inkypump", S, S + 9n)])
    expect(idx.paused()).toEqual([])
  })

  it("the skip row carries the span, the SQLSTATE 22003, the message and replay_sources inkypump", async () => {
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    const t = rig(chain, pumpAndWriter([1]))
    await (await t.open()).trigger()

    const [r, ...rest] = await rows()
    expect(rest).toEqual([])
    expect(r).toMatchObject({
      source: "inkypump",
      kind: "skip",
      mode: "live",
      from_block: S,
      to_block: S + 9n,
      sqlstate: "22003",
      replay_sources: "inkypump",
      cleared_at: null,
    })
    expect(r?.message).toMatch(/numeric field overflow/)
    expect(t.report.warns[0]?.context).toMatchObject({
      source: "inkypump",
      kind: "skip",
      mode: "live",
      fromBlock: S,
      toBlock: S + 9n,
      sqlstate: "22003",
      replay: [
        `beside start: pnpm backfill --from ${S} --to ${S + 9n} --sources inkypump`,
        `beside start: pnpm backfill --from ${S} --to <a block at or below the live cursor> --sources v4-swaps`,
      ],
    })
  })

  it("a second refusal in the next span pauses the source from the skipped span's first block, with one error report, and the next tick leaves it out", async () => {
    const chain = chainTo(S + 19n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 12n })
    chain.add(writerLog(FAKE, S + 13n))
    const t = rig(chain, pumpAndWriter([1, 2, 3]))
    const idx = await t.open()
    await idx.trigger()

    expect(await rows()).toMatchObject([
      { kind: "skip", from_block: S, to_block: S + 9n },
      {
        kind: "pause",
        mode: "live",
        from_block: S,
        to_block: null,
        sqlstate: "22003",
        replay_sources: "inkypump,v4-swaps",
        cleared_at: null,
      },
    ])
    expect(t.report.errors.map((e) => e.message)).toEqual([pauseText("inkypump", S)])
    expect(t.report.errors[0]?.context).toMatchObject({ kind: "pause", toBlock: null })
    expect(t.report.warns).toHaveLength(1)
    expect(await tokens()).toEqual([])
    expect(await written()).toEqual(["tsunami:13"])
    expect(idx.paused()).toEqual(["inkypump"])
    expect(idx.isPaused("inkypump")).toBe(true)
    expect(idx.isPaused("tsunami")).toBe(false)

    chain.head = S + 29n
    launch(chain, { n: 3, block: S + 22n })
    chain.add(writerLog(FAKE, S + 23n))
    await idx.trigger()
    expect(await rows()).toHaveLength(2)
    expect(t.report.errors).toHaveLength(1)
    expect(await tokens()).toEqual([])
    expect(await written()).toEqual(["tsunami:13", "tsunami:23"])
    expect(await store.getCursor()).toMatchObject({ block: S + 29n })
  })

  it("a second refusal two spans after the skip pauses it", async () => {
    const chain = chainTo(S + 29n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 12n })
    launch(chain, { n: 3, block: S + 22n })
    const t = rig(chain, pumpAndWriter([1, 3]))
    await (await t.open()).trigger()

    expect(await tokens()).toEqual([tokenOf(2)])
    expect(await rows()).toMatchObject([
      { kind: "skip", from_block: S },
      { kind: "pause", from_block: S },
    ])
  })

  it("a refusal three spans after the skip is a new skip, not a pause", async () => {
    const chain = chainTo(S + 39n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 12n })
    launch(chain, { n: 3, block: S + 22n })
    launch(chain, { n: 4, block: S + 32n })
    const t = rig(chain, pumpAndWriter([1, 4]))
    const idx = await t.open()
    await idx.trigger()

    expect(await tokens()).toEqual([tokenOf(2), tokenOf(3)])
    expect(await rows()).toMatchObject([
      { kind: "skip", from_block: S, to_block: S + 9n },
      { kind: "skip", from_block: S + 30n, to_block: S + 39n },
    ])
    expect(t.report.errors).toEqual([])
    expect(t.report.warns).toHaveLength(2)
    expect(idx.paused()).toEqual([])
  })

  it("spans where the watched source has no logs do not count down its watch: a refusal on its next span with logs, ten empty spans later, pauses it", async () => {
    const chain = chainTo(S + 119n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 112n })
    const t = rig(chain, pumpAndWriter([1, 2]))
    const idx = await t.open()
    await idx.trigger()

    expect(await rows()).toMatchObject([
      { kind: "skip", from_block: S },
      { kind: "pause", from_block: S },
    ])
    expect(idx.paused()).toEqual(["inkypump"])
  })
})

describe("a source that finds a record missing", () => {
  it("a skipped InkyPump launch followed by its trade in the next span pauses inkypump from the skipped span, and the indexer keeps running", async () => {
    const chain = chainTo(S + 19n)
    launch(chain, { n: 1, block: S + 2n })
    trade(chain, { n: 1, block: S + 12n, sold: 1n })
    chain.add(writerLog(FAKE, S + 14n))
    const t = rig(chain, pumpAndWriter([1]))
    const idx = await t.open()
    await idx.trigger()

    expect(await rows()).toMatchObject([
      { kind: "skip", from_block: S, to_block: S + 9n },
      {
        kind: "pause",
        mode: "live",
        from_block: S,
        to_block: null,
        sqlstate: "dependency",
        replay_sources: "inkypump,v4-swaps",
      },
    ])
    expect(t.report.errors.map((e) => e.message)).toEqual([pauseText("inkypump", S)])
    expect(await written()).toEqual(["tsunami:14"])
    expect(await store.getCursor()).toMatchObject({ block: S + 19n })
    expect(idx.isPaused("inkypump")).toBe(true)
  })

  it("the same trade five spans later still pauses inkypump", async () => {
    const chain = chainTo(S + 59n)
    launch(chain, { n: 1, block: S + 2n })
    trade(chain, { n: 1, block: S + 52n, sold: 1n })
    const t = rig(chain, pumpAndWriter([1]))
    const idx = await t.open()
    await idx.trigger()

    expect(await rows()).toMatchObject([
      { kind: "skip", from_block: S },
      { kind: "pause", from_block: S, sqlstate: "dependency" },
    ])
    expect(idx.isPaused("inkypump")).toBe(true)
  })

  it("a network error from process during the watch is rethrown and nothing is recorded", async () => {
    const chain = chainTo(S + 19n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 12n })
    const boom = new Error("fetch failed")
    const read = chain.readLaunchStates.bind(chain)
    chain.readLaunchStates = async (keys, block) => {
      if (block >= S + 10n) throw boom
      return read(keys, block)
    }
    const t = rig(chain, pumpAndWriter([1]))
    const idx = await t.open()

    await expect(idx.trigger()).rejects.toBe(boom)
    expect(await rows()).toHaveLength(1)
    expect(t.report.errors).toEqual([])
    expect(idx.paused()).toEqual([])
    expect(await store.getCursor()).toMatchObject({ block: S + 9n })
  })

  it("a dependency error with no skip row pauses from the current span", async () => {
    const chain = chainTo(S + 19n)
    trade(chain, { n: 7, block: S + 12n, sold: 1n })
    chain.add(writerLog(FAKE, S + 14n))
    const t = rig(chain, pumpAndWriter([]))
    const idx = await t.open()
    await idx.trigger()

    expect(await rows()).toMatchObject([
      { kind: "pause", from_block: S + 10n, to_block: null, sqlstate: "dependency" },
    ])
    expect(t.report.errors.map((e) => e.message)).toEqual([pauseText("inkypump", S + 10n)])
    expect(await written()).toEqual(["tsunami:14"])
    expect(await store.getCursor()).toMatchObject({ block: S + 19n })
  })

  it("a dependency error after a restart pauses from the skip row written before the restart", async () => {
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    const t = rig(chain, pumpAndWriter([1]))
    await (await t.open()).trigger()
    expect(await rows()).toHaveLength(1)

    trade(chain, { n: 1, block: S + 12n, sold: 1n })
    chain.head = S + 19n
    const restarted = await t.open()
    await restarted.trigger()
    expect(await rows()).toMatchObject([
      { kind: "skip", from_block: S },
      { kind: "pause", from_block: S, sqlstate: "dependency" },
    ])
    expect(restarted.isPaused("inkypump")).toBe(true)
  })
})

describe("the span is read again without the source", () => {
  it("a launchpad skipped in a span where it registers a pool: v4 rows for the other launchpads' pools are written, no swap of the new pool is", async () => {
    const chain = chainTo(S + 19n)
    launch(chain, { n: 1, block: S + 1n })
    bond(chain, { n: 1, block: S + 2n })
    inkfunLaunch(chain, { n: 1, block: S + 11n, uri: null })
    inkfunBuy(chain, { n: 1, block: S + 12n, sold: inkfunClosingSold(CURVE_PARAMS) })
    inkfunMigrate(chain, { n: 1, block: S + 12n, logIndex: 2 })
    swap(chain, { block: S + 13n, poolId: poolIdOf(1) })
    swap(chain, { block: S + 14n })
    const t = rig(chain, (pump, pools) => {
      const fun = inkfunSource({
        sql,
        chain,
        logger: () => {},
        pools,
        ipfs: {
          gateway: "https://gw.example",
          fetch: async () => new Response("", { status: 404 }),
        },
      })
      return [
        pump,
        // The launch span of the ink.fun token is the one refused.
        afterWrite(
          fun,
          (b) => b.events.some((e) => e.event.type === "launchpad.bond"),
          (tx) => tx`select ${"1".padEnd(79, "0")}::numeric(78,0)`,
        ),
        v4Source({ sql, chain, logger: () => {}, pools }),
      ]
    })
    await (await t.open()).trigger()

    expect(await rows()).toMatchObject([
      { source: "inkfun", kind: "skip", from_block: S + 10n, replay_sources: "inkfun,v4-swaps" },
    ])
    const swaps = await sql<{ entity: string; block: bigint }[]>`
      select entity, block from indexer.events where type = 'launchpad.swap' order by block`
    expect(swaps).toEqual([{ entity: tokenOf(1), block: S + 14n }])
    expect(await count("tokens")).toBe(1)
    expect(await sql`select 1 from indexer.tokens where address = ${funToken(1)}`).toEqual([])
    expect(await store.getCursor()).toMatchObject({ block: S + 19n })
  })

  it("the re-run asks for no block past the failed attempt's end, writes sub-spans to it with the source left out, and the next span starts at T + 1", async () => {
    const chain = chainTo(S + 25n)
    launch(chain, { n: 1, block: S + 2n })
    // Its own span's last sub-span: the source stays out of it too.
    launch(chain, { n: 2, block: S + 8n })
    for (const b of [1n, 5n, 8n, 12n]) chain.add(writerLog(FAKE, S + b))
    const t = rig(chain, (pump) => [
      afterWrite(pump, launchesOf(1), async (tx) => {
        // The failed attempt has read its span; the endpoint now serves less per read.
        chain.maxSpan = 4n
        await tx`select ${"1".padEnd(79, "0")}::numeric(78,0)`
      }),
      plainWriter("tsunami", ["tsunami"], FAKE),
    ])
    await (await t.open()).trigger()

    const calls = chain.getLogsCalls.filter(
      (c, i, all) => i === 0 || c[0] !== all[i - 1]![0] || c[1] !== all[i - 1]![1],
    )
    expect(calls.slice(0, 4)).toEqual([
      [S, S + 9n],
      [S, S + 3n],
      [S + 4n, S + 7n],
      [S + 8n, S + 9n],
    ])
    expect(calls[4]![0]).toBe(S + 10n)
    expect(await rows()).toMatchObject([{ kind: "skip", from_block: S, to_block: S + 9n }])
    expect(await written()).toEqual(["tsunami:1", "tsunami:5", "tsunami:8", "tsunami:12"])
    expect(await tokens()).toEqual([])
    expect(await store.getCursor()).toMatchObject({ block: S + 25n })
  })

  it("after a skip every source's reload runs before the re-run", async () => {
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    chain.add(writerLog(FAKE, S + 3n))
    const calls: string[] = []
    const t = rig(chain, pumpAndWriter([1], calls))
    await (await t.open()).trigger()
    expect(calls).toEqual(["reload", "process", "reload", "process"])
  })
})

describe("the database refuses a write outside every source's step", () => {
  it("a NUL in one source's event payload is pinned on that source by the probe and skips only it", async () => {
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    chain.add(writerLog(FAKE, S + 3n))
    const t = rig(chain, (pump) => [
      refusing(pump, launchesOf(1), "json"),
      plainWriter("tsunami", ["tsunami"], FAKE),
    ])
    await (await t.open()).trigger()

    expect(await rows()).toMatchObject([
      { source: "inkypump", kind: "skip", sqlstate: "22P05", from_block: S, to_block: S + 9n },
    ])
    expect(await tokens()).toEqual([])
    expect(await written()).toEqual(["tsunami:3"])
    expect(await count("events")).toBe(1)
  })

  it("the probe pins a source in a later position, not the first", async () => {
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    chain.add(writerLog(FAKE, S + 3n))
    const t = rig(chain, (pump) => [
      pump,
      refusing(plainWriter("tsunami", ["tsunami"], FAKE), (b) => b.events.length > 0, "json"),
    ])
    await (await t.open()).trigger()

    expect(await rows()).toMatchObject([{ source: "tsunami", kind: "skip", sqlstate: "22P05" }])
    expect(await tokens()).toEqual([tokenOf(1)])
    expect(await written()).toEqual([])
  })

  it("a refused cursor or block-hash write that no source's events reproduce is rethrown with nothing recorded", async () => {
    await sql`alter table indexer.cursors add constraint refuse_cursor check (block < 0) not valid`
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    const t = rig(chain, (pump) => [pump])
    const idx = await t.open()

    const err = await idx.trigger().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PostgresError)
    expect((err as PostgresError).code).toBe("23514")
    expect(await rows()).toEqual([])
    expect(t.report.warns).toEqual([])
    expect(t.report.errors).toEqual([])
    expect(await count("events")).toBe(0)
  })
})

describe("a quarantine record that cannot be stored", () => {
  it("the error is the database's refusal of the record, with the refused write as its cause, and every source reloads", async () => {
    await sql`alter table indexer.quarantine rename column message to message_text`
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    chain.add(writerLog(FAKE, S + 3n))
    const calls: string[] = []
    const t = rig(chain, pumpAndWriter([1], calls))
    const idx = await t.open()
    const err = await idx.trigger().then(
      () => undefined,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(PostgresError)
    expect((err as PostgresError).code).toBe("42703")
    const cause = (err as Error).cause
    expect(cause).toBeInstanceOf(PostgresError)
    expect((cause as PostgresError).code).toBe("22003")
    expect(calls).toEqual(["reload", "process", "reload"])
    expect(await store.getCursor()).toBeNull()
    expect(t.report.errors).toEqual([])
  })
})

describe("a failure that another try may clear", () => {
  const KEY = 570_730_778

  it("a lock timeout in a source write is rethrown, reloaded and not recorded", async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    let ready: () => void = () => {}
    const holding = new Promise<void>((r) => {
      ready = r
    })
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${KEY}::bigint)`
      ready()
      await held
    })
    await holding
    const chain = chainTo(S + 9n)
    chain.add(writerLog(FAKE, S + 3n))
    const calls: string[] = []
    const t = rig(chain, () => [
      afterWrite(
        plainWriter("tsunami", ["tsunami"], FAKE, calls),
        () => true,
        async (tx) => {
          await tx`set local lock_timeout = '50ms'`
          await tx`select pg_advisory_xact_lock(${KEY}::bigint)`
        },
      ),
    ])
    const idx = await t.open()
    const err = await idx.trigger().then(
      () => undefined,
      (e: unknown) => e,
    )
    release()
    await holder

    expect(err).toBeInstanceOf(PostgresError)
    expect((err as PostgresError).code).toBe("55P03")
    expect(calls).toEqual(["reload", "process", "reload"])
    expect(await rows()).toEqual([])
    expect(t.report.errors).toEqual([])
    expect(await store.getCursor()).toBeNull()
  })

  it("raise sqlstate '40001' in a source write is rethrown and not recorded", async () => {
    const chain = chainTo(S + 9n)
    chain.add(writerLog(FAKE, S + 3n))
    const t = rig(chain, () => [
      afterWrite(
        plainWriter("tsunami", ["tsunami"], FAKE),
        () => true,
        (tx) =>
          tx`do $$ begin raise sqlstate '40001' using message = 'could not serialize'; end $$`,
      ),
    ])
    const idx = await t.open()
    const err = await idx.trigger().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((err as PostgresError).code).toBe("40001")
    expect(await rows()).toEqual([])
    expect(t.report.errors).toEqual([])
    expect(await count("events")).toBe(0)
  })

  it("a cancelled statement during the write is rethrown and not recorded", async () => {
    const chain = chainTo(S + 9n)
    chain.add(writerLog(FAKE, S + 3n))
    const calls: string[] = []
    const t = rig(chain, () => [
      afterWrite(
        plainWriter("tsunami", ["tsunami"], FAKE, calls),
        () => true,
        async (tx) => {
          const [me] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`
          // Cancel from another connection once the backend reports the sleep as running.
          const cancelled = (async () => {
            for (;;) {
              const [active] = await sql<{ pid: number }[]>`
                select pid from pg_stat_activity
                where pid = ${me!.pid} and state = 'active' and query like '%pg_sleep%'`
              if (active) break
              await new Promise((r) => setTimeout(r, 5))
            }
            await sql`select pg_cancel_backend(${me!.pid})`
          })()
          try {
            await tx`select pg_sleep(30)`
          } finally {
            await cancelled
          }
        },
      ),
    ])
    const idx = await t.open()
    const err = await idx.trigger().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((err as PostgresError).code).toBe("57014")
    expect(badDataError(err)).toBeNull()
    expect(calls).toEqual(["reload", "process", "reload"])
    expect(await rows()).toEqual([])
    expect(t.report.errors).toEqual([])
  })
})

describe("restarts and pauses", () => {
  it("a new Indexer after a skip treats the next refusal as a second skip, and the one after as a pause from the second skip", async () => {
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 12n })
    launch(chain, { n: 3, block: S + 22n })
    const t = rig(chain, pumpAndWriter([1, 2, 3]))
    await (await t.open()).trigger()

    chain.head = S + 29n
    const restarted = await t.open()
    await restarted.trigger()
    expect(await rows()).toMatchObject([
      { kind: "skip", from_block: S },
      { kind: "skip", from_block: S + 10n, to_block: S + 19n },
      { kind: "pause", from_block: S + 10n },
    ])
    expect(t.report.errors.map((e) => e.message)).toEqual([pauseText("inkypump", S + 10n)])
  })

  it("an Indexer started with a source paused leaves it out", async () => {
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    chain.add(writerLog(FAKE, S + 3n))
    const t = rig(chain, pumpAndWriter([]), { paused: ["inkypump"] })
    const idx = await t.open()
    await idx.trigger()
    expect(idx.paused()).toEqual(["inkypump"])
    expect(await tokens()).toEqual([])
    expect(await written()).toEqual(["tsunami:3"])
  })

  it("with every source paused the tick writes only the cursor and block hashes", async () => {
    const chain = chainTo(S + 19n)
    launch(chain, { n: 1, block: S + 2n })
    chain.add(writerLog(FAKE, S + 3n))
    const t = rig(chain, pumpAndWriter([]), { paused: ["inkypump", "tsunami"] })
    await (await t.open()).trigger()

    expect(await count("events")).toBe(0)
    expect(await tokens()).toEqual([])
    expect(await written()).toEqual([])
    expect(await store.getCursor()).toEqual({ block: S + 19n, hash: chain.hashOf(S + 19n) })
    expect((await store.recentBlocks()).map((b) => b.number)).toEqual([S + 19n])
    expect(chain.getLogsCalls).toEqual([])
    expect(await rows()).toEqual([])
  })
})
