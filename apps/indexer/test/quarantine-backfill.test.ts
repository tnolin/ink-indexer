import { connect, type Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { INKYPUMP_START_BLOCK as S } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { Indexer } from "../src/loop"
import { openLivePauses, startPauses } from "../src/quarantine"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import type { Source, SourceBatch, SourceName } from "../src/sources/source"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import {
  afterWrite,
  createFakeWrites,
  plainWriter,
  recordingLogger,
  recordingReporter,
  refusing,
  writerLog,
} from "./quarantine-harness"
import { launch, tokenOf, trade } from "./scenario"

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
    b.events.some(
      ({ event }) =>
        event.type === "launchpad.launch" && ns.some((n) => event.token === tokenOf(n)),
    )

/** A chain whose reads return at most ten blocks, so a range is several spans. */
function chainTo(head: bigint) {
  const chain = new FakeChain(head)
  chain.maxSpan = 10n
  return chain
}

/** The InkyPump source refusing the launches of `ns`, and a plain writer beside it. */
const pumpAndWriter = (ns: number[]) => (pump: Source) => [
  refusing(pump, launchesOf(...ns), "numeric"),
  plainWriter("tsunami", ["tsunami"], FAKE),
]

function rig(
  chain: FakeChain,
  build: (pump: Source) => Source[],
  opts: { paused?: SourceName[]; store?: Store; sleep?: (ms: number) => Promise<void> } = {},
) {
  const logs = recordingLogger()
  const report = recordingReporter()
  const pump = inkypumpSource({ sql, chain, logger: () => {}, pools: new PoolRegistry() })
  const sources = build(pump)
  const open = async () => {
    const idx = new Indexer({
      chain,
      store: opts.store ?? store,
      logger: logs.logger,
      report,
      sources,
      paused: opts.paused,
      sleep: opts.sleep,
    })
    await idx.init()
    return idx
  }
  return { open, logs, report, sources }
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
      replay_sources: string
      cleared_at: Date | null
    }[]
  >`select source, kind, mode, from_block, to_block, sqlstate, replay_sources, cleared_at
    from indexer.quarantine order by id`
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

const skipText = (source: string, from: bigint, to: bigint) =>
  `backfill: ${source} skipped blocks ${from} to ${to}`
const leftOutText = (source: string, from: bigint, to: bigint) =>
  `backfill: ${source} left out from block ${from} to ${to}`

describe("a backfill's quarantine", () => {
  it("a backfill skip leaves the source out of one span, the others reach --to, the row has mode backfill", async () => {
    const chain = chainTo(S + 29n)
    launch(chain, { n: 1, block: S + 2n })
    chain.add(writerLog(FAKE, S + 3n))
    launch(chain, { n: 2, block: S + 12n })
    chain.add(writerLog(FAKE, S + 13n))
    launch(chain, { n: 3, block: S + 22n })
    chain.add(writerLog(FAKE, S + 23n))
    const t = rig(chain, pumpAndWriter([1]))
    const idx = await t.open()
    await idx.backfill(S, S + 29n)

    expect(await tokens()).toEqual([tokenOf(2), tokenOf(3)].sort())
    expect(await written()).toEqual(["tsunami:3", "tsunami:13", "tsunami:23"])
    expect(await rows()).toMatchObject([
      {
        source: "inkypump",
        kind: "skip",
        mode: "backfill",
        from_block: S,
        to_block: S + 9n,
        sqlstate: "22003",
        replay_sources: "inkypump",
        cleared_at: null,
      },
    ])
    expect(t.report.warns.map((w) => w.message)).toEqual([skipText("inkypump", S, S + 9n)])
    expect(t.report.errors).toEqual([])
    expect(t.logs.at("error").map((l) => l.msg)).toEqual([skipText("inkypump", S, S + 9n)])
    expect(await store.getCursor()).toBeNull()
    expect(idx.paused()).toEqual([])
  })

  it("a backfill pause drops the source to --to, the others reach --to, and the row's to_block is --to", async () => {
    const chain = chainTo(S + 39n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 12n })
    launch(chain, { n: 3, block: S + 22n })
    chain.add(writerLog(FAKE, S + 13n))
    chain.add(writerLog(FAKE, S + 33n))
    const t = rig(chain, pumpAndWriter([1, 2]))
    const idx = await t.open()
    await idx.backfill(S, S + 39n)

    expect(await tokens()).toEqual([])
    expect(await written()).toEqual(["tsunami:13", "tsunami:33"])
    expect(await rows()).toMatchObject([
      { kind: "skip", mode: "backfill", from_block: S, to_block: S + 9n },
      {
        kind: "pause",
        mode: "backfill",
        from_block: S,
        to_block: S + 39n,
        replay_sources: "inkypump,v4-swaps",
      },
    ])
    expect(t.report.errors.map((e) => e.message)).toEqual([leftOutText("inkypump", S, S + 39n)])
    expect(t.logs.at("error").map((l) => l.msg)).toEqual([
      skipText("inkypump", S, S + 9n),
      leftOutText("inkypump", S, S + 39n),
    ])
    expect(idx.paused()).toEqual([])
  })

  it("a missing record in a backfill leaves the source out to --to from the skipped span", async () => {
    const chain = chainTo(S + 29n)
    launch(chain, { n: 1, block: S + 2n })
    trade(chain, { n: 1, block: S + 22n, sold: 1n })
    chain.add(writerLog(FAKE, S + 24n))
    const t = rig(chain, pumpAndWriter([1]))
    await (await t.open()).backfill(S, S + 29n)

    expect(await rows()).toMatchObject([
      { kind: "skip", mode: "backfill", from_block: S, to_block: S + 9n },
      { kind: "pause", mode: "backfill", from_block: S, to_block: S + 29n, sqlstate: "dependency" },
    ])
    expect(await written()).toEqual(["tsunami:24"])
  })

  it("a backfill's rows never pause a later start", async () => {
    const chain = chainTo(S + 39n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 12n })
    const t = rig(chain, pumpAndWriter([1, 2]))
    await (await t.open()).backfill(S, S + 39n)
    expect(await rows()).toHaveLength(2)

    expect(await openLivePauses(sql)).toEqual([])
    const paused = await startPauses(sql, () => {})
    expect(paused).toEqual([])
    const live = rig(chain, pumpAndWriter([]), { paused })
    chain.add(writerLog(FAKE, S + 3n))
    await (await live.open()).trigger()
    expect(await tokens()).toEqual([tokenOf(1), tokenOf(2)].sort())
  })

  it("a backfill write waiting on an unconfirmed live row records and reports nothing", async () => {
    const chain = new FakeChain(S + 99n)
    launch(chain, { n: 1, block: S + 10n })
    for (let b = 11n; b <= 140n; b++) trade(chain, { n: 1, block: S + b, sold: b })
    const report = recordingReporter()
    const logs = recordingLogger()
    const seed = new Indexer({
      chain,
      store: createStore(sql),
      logger: () => {},
      sources: [inkypumpSource({ sql, chain, pools: new PoolRegistry(), logger: () => {} })],
    })
    await seed.init()
    await seed.backfill(S, S + 12n)
    await store.writeBatch([], [], {
      cursor: { block: S + 99n, hash: chain.hashOf(S + 99n) },
      head: S + 99n,
    })
    const live = new Indexer({
      chain,
      store: createStore(sql),
      logger: () => {},
      sources: [inkypumpSource({ sql, chain, pools: new PoolRegistry(), logger: () => {} })],
    })
    await live.init()
    chain.head = S + 100n
    await live.trigger()

    const waits: number[] = []
    const backfiller = new Indexer({
      chain,
      store: createStore(sql),
      logger: logs.logger,
      report,
      sources: [inkypumpSource({ sql, chain, pools: new PoolRegistry(), logger: () => {} })],
      sleep: async (ms) => {
        waits.push(ms)
        if (waits.length === 2) chain.head += 1n
      },
    })
    await backfiller.init()
    await backfiller.backfill(S + 40n, S + 60n)

    expect(waits).toEqual([1_000, 1_000])
    expect(await rows()).toEqual([])
    expect(report.warns).toEqual([])
    expect(report.errors).toEqual([])
    expect(logs.at("error")).toEqual([])
  })

  it("a backfill runs a source that has an open live pause", async () => {
    const chain = chainTo(S + 9n)
    launch(chain, { n: 1, block: S + 2n })
    chain.add(writerLog(FAKE, S + 3n))
    await sql`
      insert into indexer.quarantine (source, kind, mode, from_block, replay_sources, sqlstate, message)
      values ('inkypump', 'pause', 'live', ${S.toString()}, 'inkypump,v4-swaps', '22003', 'refused')`
    const t = rig(chain, pumpAndWriter([]), { paused: ["inkypump"] })
    const idx = await t.open()
    await idx.backfill(S, S + 9n)

    expect(await tokens()).toEqual([tokenOf(1)])
    expect(await written()).toEqual(["tsunami:3"])
    expect(idx.paused()).toEqual(["inkypump"])
    expect(await rows()).toHaveLength(1)
  })

  it("a backfill's pause is its own: the same Indexer's live pauses stay as they were", async () => {
    const chain = chainTo(S + 39n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 12n })
    const t = rig(chain, pumpAndWriter([1, 2]))
    const idx = await t.open()
    await idx.backfill(S, S + 39n)
    expect(idx.paused()).toEqual([])
    expect(idx.isPaused("inkypump")).toBe(false)
  })

  it("the report names the resume command with --from, --to and --sources", async () => {
    const chain = chainTo(S + 19n)
    launch(chain, { n: 1, block: S + 2n })
    launch(chain, { n: 2, block: S + 12n })
    const t = rig(chain, pumpAndWriter([1, 2]))
    await (await t.open()).backfill(S, S + 19n)

    expect(t.report.warns[0]?.context).toMatchObject({
      source: "inkypump",
      kind: "skip",
      mode: "backfill",
      fromBlock: S,
      toBlock: S + 9n,
      replay: [`resume with pnpm backfill --from ${S} --to ${S + 9n} --sources inkypump`],
    })
    expect(t.report.errors[0]?.context).toMatchObject({
      kind: "pause",
      mode: "backfill",
      fromBlock: S,
      toBlock: S + 19n,
      replay: [`resume with pnpm backfill --from ${S} --to ${S + 19n} --sources inkypump,v4-swaps`],
    })
  })

  it("every source reloads its all-time highs as of the block before the span it re-runs", async () => {
    const chain = chainTo(S + 29n)
    launch(chain, { n: 1, block: S + 12n })
    chain.add(writerLog(FAKE, S + 13n))
    const seen: (bigint | undefined)[] = []
    const t = rig(chain, (pump) => [
      refusing(pump, launchesOf(1), "numeric"),
      {
        ...plainWriter("tsunami", ["tsunami"], FAKE),
        async reload(opts) {
          seen.push(opts?.athAsOf)
        },
      },
    ])
    await (await t.open()).backfill(S, S + 29n)

    expect(seen).toEqual([undefined, S - 1n, S + 9n])
    expect(await rows()).toMatchObject([{ kind: "skip", from_block: S + 10n, to_block: S + 19n }])
  })

  it("a failure another try may clear is rethrown from a backfill and not recorded", async () => {
    const own = connect(inject("databaseUrl"))
    try {
      const chain = chainTo(S + 9n)
      chain.add(writerLog(FAKE, S + 3n))
      const t = rig(
        chain,
        () => [
          afterWrite(
            plainWriter("tsunami", ["tsunami"], FAKE),
            () => true,
            (tx) =>
              tx`do $$ begin raise sqlstate '40001' using message = 'could not serialize'; end $$`,
          ),
        ],
        { store: createStore(own) },
      )
      const idx = await t.open()
      await expect(idx.backfill(S, S + 9n)).rejects.toMatchObject({ code: "40001" })
      expect(await rows()).toEqual([])
      expect(t.report.errors).toEqual([])
      expect(t.report.warns).toEqual([])
    } finally {
      await own.end({ timeout: 0 })
    }
  })
})
