import type { Sql } from "@ink-indexer/db"
import { connect, PostgresError } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { IndexerEvent } from "@ink-indexer/events"
import { pad, toHex } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import {
  badDataError,
  clearLivePause,
  cutMessage,
  openLivePauses,
  type QuarantineRow,
  replaySources,
  replaySteps,
  subtractPaused,
} from "../src/quarantine"
import type { BackfillSource, EventRow, SourceBatch } from "../src/sources/source"
import { createStore, type Store } from "../src/store"

let sql: Sql
let store: Store

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

/** What a statement throws, or undefined when it succeeds. */
async function thrown(run: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (err) {
    return err
  }
  return undefined
}

const HASH = (n: number) => pad(toHex(n), { size: 32 })

/** An event row shaped like a launchpad trade; `note` lands in the jsonb payload. */
function eventRow(n: number, note = "ok"): EventRow {
  const event = {
    type: "launchpad.trade",
    token: "0x00000000000000000000000000000000000000aa",
    txHash: HASH(n),
    logIndex: n,
    note,
  } as unknown as IndexerEvent
  return { event, block: 1_000n + BigInt(n), blockHash: HASH(9_000 + n) }
}
const batchOf = (...events: EventRow[]): SourceBatch => ({ events, blocks: [] })
const eventCount = async () =>
  Number((await sql<{ n: string }[]>`select count(*) as n from indexer.events`)[0]?.n)

const row = (over: Partial<QuarantineRow> = {}): QuarantineRow => ({
  source: "inkypump",
  kind: "skip",
  mode: "live",
  fromBlock: 100n,
  toBlock: 110n,
  replaySources: ["inkypump"],
  sqlstate: "22003",
  message: "numeric field overflow",
  ...over,
})

describe("badDataError", () => {
  it("a numeric(78,0) overflow from Postgres is bad data with code 22003", async () => {
    const big = `1${"0".repeat(78)}`
    const err = await thrown(() => sql`select ${big}::numeric(78,0)`)
    expect(err).toBeInstanceOf(PostgresError)
    expect(badDataError(err)?.code).toBe("22003")
  })

  it("a NUL in a jsonb payload from Postgres is bad data with code 22P05", async () => {
    const err = await thrown(() =>
      sql.begin(async (tx) => {
        await tx`create temp table payloads (p jsonb) on commit drop`
        await tx`insert into payloads values (${tx.json({ a: "x\u0000y" })})`
      }),
    )
    expect(badDataError(err)?.code).toBe("22P05")
  })

  it("a unique violation from Postgres is bad data with code 23505", async () => {
    const err = await thrown(() =>
      sql.begin(async (tx) => {
        await tx`create temp table keys (k int primary key) on commit drop`
        await tx`insert into keys values (1)`
        await tx`insert into keys values (1)`
      }),
    )
    expect(badDataError(err)?.code).toBe("23505")
  })

  it("a lock timeout from Postgres (55P03) is not bad data", async () => {
    const key = 570_730_777
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    let locked: () => void = () => {}
    const holding = new Promise<void>((r) => {
      locked = r
    })
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${key}::bigint)`
      locked()
      await held
    })
    await holding
    const err = await thrown(() =>
      sql.begin(async (tx) => {
        await tx`set local lock_timeout = '50ms'`
        await tx`select pg_advisory_xact_lock(${key}::bigint)`
      }),
    )
    release()
    await holder
    expect(err).toBeInstanceOf(PostgresError)
    expect((err as PostgresError).code).toBe("55P03")
    expect(badDataError(err)).toBeNull()
  })

  it("raise sqlstate '40001' is not bad data", async () => {
    const err = await thrown(
      () => sql`do $$ begin raise sqlstate '40001' using message = 'could not serialize'; end $$`,
    )
    expect((err as PostgresError).code).toBe("40001")
    expect(badDataError(err)).toBeNull()
  })

  it("a backend ended with pg_terminate_backend is not bad data", async () => {
    const own = connect(inject("databaseUrl"))
    const err = await thrown(() => own`select pg_terminate_backend(pg_backend_pid())`)
    await own.end({ timeout: 0 })
    expect(err).toBeDefined()
    expect(badDataError(err)).toBeNull()
  })

  it("a connection refusal (ECONNREFUSED, not a PostgresError) is not bad data", async () => {
    const dead = connect("postgres://nobody@127.0.0.1:1/none")
    const err = await thrown(() => dead`select 1`)
    await dead.end({ timeout: 0 })
    expect((err as { code?: string }).code).toBe("ECONNREFUSED")
    expect(err).not.toBeInstanceOf(PostgresError)
    expect(badDataError(err)).toBeNull()
  })

  it("a plain Error with code '22003' is not bad data", () => {
    expect(badDataError(Object.assign(new Error("x"), { code: "22003" }))).toBeNull()
  })
})

describe("cutMessage", () => {
  it("cutMessage keeps 500 code points of a 10,000-character message, drops NULs and replaces a lone surrogate", () => {
    const msg = `a\u0000b\uD800c${"x".repeat(10_000)}`
    const out = cutMessage(msg)
    expect([...out]).toHaveLength(500)
    expect(out.startsWith("ab�cxxx")).toBe(true)
    expect(out).not.toContain("\u0000")
    expect(out).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    )
  })

  it("counts an astral character as one code point", () => {
    expect([...cutMessage("😀".repeat(600))]).toHaveLength(500)
  })
})

describe("recordQuarantine", () => {
  it("recordQuarantine stores a message with a NUL and a lone surrogate", async () => {
    const from = await store.recordQuarantine(
      row({ message: `bad\u0000 value \uDC00 ${"y".repeat(10_000)}` }),
    )
    const [r] = await sql<{ message: string; replay_sources: string }[]>`
      select message, replay_sources from indexer.quarantine order by id desc limit 1`
    expect(r?.message.startsWith("bad value � yyy")).toBe(true)
    expect([...(r?.message ?? "")]).toHaveLength(500)
    expect(from).toBe(100n)
    expect(r?.replay_sources).toBe("inkypump")
  })

  it("dependency pause from: the earliest live skip after the last cleared pause; a skip before that clear is ignored; none gives the fallback", async () => {
    const at = (ago: string) => sql`now() - ${ago}::interval`
    const insert = (
      source: string,
      kind: string,
      mode: string,
      from: number,
      ago: string,
      clearedAgo: string | null,
    ) => sql`
      insert into indexer.quarantine
        (source, kind, mode, from_block, to_block, replay_sources, sqlstate, message, created_at, cleared_at)
      values (${source}, ${kind}, ${mode}, ${from},
        ${kind === "pause" && mode === "live" ? null : from + 5}, ${source}, 'x', 'm',
        ${at(ago)}, ${clearedAgo ? at(clearedAgo) : null})`
    const pause = row({ kind: "pause", toBlock: null, fromBlock: 9_999n, sqlstate: "dependency" })

    // No skip on record: the row's own block stays.
    expect(await store.recordQuarantine(pause, { fromEarliestSkip: true })).toBe(9_999n)
    await sql`delete from indexer.quarantine`

    await insert("inkypump", "skip", "live", 100, "5 hours", null) // before the clear below
    await insert("inkypump", "pause", "live", 100, "4 hours", "3 hours")
    await insert("inkypump", "skip", "live", 700, "2 hours", null)
    await insert("inkypump", "skip", "live", 500, "1 hour", null) // earliest block after the clear
    await insert("inkypump", "skip", "backfill", 50, "1 hour", null)
    await insert("inkfun", "skip", "live", 40, "1 hour", null)

    expect(await store.recordQuarantine(pause, { fromEarliestSkip: true })).toBe(500n)
    const [stored] = await sql<{ from_block: bigint }[]>`
      select from_block from indexer.quarantine
      where source = 'inkypump' and kind = 'pause' and cleared_at is null`
    expect(stored?.from_block).toBe(500n)
  })
})

describe("replaySources", () => {
  it("replaySources: inkypump skip is inkypump, inkypump pause is inkypump,v4-swaps, nft pause is nft-mints,nft-sales,nft-launches, v4 pause is v4-swaps", () => {
    expect(replaySources("inkypump", "skip")).toEqual(["inkypump"])
    expect(replaySources("inkypump", "pause")).toEqual(["inkypump", "v4-swaps"])
    expect(replaySources("nft", "pause")).toEqual(["nft-mints", "nft-sales", "nft-launches"])
    expect(replaySources("v4", "pause")).toEqual(["v4-swaps"])
  })

  it("a skip of a source that replays to the cursor stores the pause value", () => {
    expect(replaySources("inkfun", "skip")).toEqual(["inkfun", "v4-swaps"])
    expect(replaySources("tsunami", "skip")).toEqual(["tsunami", "v4-swaps"])
    expect(replaySources("hookit", "skip")).toEqual(["hookit", "v4-swaps"])
    expect(replaySources("nftx", "skip")).toEqual(["nftx"])
    expect(replaySources("nftx", "pause")).toEqual(["nftx"])
  })
})

describe("replaySteps", () => {
  it("replaySteps for a live pause of inkfun gives the three steps with --sources inkfun,v4-swaps", () => {
    const r = row({
      source: "inkfun",
      kind: "pause",
      toBlock: null,
      replaySources: ["inkfun", "v4-swaps"],
    })
    expect(replaySteps(r)).toEqual([
      "deploy the fixed release; inkfun stays paused through the restart",
      "beside start: pnpm backfill --from 100 --to <a block at or below the live cursor> --sources inkfun,v4-swaps",
      "stop start, then pnpm backfill --from <that --to + 1> --to <the cursor block> --sources inkfun,v4-swaps, then pnpm quarantine clear inkfun, then start again",
    ])
  })

  it("replaySteps for a skip of inkypump adds the v4-swaps command to the live cursor; for nft it does not", () => {
    expect(replaySteps(row())).toEqual([
      "beside start: pnpm backfill --from 100 --to 110 --sources inkypump",
      "beside start: pnpm backfill --from 100 --to <a block at or below the live cursor> --sources v4-swaps",
    ])
    const nft: BackfillSource[] = ["nft-mints", "nft-sales", "nft-launches"]
    expect(replaySteps(row({ source: "nft", replaySources: nft }))).toEqual([
      "beside start: pnpm backfill --from 100 --to 110 --sources nft-mints,nft-sales,nft-launches",
    ])
  })

  it("replaySteps for a skip of tsunami runs tsunami,v4-swaps to the live cursor and ends with stop, tail and start, with no quarantine clear", () => {
    const steps = replaySteps(row({ source: "tsunami", replaySources: ["tsunami", "v4-swaps"] }))
    expect(steps).toEqual([
      "beside start: pnpm backfill --from 100 --to <a block at or below the live cursor> --sources tsunami,v4-swaps",
      "stop start, then pnpm backfill --from <that --to + 1> --to <the cursor block> --sources tsunami,v4-swaps, then start again",
    ])
    expect(steps.join(" ")).not.toContain("quarantine clear")
  })

  it("replaySteps for a skip of nftx runs nftx to the live cursor with the final stop", () => {
    expect(replaySteps(row({ source: "nftx", replaySources: ["nftx"] }))).toEqual([
      "beside start: pnpm backfill --from 100 --to <a block at or below the live cursor> --sources nftx",
      "stop start, then pnpm backfill --from <that --to + 1> --to <the cursor block> --sources nftx, then start again",
    ])
  })

  it("a backfill row resumes with the run's own range", () => {
    expect(replaySteps(row({ mode: "backfill", source: "inkfun" }))).toEqual([
      "resume with pnpm backfill --from 100 --to 110 --sources inkypump",
    ])
  })
})

describe("subtractPaused", () => {
  const platforms: BackfillSource[] = ["inkypump", "inkfun", "v4-swaps"]

  it("subtractPaused of inkypump from the inkypump, inkfun platforms keeps v4-swaps", () => {
    expect(subtractPaused(platforms, ["inkypump"])).toEqual(["inkfun", "v4-swaps"])
  })

  it("subtractPaused of v4 from the same removes v4-swaps and keeps inkypump and inkfun", () => {
    expect(subtractPaused(platforms, ["v4"])).toEqual(["inkypump", "inkfun"])
  })
})

describe("live pauses", () => {
  const pause = (source: QuarantineRow["source"], from: bigint) =>
    store.recordQuarantine(
      row({ source, kind: "pause", toBlock: null, fromBlock: from, sqlstate: "dependency" }),
    )

  it("clearLivePause clears only the source's open live pause, not its skips, its backfill rows or another source's pause", async () => {
    await pause("inkypump", 100n)
    await pause("inkfun", 200n)
    await store.recordQuarantine(row())
    await store.recordQuarantine(row({ mode: "backfill" }))
    await store.recordQuarantine(row({ mode: "backfill", kind: "pause", toBlock: 500n }))

    const cleared = await clearLivePause(sql, "inkypump")
    expect(cleared?.fromBlock).toBe(100n)
    expect(cleared?.createdAt).toBeInstanceOf(Date)

    const open = await sql<{ source: string; kind: string; mode: string }[]>`
      select source, kind, mode from indexer.quarantine where cleared_at is null order by id`
    expect(open).toEqual([
      { source: "inkfun", kind: "pause", mode: "live" },
      { source: "inkypump", kind: "skip", mode: "live" },
      { source: "inkypump", kind: "skip", mode: "backfill" },
      { source: "inkypump", kind: "pause", mode: "backfill" },
    ])
    expect(await openLivePauses(sql)).toEqual([{ source: "inkfun", fromBlock: 200n }])
  })

  it("clearLivePause with no open pause returns null", async () => {
    expect(await clearLivePause(sql, "nft")).toBeNull()
    await pause("nft", 5n)
    await clearLivePause(sql, "nft")
    expect(await clearLivePause(sql, "nft")).toBeNull()
  })
})

describe("probeEvents", () => {
  it("probeEvents names the source whose event carries a NUL, and count(indexer.events) is unchanged afterwards", async () => {
    const before = await eventCount()
    const result = await store.probeEvents([
      batchOf(eventRow(1)),
      batchOf(eventRow(2, "x\u0000y")),
      batchOf(eventRow(3)),
    ])
    expect(result).not.toBeNull()
    expect(result).not.toBe("other")
    const pinned = result as { index: number; error: PostgresError }
    expect(pinned.index).toBe(1)
    expect(pinned.error.code).toBe("22P05")
    expect(await eventCount()).toBe(before)
  })

  it("probeEvents returns null when every batch inserts alone", async () => {
    expect(await store.probeEvents([batchOf(eventRow(1)), batchOf(eventRow(2))])).toBeNull()
    expect(await eventCount()).toBe(0)
  })

  it("probeEvents returns 'other' when a probe fails with anything but class 22 or 23", async () => {
    await sql`
      create function indexer.refuse_events() returns trigger language plpgsql as
      $$ begin raise sqlstate '40001' using message = 'could not serialize'; end $$`
    await sql`create trigger refuse_events before insert on indexer.events
      for each row execute function indexer.refuse_events()`
    expect(await store.probeEvents([batchOf(eventRow(1))])).toBe("other")
  })
})
