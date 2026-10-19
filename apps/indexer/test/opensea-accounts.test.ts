import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { NftCollectionEvent } from "@ink-indexer/events"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import { createAccounts } from "../src/sources/opensea/accounts"
import type { Budget } from "../src/sources/opensea/budget"
import { createDiscoveryJob, createMetadataJob } from "../src/sources/opensea/discovery"
import { createOpenSeaRest } from "../src/sources/opensea/rest"
import { createScheduler } from "../src/sources/opensea/scheduler"
import { createSnapshots } from "../src/sources/opensea/snapshot"
import { createStore } from "../src/store"
import { type FakeResponse, fakeFetch, recorded } from "./opensea/fake-fetch"

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const OWNER = "0x7a24f0206ed3493fa89ffb8a6e937e1f6378cbb2"
const CREATOR = "0x00000000000000000000000000000000000000cc"
const KEY = "test-key-0123456789abcdef"
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const T0 = Date.parse("2026-10-19T00:00:00Z")

let sql: Sql
let clock: number
let reports: unknown[]

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  clock = T0
  reports = []
  await createStore(sql).writeBatch([], [], {
    cursor: { block: 100n, hash: `0x${"11".repeat(32)}` },
    head: 100n,
  })
})
afterEach(() => sql.end())

const now = () => clock
const log: Logger = () => {}
const report = (e: unknown) => void reports.push(e)
const budget: Budget = { take: async () => true, block: async () => {} }

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const fetch = fakeFetch(routes)
  const rest = createOpenSeaRest({ key: KEY, budget, fetch, log, report, now })
  const store = createStore(sql)
  const snapshots = createSnapshots({ sql, store, now })
  const accounts = createAccounts({ sql, rest, now })
  const deps = { sql, store, rest, snapshots, accounts, log, now }
  const jobs = [createDiscoveryJob(deps), createMetadataJob(deps)]
  return { fetch, accounts, scheduler: createScheduler(jobs, { sql, log, report, now }) }
}

const account = (username: string | null, verified: boolean): FakeResponse => ({
  status: 200,
  body: { address: OWNER, username, display_name: username, is_verified: verified },
})
const hornetRoutes = {
  [`/chain/ink/contract/${HORNET}`]: recorded(`contract/${HORNET}`),
  "/collections/ink-hornet": recorded("collections/ink-hornet"),
}
const collectionEvents = async () =>
  (
    await sql<{ payload: NftCollectionEvent }[]>`
      select payload from indexer.events where type = 'nft.collection' order by id`
  ).map((r) => r.payload)
const addCollection = (extra: Record<string, unknown> = {}) =>
  sql`insert into indexer.nft_collections ${sql({
    contract: HORNET,
    standard: "erc721",
    next_discovery_at: new Date(T0),
    ...extra,
  })}`

describe("creator accounts", () => {
  it("an account is fetched once and cached for 7 days; a 404 caches no username", async () => {
    const s = setup({
      [`/accounts/${OWNER}`]: recorded(`accounts/${OWNER}-handmade`),
      [`/accounts/${CREATOR}`]: { status: 404, body: { errors: ["not found"] } },
    })
    expect(await s.accounts.getAccount(OWNER)).toEqual({
      ok: true,
      value: { username: "INKHornetDEV", verified: false },
    })
    clock += 7 * DAY - 1
    expect(await s.accounts.getAccount(OWNER)).toMatchObject({
      ok: true,
      value: { username: "INKHornetDEV" },
    })
    expect(s.fetch.calls).toHaveLength(1)
    expect(s.fetch.calls[0]?.path).toBe(`/accounts/${OWNER}`)

    // Seven days after the read it is read again.
    clock += 1
    await s.accounts.getAccount(OWNER)
    expect(s.fetch.calls).toHaveLength(2)

    // A 404 is an answer: no username, not verified, and not asked again for 7 days.
    expect(await s.accounts.getAccount(CREATOR)).toEqual({
      ok: true,
      value: { username: null, verified: false },
    })
    expect(await s.accounts.getAccount(CREATOR)).toMatchObject({ ok: true })
    expect(s.fetch.calls).toHaveLength(3)
    const [row] = await sql`select * from indexer.nft_accounts where address = ${CREATOR}`
    expect(row).toMatchObject({ username: null, verified: false })
    expect(row?.fetched_at).toEqual(new Date(clock))
  })

  it("addresses are cached in lowercase", async () => {
    const s = setup({ [`/accounts/${OWNER}`]: recorded(`accounts/${OWNER}-handmade`) })
    await s.accounts.getAccount(OWNER.toUpperCase().replace("0X", "0x"))
    await s.accounts.getAccount(OWNER)
    expect(s.fetch.calls).toHaveLength(1)
  })

  it("an error is passed on and not cached", async () => {
    let status = 500
    const s = setup({
      [`/accounts/${OWNER}`]: () => (status === 200 ? account("a", false) : { status, body: {} }),
    })
    expect(await s.accounts.getAccount(OWNER)).toEqual({ ok: false, reason: "error" })
    expect(await sql`select 1 from indexer.nft_accounts`).toHaveLength(0)
    status = 200
    expect(await s.accounts.getAccount(OWNER)).toMatchObject({ ok: true })
  })

  it("discovery stores the owner and the snapshot carries the creator", async () => {
    const s = setup({
      ...hornetRoutes,
      [`/accounts/${OWNER}`]: recorded(`accounts/${OWNER}-handmade`),
    })
    await addCollection()
    await s.scheduler.tick()
    const [row] = await sql`select owner, snapshot_n from indexer.nft_collections`
    expect(row).toMatchObject({ owner: OWNER, snapshot_n: 1 })
    const events = await collectionEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.creator).toEqual({
      address: OWNER,
      username: "INKHornetDEV",
      verified: false,
    })
    expect(reports).toEqual([])
  })

  it("a Chimera launch creator is looked up instead of the page owner", async () => {
    const s = setup({
      ...hornetRoutes,
      [`/accounts/${CREATOR}`]: { status: 200, body: { username: "launcher", is_verified: true } },
    })
    await addCollection({ creator_address: CREATOR })
    await s.scheduler.tick()
    expect(s.fetch.calls.map((c) => c.path)).not.toContain(`/accounts/${OWNER}`)
    expect((await collectionEvents())[0]?.creator).toEqual({
      address: CREATOR,
      username: "launcher",
      verified: true,
    })
  })

  it("the snapshot carries the creator and is written again when verified changes", async () => {
    let verified = false
    let username = "INKHornetDEV"
    const s = setup({
      ...hornetRoutes,
      [`/accounts/${OWNER}`]: () => account(username, verified),
    })
    await addCollection()
    await s.scheduler.tick()

    // A day later the page is read again: the account is still cached and nothing changes.
    clock += DAY
    await s.scheduler.tick()
    expect(await collectionEvents()).toHaveLength(1)

    // After the cache expires the account is read again and OpenSea has verified it.
    verified = true
    clock += 7 * DAY
    await s.scheduler.tick()
    const events = await collectionEvents()
    expect(events).toHaveLength(2)
    expect(events[1]?.creator).toEqual({ address: OWNER, username: "INKHornetDEV", verified: true })

    // A new username counts too.
    username = "INKHornet"
    clock += 7 * DAY
    await s.scheduler.tick()
    const later = await collectionEvents()
    expect(later).toHaveLength(3)
    expect(later[2]?.creator).toMatchObject({ username: "INKHornet", verified: true })
  })

  it("an account that cannot be read yet gives a snapshot without a creator, and the page is read again soon", async () => {
    const s = setup({ ...hornetRoutes, [`/accounts/${OWNER}`]: { status: 500, body: {} } })
    await addCollection()
    await s.scheduler.tick()
    const events = await collectionEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.creator).toBeNull()
    const [row] = await sql`select next_metadata_at from indexer.nft_collections`
    expect(row?.next_metadata_at).toEqual(new Date(T0 + HOUR))
  })

  it("an account that keeps failing costs two requests an hour, not one every few minutes", async () => {
    const s = setup({ ...hornetRoutes, [`/accounts/${OWNER}`]: { status: 500, body: {} } })
    await addCollection()
    // Three hours of ticks every five minutes.
    for (let i = 0; i <= 36; i++) {
      clock = T0 + i * 5 * 60_000
      await s.scheduler.tick()
    }
    const paths = s.fetch.calls.map((c) => c.path)
    // Discovery read the contract once. Then the page and the account at 0, 1h, 2h and 3h.
    expect(paths.filter((p) => p === "/collections/ink-hornet")).toHaveLength(4)
    expect(paths.filter((p) => p === `/accounts/${OWNER}`)).toHaveLength(4)
    // Snapshot written once; the failing account changes nothing in it.
    expect(await collectionEvents()).toHaveLength(1)
  })

  it("an account OpenSea does not have gives a creator with no username", async () => {
    const s = setup({ ...hornetRoutes, [`/accounts/${OWNER}`]: { status: 404, body: {} } })
    await addCollection()
    await s.scheduler.tick()
    expect((await collectionEvents())[0]?.creator).toEqual({
      address: OWNER,
      username: null,
      verified: false,
    })
  })
})
