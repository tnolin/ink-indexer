import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { NftDropStage, NftMintEvent } from "@ink-indexer/events"
import { type ChainLog, decodeNftTransfers } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { loadNftFixture } from "../../../packages/sdk/test/fixtures"
import { Indexer } from "../src/loop"
import { nftSource } from "../src/sources/nft/index"
import { rollbackRows } from "../src/sources/nft/write"
import { createScheduler } from "../src/sources/opensea/scheduler"
import { createStageStartsJob } from "../src/sources/opensea/stage-starts"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const INKVERSE = "0xfffbd67f37e1e9fd9d9ebef9b687daa72a33da64" as Address
const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.parse("2026-10-19T00:00:00Z")
const sec = (ms: number) => ms / 1000

let sql: Sql
let store: Store
let clock: number
let reports: unknown[]

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  clock = T0
  reports = []
  // Off-chain events are stamped with the chain cursor, so it needs a block.
  await store.writeBatch([], [], {
    cursor: { block: 100n, hash: `0x${"11".repeat(32)}` },
    head: 100n,
  })
})
afterEach(() => sql.end())

const now = () => clock
const jobScheduler = () =>
  createScheduler([createStageStartsJob({ sql, store, now })], {
    sql,
    log: () => {},
    report: (e) => void reports.push(e),
    now,
  })

const stage = (over: Partial<NftDropStage>): NftDropStage => ({
  type: "public_sale",
  label: "Public",
  priceWei: "1000",
  startTime: sec(T0),
  endTime: null,
  maxPerWallet: 5,
  allowlistCount: null,
  ...over,
})

async function addDrop(
  contract: string,
  stages: NftDropStage[],
  maxSupply: string | null = "1000",
) {
  await sql`insert into indexer.nft_collections ${sql({ contract, standard: "erc721", slug: "x", next_discovery_at: null })}
    on conflict (contract) do nothing`
  await sql`insert into indexer.nft_drops (contract, slug, stages, max_supply, fetched_at)
    values (${contract}, 'x', ${sql.json(stages as never)}, ${maxSupply}, ${new Date(T0)})`
}

type Row = { tx_hash: string; sub: string; payload: NftMintEvent }
const startEvents = async () =>
  sql<Row[]>`
    select tx_hash, sub, payload from indexer.events where type = 'nft.mint' order by id`
const stageRows = async () =>
  (
    await sql<{ stage_index: number; first_block: string; first_ts: Date }[]>`
      select stage_index, first_block::text, first_ts from indexer.nft_stages order by stage_index`
  ).map((r) => [r.stage_index, r.first_block, r.first_ts.getTime()])

describe("scheduled stage starts", () => {
  it("scheduled stage start emits once at start time, and a later first mint of that stage emits nothing", async () => {
    const start = T0 + 2 * HOUR
    await addDrop(HORNET, [stage({ startTime: sec(start), label: "Public", priceWei: "5000" })])
    const s = jobScheduler()

    clock = start - 31_000
    await s.tick()
    expect(await startEvents()).toHaveLength(0)

    clock = start
    await s.tick()
    const events = await startEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      tx_hash: `nft:stage:${HORNET}:0`,
      sub: "mint:stage_start:0",
    })
    expect(events[0]?.payload).toEqual({
      v: 1,
      chainId: 57073,
      type: "nft.mint",
      contract: HORNET,
      source: "opensea",
      txHash: `nft:stage:${HORNET}:0`,
      logIndex: 0,
      blockNumber: "100",
      blockTimestamp: sec(start),
      kind: "stage_start",
      stageIndex: 0,
      stageLabel: "Public",
      stagePriceWei: "5000",
      markBps: null,
      minted: "0",
      maxSupply: "1000",
      mintStartTs: sec(start),
      stageStartTs: sec(start),
      minters: 0,
    })
    expect(await stageRows()).toEqual([[0, "0", start]])

    // Later ticks, even within the ten minutes, emit nothing more.
    clock = start + 30_000
    await s.tick()
    clock = start + 9 * MIN
    await s.tick()
    expect(await startEvents()).toHaveLength(1)
    expect(reports).toEqual([])
  })

  it("a stage already started more than 10 minutes ago at deploy emits nothing", async () => {
    await addDrop(HORNET, [stage({ startTime: sec(T0 - 11 * MIN) })])
    await jobScheduler().tick()
    expect(await startEvents()).toHaveLength(0)
    expect(await stageRows()).toEqual([])
    // Just inside the window it does.
    await sql`update indexer.nft_drops set stages = ${sql.json([stage({ startTime: sec(T0 - 9 * MIN) })] as never)}`
    clock += 30_000
    await jobScheduler().tick()
    expect(await startEvents()).toHaveLength(1)
  })

  it("signed stages get an index above 100 by position; the public stage is index 0", async () => {
    await addDrop(HORNET, [
      stage({
        type: "signed_presale",
        label: "Allowlist",
        startTime: sec(T0 + HOUR),
        endTime: sec(T0 + 2 * HOUR),
        allowlistCount: 40,
      }),
      stage({
        type: "signed_presale",
        label: "Friends",
        startTime: sec(T0 + 2 * HOUR),
        endTime: sec(T0 + 3 * HOUR),
      }),
      stage({ type: "public_sale", label: "Public", startTime: sec(T0 + 3 * HOUR) }),
    ])
    const s = jobScheduler()
    for (const at of [HOUR, 2 * HOUR, 3 * HOUR]) {
      clock = T0 + at
      await s.tick()
    }
    const events = await startEvents()
    expect(events.map((e) => [e.sub, e.payload.stageLabel, e.payload.stageStartTs])).toEqual([
      ["mint:stage_start:100", "Allowlist", sec(T0 + HOUR)],
      ["mint:stage_start:101", "Friends", sec(T0 + 2 * HOUR)],
      ["mint:stage_start:0", "Public", sec(T0 + 3 * HOUR)],
    ])
    // The whole drop started at its first stage.
    for (const e of events) expect(e.payload.mintStartTs).toBe(sec(T0 + HOUR))
    expect((await stageRows()).map((r) => r[0])).toEqual([0, 100, 101])
  })

  it("a stage that a first mint already announced is not announced again", async () => {
    await addDrop(HORNET, [stage({ startTime: sec(T0) })])
    // Index 0 was seen from a mint at the start of the window.
    await sql`insert into indexer.nft_stages values (${HORNET}, 0, 99, ${new Date(T0 + 1_000)})`
    await jobScheduler().tick()
    expect(await startEvents()).toHaveLength(0)

    // A signed stage whose window already holds a stage's first mint, under any index.
    await sql`truncate indexer.nft_stages, indexer.nft_drops`
    await addDrop(HORNET, [
      stage({ type: "signed_presale", startTime: sec(T0), endTime: sec(T0 + HOUR) }),
    ])
    await sql`insert into indexer.nft_stages values (${HORNET}, 3, 99, ${new Date(T0 + 5_000)})`
    clock = T0 + 10_000
    await jobScheduler().tick()
    expect(await startEvents()).toHaveLength(0)
  })

  it("reports the latest known supply, the minters and the cap", async () => {
    await addDrop(HORNET, [stage({ startTime: sec(T0) })], null)
    await sql`update indexer.nft_collections set max_supply = 2222 where contract = ${HORNET}`
    await sql`insert into indexer.nft_mints values
      ('0xa1', 0, 0, ${HORNET}, 1, '0x00000000000000000000000000000000000000a1', 2, 90),
      ('0xa2', 0, 0, ${HORNET}, 3, '0x00000000000000000000000000000000000000a1', 1, 90),
      ('0xa3', 0, 0, ${HORNET}, 4, '0x00000000000000000000000000000000000000a2', 1, 90)`
    await jobScheduler().tick()
    const [e] = await startEvents()
    expect(e?.payload).toMatchObject({ minted: "4", maxSupply: "2222", minters: 2 })
  })

  it("minted is the real count when an earlier stage minted without crossing a mark", async () => {
    // An allowlist stage started with 0 minted and has since minted 200 of 1,000: no mark crossed,
    // so the latest nft.mint event still says 0. The public stage then starts on schedule.
    const allow = T0
    const publicStart = T0 + HOUR
    await addDrop(HORNET, [
      stage({
        type: "signed_presale",
        label: "Allowlist",
        startTime: sec(allow),
        endTime: sec(publicStart),
      }),
      stage({ type: "public_sale", label: "Public", startTime: sec(publicStart) }),
    ])
    const s = jobScheduler()
    await s.tick()
    expect((await startEvents()).map((e) => e.payload.minted)).toEqual(["0"])
    const rows = Array.from({ length: 200 }, (_, i) => ({
      tx_hash: `0xb${i}`,
      log_index: 0,
      idx: 0,
      contract: HORNET,
      token_id: i,
      recipient: `0x${(i % 40).toString(16).padStart(40, "0")}`,
      qty: 1,
      block: 90,
    }))
    await sql`insert into indexer.nft_mints ${sql(rows)}`
    clock = publicStart
    await s.tick()
    const events = await startEvents()
    expect(events.map((e) => [e.sub, e.payload.minted])).toEqual([
      ["mint:stage_start:100", "0"],
      ["mint:stage_start:0", "200"],
    ])
    expect(events[1]?.payload.minters).toBe(40)
  })

  it("minted keeps the latest milestone's count when it is higher than the stored mints", async () => {
    await addDrop(HORNET, [stage({ startTime: sec(T0) })])
    await sql`insert into indexer.events (type, entity, payload, block, block_hash, tx_hash, log_index, confirmed, sub)
      values ('nft.mint', ${HORNET}, ${sql.json({ minted: "250" })}, 90, '0x01', '0xm1', 0, false, 'mint:progress:2500')`
    await jobScheduler().tick()
    const events = await startEvents()
    expect(events.at(-1)?.payload.minted).toBe("250")
  })

  it("a contract with no drop, or a drop with no stages, is left alone", async () => {
    await addDrop(HORNET, [])
    await jobScheduler().tick()
    expect(await startEvents()).toHaveLength(0)
  })
})

// ---- With the chain source ----

const blocksOf = (logs: ChainLog[]) =>
  [...new Set(logs.map((l) => l.blockNumber))].sort((a, b) => (a < b ? -1 : 1))
const firstBlock = (logs: ChainLog[]) =>
  logs.reduce((m, l) => (l.blockNumber < m ? l.blockNumber : m), logs[0]!.blockNumber)
const lastBlock = (logs: ChainLog[]) =>
  logs.reduce((m, l) => (l.blockNumber > m ? l.blockNumber : m), 0n)
const mintsIn = (l: ChainLog) =>
  decodeNftTransfers(l)
    .filter((t) => t.kind === "mint")
    .reduce((n, t) => n + t.qty, 0n)

function compactInkverse(): ChainLog[] {
  const all = loadNftFixture("inkverse-mints")
  const rank = new Map(blocksOf(all).map((b, i) => [b, firstBlock(all) + BigInt(i)]))
  return all.map((l) => ({ ...l, blockNumber: rank.get(l.blockNumber)! }))
}

describe("scheduled stage starts and the first mint of a stage", () => {
  async function ingestWithSchedule(
    runJobAt: (first: number) => number[],
    drop: (first: number) => NftDropStage[],
  ) {
    const logs = compactInkverse()
    const first = Number(firstBlock(logs.filter((l) => mintsIn(l) > 0n)))
    const chain = new FakeChain(lastBlock(logs) + 5n)
    for (const l of logs) chain.add(l)
    chain.mintStats.set(INKVERSE, (block) => {
      let totalSupply = 0n
      for (const l of chain.logs)
        if (l.blockNumber <= block)
          for (const t of decodeNftTransfers(l))
            if (t.kind === "mint" && t.contract === INKVERSE) totalSupply += t.qty
      return { totalSupply, maxSupply: 1_000n }
    })
    const idx = new Indexer({
      chain,
      store,
      logger: () => {},
      sources: [nftSource({ sql, chain, logger: () => {} })],
    })
    await idx.init()
    await store.writeBatch([], [], {
      cursor: { block: firstBlock(logs) - 1n, hash: chain.hashOf(firstBlock(logs) - 1n) },
      head: chain.head,
    })
    await addDrop(INKVERSE, drop(first), "1000")
    const s = jobScheduler()
    for (const at of runJobAt(first)) {
      clock = at * 1000
      await s.tick()
    }
    await idx.trigger()
    return { first }
  }

  it("a signed stage announced on schedule is not announced again by its first mint", async () => {
    // Stage 1's first mint is at `first`, inside "Early". "Open" holds stages 2 and 3.
    const { first } = await ingestWithSchedule(
      (first) => [first - 100],
      (first) => [
        stage({
          type: "signed_presale",
          label: "Early",
          startTime: first - 100,
          endTime: first + 1,
        }),
        stage({ type: "public_sale", label: "Open", startTime: first + 1, endTime: null }),
      ],
    )
    const events = await startEvents()
    const starts = events.filter((e) => e.payload.kind === "stage_start")
    expect(starts.map((e) => [e.payload.source, e.sub, e.payload.stageLabel])).toEqual([
      ["opensea", "mint:stage_start:100", "Early"],
      ["chain", "mint:stage_start:2", "Open"],
      ["chain", "mint:stage_start:3", "Open"],
    ])
    expect(starts[0]?.payload.stageStartTs).toBe(first - 100)
    // The real index is stored too, so it is known from now on.
    expect((await stageRows()).map((r) => r[0])).toEqual([1, 2, 3, 100])
  })

  it("only the stage whose window holds the first mint is suppressed", async () => {
    // "Open" (stages 2 and 3) is announced on schedule; "Early" began 20 minutes earlier, before
    // this indexer looked, so stage 1 is announced by its first mint.
    await ingestWithSchedule(
      (first) => [first + 1],
      (first) => [
        stage({
          type: "signed_presale",
          label: "Early",
          startTime: first - 20 * 60,
          endTime: first + 1,
        }),
        stage({ type: "public_sale", label: "Open", startTime: first + 1, endTime: null }),
      ],
    )
    const starts = (await startEvents()).filter((e) => e.payload.kind === "stage_start")
    expect(starts.map((e) => [e.payload.source, e.sub, e.payload.stageLabel])).toEqual([
      ["opensea", "mint:stage_start:0", "Open"],
      ["chain", "mint:stage_start:1", "Early"],
    ])
  })

  it("with no schedule the first mint announces the stage as before", async () => {
    await ingestWithSchedule(
      () => [],
      () => [],
    )
    const starts = (await startEvents()).filter((e) => e.payload.kind === "stage_start")
    expect(starts.map((e) => e.sub)).toEqual([
      "mint:stage_start:1",
      "mint:stage_start:2",
      "mint:stage_start:3",
    ])
  })

  it("rolling the chain back does not announce a scheduled stage a second time", async () => {
    await addDrop(HORNET, [stage({ startTime: sec(T0) })])
    await jobScheduler().tick()
    await store.rollback(99n, `0x${"11".repeat(32)}`, [(tx) => rollbackRows(tx, 99n)])
    expect(await stageRows()).toEqual([[0, "0", T0]])
    clock += 30_000
    await jobScheduler().tick()
    expect(await startEvents()).toHaveLength(1)
  })
})
