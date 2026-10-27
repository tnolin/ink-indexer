import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import { createAccounts } from "../src/sources/opensea/accounts"
import { errorBackoffMs } from "../src/sources/opensea/backoff"
import type { Budget } from "../src/sources/opensea/budget"
import { createDiscoveryJob, createMetadataJob } from "../src/sources/opensea/discovery"
import { createDropsJob } from "../src/sources/opensea/drops"
import { createOpenSeaRest } from "../src/sources/opensea/rest"
import type { Job } from "../src/sources/opensea/scheduler"
import { createSnapshots } from "../src/sources/opensea/snapshot"
import { createStats } from "../src/sources/opensea/stats"
import { createTraitsJob } from "../src/sources/opensea/traits"
import { createStore, type Store } from "../src/store"
import { fakeFetch } from "./opensea/fake-fetch"

const C = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const SLUG = "ink-hornet"
const KEY = "test-key-0123456789abcdef"
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.parse("2026-10-19T00:00:00Z")

let sql: Sql
let store: Store
let clock: number
let status: number

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  clock = T0
  status = 500
  await store.writeBatch([], [], {
    cursor: { block: 100n, hash: `0x${"11".repeat(32)}` },
    head: 100n,
  })
})
afterEach(() => sql.end())

const now = () => clock
const log: Logger = () => {}
const budget: Budget = { take: async () => true, block: async () => {} }

describe("errorBackoffMs", () => {
  it("is 5 minutes, 30 minutes, 2 hours, then a day", () => {
    expect([1, 2, 3, 4, 5, 20].map(errorBackoffMs)).toEqual([
      5 * MIN,
      30 * MIN,
      2 * HOUR,
      DAY,
      DAY,
      DAY,
    ])
  })
})

/** The failing route answers `status`, whatever the test sets it to. */
function jobs() {
  const answer = () => ({ status, body: {} })
  const fetch = fakeFetch({
    [`/chain/ink/contract/${C}`]: answer,
    [`/collections/${SLUG}`]: answer,
    [`/drops/${SLUG}`]: answer,
    [`/collections/${SLUG}/stats`]: answer,
    [`/chain/ink/contract/${C}/nfts/1`]: answer,
  })
  const rest = createOpenSeaRest({ key: KEY, budget, fetch, log, report: () => {}, now })
  const snapshots = createSnapshots({ sql, store, now })
  const accounts = createAccounts({ sql, rest, now })
  const deps = { sql, store, rest, snapshots, accounts, log, now }
  return {
    discovery: createDiscoveryJob(deps),
    metadata: createMetadataJob(deps),
    drops: createDropsJob(deps),
    traits: createTraitsJob(deps),
    stats: createStats({ sql, store, rest, log, now }).job,
  }
}

/** Each job, the column that says when it is next due, and a row that makes it due. */
const CASES = [
  ["discovery", "next_discovery_at", { slug: null, next_discovery_at: new Date(T0) }],
  ["metadata", "next_metadata_at", { slug: SLUG, next_metadata_at: new Date(T0) }],
  ["drops", "next_drops_at", { slug: SLUG, next_drops_at: new Date(T0) }],
  ["traits", "next_traits_at", { slug: SLUG, next_traits_at: new Date(T0) }],
  [
    "stats",
    "next_stats_at",
    { slug: SLUG, stats_tier: "hot", next_stats_at: new Date(T0), total_supply: 10 },
  ],
] as const

describe("a job that keeps failing backs off", () => {
  it.each(CASES)(
    "%s: 5 minutes, 30 minutes, 2 hours, then daily; a success starts over",
    async (name, column, row) => {
      const job: Job = jobs()[name]
      await sql`insert into indexer.nft_collections ${sql({ contract: C, standard: "erc721", next_discovery_at: null, ...row })}`
      await sql`insert into indexer.nft_mints (tx_hash, log_index, idx, contract, token_id, recipient, qty, block)
      values (${`0x${"01".repeat(32)}`}, 0, 0, ${C}, 1, ${`0x${"bb".repeat(20)}`}, 1, 1)`
      const nextAt = async () =>
        (
          await sql`select ${sql(column)} as at from indexer.nft_collections where contract = ${C}`
        )[0]!.at as Date

      for (const wait of [5 * MIN, 30 * MIN, 2 * HOUR, DAY, DAY]) {
        await job.run(C)
        expect((await nextAt()).getTime()).toBe(clock + wait)
        clock = (await nextAt()).getTime()
      }

      // An answer (here, a 404) ends the streak: the next failure waits five minutes again.
      status = 404
      await job.run(C)
      status = 500
      await sql`update indexer.nft_collections set ${sql({ [column]: new Date(clock) })} where contract = ${C}`
      await job.run(C)
      expect((await nextAt()).getTime()).toBe(clock + 5 * MIN)
    },
  )

  it("counts a collection's jobs apart", async () => {
    const j = jobs()
    await sql`insert into indexer.nft_collections ${sql({ contract: C, standard: "erc721", slug: SLUG, next_discovery_at: null, next_metadata_at: new Date(T0), next_drops_at: new Date(T0) })}`
    await j.metadata.run(C)
    await j.metadata.run(C)
    await j.drops.run(C)
    const rows = await sql`select job, failures from indexer.nft_job_failures order by job`
    expect(rows.map((r) => [r.job, r.failures])).toEqual([
      ["drops", 1],
      ["metadata", 2],
    ])
  })
})
