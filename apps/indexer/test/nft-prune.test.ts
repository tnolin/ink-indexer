import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { nextPruneAt, pruneNft, startPrune } from "../src/sources/nft/prune"
import { createStore } from "../src/store"

const C = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const HEAD = 60_000_000n
const DAY_S = 86_400n
const DAY_MS = 86_400_000
const NOW = Date.parse("2026-10-19T03:30:00Z")
const MINT_CUT = HEAD - 8n * DAY_S
const SALE_CUT = HEAD - 90n * DAY_S

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

const setCursor = (block: bigint) =>
  createStore(sql).writeBatch([], [], {
    cursor: { block, hash: `0x${"11".repeat(32)}` },
    head: block,
  })

const tx = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`

async function seed() {
  for (const block of [MINT_CUT - 1n, MINT_CUT, HEAD]) {
    const base = {
      tx_hash: tx(block),
      log_index: 0,
      contract: C,
      qty: "1",
      block: block.toString(),
    }
    await sql`insert into indexer.nft_mints ${sql({ ...base, idx: 0, token_id: "1", recipient: C })}`
    await sql`insert into indexer.nft_burns ${sql({ ...base, idx: 0, token_id: "1", holder: C })}`
    await sql`insert into indexer.nft_seadrop_mints ${sql({ ...base, minter: C, payer: C, unit_price: "0", stage: 0 })}`
  }
  for (const block of [SALE_CUT - 1n, SALE_CUT, HEAD]) {
    await sql`insert into indexer.nft_sales ${sql({
      tx_hash: tx(block),
      log_index: 0,
      token_id: "1",
      contract: C,
      qty: "1",
      price_wei: "1",
      currency: "ETH",
      buyer: C,
      seller: C,
      order_hash: tx(block),
      block: block.toString(),
    })}`
  }
  for (const ageMs of [8 * DAY_MS + 1, 8 * DAY_MS - 1, 0])
    await sql`insert into indexer.nft_stats ${sql({ contract: C, at: new Date(NOW - ageMs) })}`
  for (const [id, expiresMs] of [
    ["1", NOW - 1],
    ["2", NOW],
    ["3", NOW + 1],
  ] as const)
    await sql`insert into indexer.nft_listing_state ${sql({
      contract: C,
      token_id: id,
      last_price_wei: "1",
      order_hash: tx(1n),
      expires_at: new Date(expiresMs),
    })}`
  for (const [id, ageMs] of [
    ["1", 7 * DAY_MS + 1],
    ["2", 7 * DAY_MS],
    ["3", 7 * DAY_MS - 1],
  ] as const)
    await sql`insert into indexer.nft_ranks ${sql({
      contract: C,
      token_id: id,
      rank: 1,
      max_rank: 10,
      fetched_at: new Date(NOW - ageMs),
    })}`
  await sql`insert into indexer.nft_items_seen ${sql({ contract: C, token_id: "1", seen_at: new Date(0) })}`
}

const column = async (table: string, col: string) =>
  (await sql.unsafe(`select ${col}::text as v from indexer.${table} order by ${col}`)).map(
    (r) => r.v as string,
  )

describe("NFT prune", () => {
  it("prune deletes only rows past each retention", async () => {
    await setCursor(HEAD)
    await seed()
    const deleted = await pruneNft(sql, new Date(NOW))
    const kept = [MINT_CUT, HEAD].map(String)
    expect(await column("nft_mints", "block")).toEqual(kept)
    expect(await column("nft_burns", "block")).toEqual(kept)
    expect(await column("nft_seadrop_mints", "block")).toEqual(kept)
    expect(await column("nft_sales", "block")).toEqual([SALE_CUT, HEAD].map(String))
    expect(await column("nft_stats", "extract(epoch from at)::bigint")).toEqual(
      [NOW - 8 * DAY_MS + 1, NOW].map((ms) => String(Math.round(ms / 1000))),
    )
    expect(await column("nft_listing_state", "token_id")).toEqual(["3"])
    expect(await column("nft_ranks", "token_id")).toEqual(["3"])
    // No retention: kept whatever its age.
    expect(await column("nft_items_seen", "token_id")).toEqual(["1"])
    expect(deleted).toEqual({
      nft_mints: 1,
      nft_burns: 1,
      nft_seadrop_mints: 1,
      nft_sales: 1,
      nft_stats: 1,
      nft_listing_state: 2,
      nft_ranks: 2,
    })
  })

  it("without a chain cursor, keeps the block-stamped rows and prunes the timed ones", async () => {
    await seed()
    const deleted = await pruneNft(sql, new Date(NOW))
    expect(await column("nft_mints", "block")).toHaveLength(3)
    expect(await column("nft_sales", "block")).toHaveLength(3)
    expect(deleted).toMatchObject({ nft_mints: 0, nft_sales: 0, nft_stats: 1, nft_ranks: 2 })
  })

  it("runs daily at 03:30 UTC", () => {
    const at = (iso: string) => nextPruneAt(Date.parse(iso))
    expect(at("2026-10-19T00:00:00Z")).toBe(Date.parse("2026-10-19T03:30:00Z"))
    expect(at("2026-10-19T03:29:59.999Z")).toBe(Date.parse("2026-10-19T03:30:00Z"))
    expect(at("2026-10-19T03:30:00Z")).toBe(Date.parse("2026-10-20T03:30:00Z"))
    expect(at("2026-10-19T23:59:00Z")).toBe(Date.parse("2026-10-20T03:30:00Z"))
  })

  it("startPrune logs each run, reports a failure and stops", async () => {
    await setCursor(HEAD)
    await seed()
    const logs: [string, string, unknown][] = []
    const reports: unknown[] = []
    let clock = NOW - 20
    const stop = startPrune({
      sql,
      log: (level, msg, fields) => logs.push([level, msg, fields]),
      report: (e) => reports.push(e),
      now: () => clock,
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(await column("nft_mints", "block")).toHaveLength(2)
    expect(logs).toContainEqual([
      "info",
      "nft prune done",
      expect.objectContaining({ nft_mints: 1 }),
    ])
    stop()
    clock = NOW + DAY_MS - 20
    await new Promise((r) => setTimeout(r, 100))
    expect(logs.filter(([, msg]) => msg === "nft prune done")).toHaveLength(1)
    expect(reports).toEqual([])
  })

  it("a failed prune is logged and reported once, and waits for the next day", async () => {
    const logs: [string, string][] = []
    const reports: unknown[] = []
    const broken = {
      unsafe() {},
    } as unknown as Sql
    // Any query on it throws: a tagged call on a plain object is not a function.
    const stop = startPrune({
      sql: broken,
      log: (level, msg) => logs.push([level, msg]),
      report: (e) => reports.push(e),
      now: () => NOW - 20,
    })
    await new Promise((r) => setTimeout(r, 100))
    stop()
    expect(logs).toEqual([["error", "nft prune failed"]])
    expect(reports).toHaveLength(1)
  })
})
