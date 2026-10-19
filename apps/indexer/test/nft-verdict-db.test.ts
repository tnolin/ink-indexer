import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { NftCollectionEvent, NftGates, NftMintEvent } from "@ink-indexer/events"
import { decodeNftTransfers } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import {
  loadFarmWallets,
  loadNftFixture,
  type NftFixtureName,
} from "../../../packages/sdk/test/fixtures"
import type { Logger } from "../src/log"
import { applyMark, parseMark } from "../src/mark-cli"
import type { NftBatch } from "../src/sources/nft/index"
import { createVerdictJob, farmShareBps } from "../src/sources/nft/verdict"
import { writeRows } from "../src/sources/nft/write"
import { createAccounts } from "../src/sources/opensea/accounts"
import type { Budget } from "../src/sources/opensea/budget"
import { createDiscoveryJob, createMetadataJob } from "../src/sources/opensea/discovery"
import { createOpenSeaRest } from "../src/sources/opensea/rest"
import { createScheduler } from "../src/sources/opensea/scheduler"
import { createSnapshots } from "../src/sources/opensea/snapshot"
import { createTraitsJob } from "../src/sources/opensea/traits"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import { fakeFetch, recorded } from "./opensea/fake-fetch"

const BURST = "0x165dcae7953657e23035c96503b2a5b51ddfa4cd"
const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const INKVERSE = "0xfffbd67f37e1e9fd9d9ebef9b687daa72a33da64"
const PRTSCN = "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448"
const FRESH = "0x00000000000000000000000000000000000000f1"
const KEY = "test-key-0123456789abcdef"
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.parse("2026-10-19T00:00:00Z")
/** Block of the first mint in these tests; one block a second from T0. */
const B0 = 1_000_000
const blockAt = (ms: number) => B0 + (ms - T0) / 1000
/** The mint history starts ten days before T0. */
const HISTORY_MS = T0 - 10 * DAY
const HISTORY_BLOCK = BigInt(blockAt(HISTORY_MS))
const sec = (ms: number) => Math.floor(ms / 1000)

let sql: Sql
let store: Store
let clock: number
let chain: FakeChain
let reports: unknown[]
/** Numbers the stored mints: tx hash and token id. */
let mintSeq = 0

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  clock = T0
  chain = new FakeChain(10n)
  reports = []
  mintSeq = 0
  // Off-chain events are stamped with the chain cursor, so it needs a block.
  await store.writeBatch([], [], {
    cursor: { block: 100n, hash: `0x${"11".repeat(32)}` },
    head: 100n,
  })
})
afterEach(() => sql.end())

const now = () => clock
const log: Logger = () => {}
const report = (e: unknown) => void reports.push(e)
const budget: Budget = { take: async () => true, block: async () => {} }

function setup(routes: Parameters<typeof fakeFetch>[0] = {}) {
  const fetch = fakeFetch(routes)
  const rest = createOpenSeaRest({ key: KEY, budget, fetch, log, report, now })
  const snapshots = createSnapshots({ sql, store, now })
  const accounts = createAccounts({ sql, rest, now })
  const verdict = createVerdictJob({
    sql,
    store,
    snapshots,
    chain,
    historyStartTs: sec(HISTORY_MS),
    historyStartBlock: HISTORY_BLOCK,
    log,
    now,
  })
  const traits = createTraitsJob({ sql, store, rest, snapshots, accounts, log, now })
  const discovery = createDiscoveryJob({ sql, store, rest, snapshots, accounts, log, now })
  const metadata = createMetadataJob({ sql, store, rest, snapshots, accounts, log, now })
  const scheduler = createScheduler([verdict, traits], { sql, log, report, now })
  return { fetch, verdict, traits, discovery, metadata, scheduler, snapshots }
}

/** A collection row as the chain and OpenSea sources leave it: a page that passes gate 1. */
async function addCollection(contract: string, extra: Record<string, unknown> = {}) {
  const row = {
    contract,
    standard: "erc721",
    slug: `slug-${contract.slice(2, 8)}`,
    name: "Name",
    image_url: "https://img",
    twitter: "handle",
    next_discovery_at: null,
    first_mint_block: B0,
    first_mint_ts: new Date(T0),
    ...extra,
  }
  await sql`insert into indexer.nft_collections ${sql(row)}`
}

/** One `nft_mints` row per recipient, at the given blocks (one each, or all at the first). */
async function addMints(contract: string, recipients: string[], blocks: number[]) {
  const n = recipients.length
  const ids = recipients.map(() => ++mintSeq)
  await sql`
    insert into indexer.nft_mints (tx_hash, log_index, idx, contract, token_id, recipient, qty, block)
    select * from unnest(
      ${sql.array(ids.map((i) => `0x${i.toString(16).padStart(64, "0")}`))}::text[],
      ${sql.array(ids.map(() => 0))}::int[],
      ${sql.array(ids.map(() => 0))}::int[],
      ${sql.array(recipients.map(() => contract))}::text[],
      ${sql.array(ids.map((i) => String(i)))}::numeric[],
      ${sql.array(recipients)}::text[],
      ${sql.array(ids.map(() => "1"))}::numeric[],
      ${sql.array(recipients.map((_, i) => String(blocks[i] ?? blocks[0])))}::bigint[])`
  return n
}

// biome-ignore lint/suspicious/noExplicitAny: rows are read by column name
type Row = Record<string, any>
const rowOf = async (contract: string): Promise<Row> =>
  (await sql`select * from indexer.nft_collections where contract = ${contract}`)[0] as Row
const eventsOf = async <T>(type: string) =>
  (
    await sql<{ tx_hash: string; sub: string; payload: T }[]>`
      select tx_hash, sub, payload from indexer.events where type = ${type} order by id`
  ).map((r) => ({ txHash: r.tx_hash, sub: r.sub, ...r.payload })) as (T & {
    txHash: string
    sub: string
  })[]

/** Distinct mint recipients of a contract in a recorded fixture. */
function recipientsOf(name: NftFixtureName, contract: string): string[] {
  const out = new Set<string>()
  for (const l of loadNftFixture(name))
    for (const t of decodeNftTransfers(l))
      if (t.kind === "mint" && t.contract === contract) out.add(t.account)
  return [...out]
}

describe("farmShareBps", () => {
  it("farmShareBps on farm-wallets fixture: a burst collection > 30%, a synthetic real collection < 30%", async () => {
    const recorded = loadFarmWallets()
    const bursts = Object.entries(recorded).filter(([k]) => k !== "farmWallets")
    expect(bursts).toHaveLength(10)
    // Every burst is a drop that minted within the last day.
    for (const [contract, wallets] of bursts) {
      await addCollection(contract, { kind: "drop" })
      await addMints(contract, wallets, [blockAt(T0 + HOUR)])
    }
    // The reference collections, with their recorded minters, minting in the same window.
    const refs: Record<string, string[]> = {
      [HORNET]: recipientsOf("hornet-mints", HORNET),
      [INKVERSE]: recipientsOf("inkverse-mints", INKVERSE),
      [PRTSCN]: recipientsOf("prtscn-mints", PRTSCN),
    }
    for (const [contract, wallets] of Object.entries(refs)) {
      await addCollection(contract, { kind: "drop" })
      await addMints(contract, wallets, [blockAt(T0 + 2 * HOUR)])
    }
    // A synthetic real collection: 100 fresh wallets and 10 farm wallets.
    const fresh = Array.from(
      { length: 100 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "a")}`,
    )
    const farm = recorded.farmWallets!.slice(0, 10)
    await addCollection(FRESH, { kind: "drop" })
    await addMints(FRESH, [...fresh, ...farm], [blockAt(T0 + 3 * HOUR)])

    const at = sec(T0 + DAY)
    const burst = await farmShareBps(sql, BURST, at)
    expect(burst.minters).toBe(recorded[BURST]!.length)
    expect(burst.share).toBeGreaterThan(3000)
    expect(await farmShareBps(sql, FRESH, at)).toEqual({ share: 909, minters: 110 })
    for (const contract of [HORNET, INKVERSE, PRTSCN]) {
      const r = await farmShareBps(sql, contract, at)
      expect(r.minters).toBe(refs[contract]!.length)
      expect(r.share).toBeLessThan(3000)
    }

    // Mints older than the farm window do not count, nor do collections that are not drops.
    expect((await farmShareBps(sql, BURST, sec(T0 + 8 * DAY))).share).toBe(0)
    await sql`update indexer.nft_collections set kind = 'continuous' where contract <> ${BURST}`
    expect((await farmShareBps(sql, BURST, at)).share).toBe(0)
  })
})

describe("the verdict job", () => {
  const minter = (i: number) => `0x${i.toString(16).padStart(40, "b")}`

  it("non-SeaDrop stage_start written once after 30 minutes, with blockTimestamp of the run", async () => {
    const s = setup()
    await addCollection(PRTSCN)
    // A mint every minute for the first ten minutes.
    await addMints(
      PRTSCN,
      Array.from({ length: 10 }, (_, i) => minter(i)),
      Array.from({ length: 10 }, (_, i) => blockAt(T0 + i * MIN)),
    )
    clock = T0 + 10 * MIN
    await s.scheduler.tick()
    expect(await eventsOf("nft.mint")).toHaveLength(0)
    let row = await rowOf(PRTSCN)
    expect(row).toMatchObject({
      kind: "drop",
      verdict: "pending",
      verdict_dirty: false,
      max_supply_checked: true,
    })
    expect(row.gates.structure).toBe("pending")
    // Due again when gate 2 can be decided.
    expect(row.next_verdict_at).toEqual(new Date(T0 + 30 * MIN))
    expect(chain.maxSupplyReads).toEqual([
      { contract: PRTSCN, block: BigInt(blockAt(T0 + 9 * MIN)) },
    ])

    // Still minting at 30 minutes.
    await addMints(
      PRTSCN,
      Array.from({ length: 20 }, (_, i) => minter(100 + i)),
      Array.from({ length: 20 }, (_, i) => blockAt(T0 + (10 + i) * MIN)),
    )
    clock = T0 + 30 * MIN + 5_000
    await s.scheduler.tick()
    const events = await eventsOf<NftMintEvent>("nft.mint")
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      txHash: `nft:start:${PRTSCN}`,
      sub: "mint:stage_start:0",
      v: 1,
      chainId: 57073,
      type: "nft.mint",
      contract: PRTSCN,
      source: "opensea",
      logIndex: 0,
      blockNumber: "100",
      blockTimestamp: sec(clock),
      kind: "stage_start",
      stageIndex: 0,
      stageLabel: "Mint",
      stagePriceWei: "0",
      markBps: null,
      minted: "30",
      maxSupply: "0",
      mintStartTs: sec(T0),
      stageStartTs: sec(T0),
      minters: 30,
    })
    row = await rowOf(PRTSCN)
    expect(row.mint_start_emitted).toBe(true)
    expect(row.gates.structure).toBe("pass")
    expect(row.verdict).toBe("real")
    // maxSupply() was read only once.
    expect(chain.maxSupplyReads).toHaveLength(1)

    // Run again: nothing new.
    await sql`update indexer.nft_collections set verdict_dirty = true where contract = ${PRTSCN}`
    clock += 15_000
    await s.scheduler.tick()
    expect(await eventsOf("nft.mint")).toHaveLength(1)
    expect(reports).toEqual([])
  })

  it("a verified creator's mint gets its MINT LIVE at its tenth mint, marked dirty by the mints", async () => {
    const s = setup()
    const owner = "0x00000000000000000000000000000000000000c1"
    await addCollection(PRTSCN, { owner, first_mint_block: null, first_mint_ts: null })
    await sql`insert into indexer.nft_accounts (address, username, verified, fetched_at)
      values (${owner}, 'maker', true, ${new Date(T0)})`
    const batch = (from: number, n: number): NftBatch => ({
      ...emptyBatch(),
      collections: [
        {
          contract: PRTSCN,
          standard: "erc721",
          firstMint: { block: BigInt(blockAt(T0)), ts: sec(T0) },
          seadrop: false,
          launch: null,
        },
      ],
      mints: Array.from({ length: n }, (_, i) => ({
        txHash: `0x${(from + i + 1).toString(16).padStart(64, "0")}` as `0x${string}`,
        logIndex: 0,
        idx: 0,
        contract: PRTSCN as Address,
        tokenId: BigInt(from + i + 1),
        account: minter(from + i) as Address,
        qty: 1n,
        block: BigInt(blockAt(T0 + (from + i) * 1000)),
      })),
    })
    await sql.begin((tx) => writeRows(tx, batch(0, 5)))
    clock = T0 + 5_000
    await s.scheduler.tick()
    expect(await eventsOf("nft.mint")).toHaveLength(0)
    expect((await rowOf(PRTSCN)).verdict_dirty).toBe(false)

    await sql.begin((tx) => writeRows(tx, batch(5, 5)))
    expect((await rowOf(PRTSCN)).verdict_dirty).toBe(true)
    clock = T0 + 15_000
    await s.scheduler.tick()
    const events = await eventsOf<NftMintEvent>("nft.mint")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ minted: "10", blockTimestamp: sec(T0 + 15_000) })
    const [snapshot] = (await eventsOf<NftCollectionEvent>("nft.collection")).slice(-1)
    expect(snapshot?.creator).toEqual({ address: owner, username: "maker", verified: true })
    expect(snapshot?.gates).toMatchObject({ page: "pass", structure: "pass" })

    // A verified collection of another kind (WIRED) is not looked at on every mint.
    await sql`update indexer.nft_collections set kind = 'continuous', mint_start_emitted = false,
      verdict_dirty = false where contract = ${PRTSCN}`
    await sql.begin((tx) => writeRows(tx, batch(10, 5)))
    expect((await rowOf(PRTSCN)).verdict_dirty).toBe(false)
  })

  it("stores kind, gates and verdict and writes the snapshot; a failed run is tried again", async () => {
    const s = setup()
    await addCollection(BURST, { seadrop: true, max_supply: "100" })
    await addMints(
      BURST,
      Array.from({ length: 100 }, (_, i) => minter(i)),
      [blockAt(T0)],
    )
    clock = T0 + 40 * MIN
    // A transport failure on maxSupply(): the run throws, and the row stays due.
    const read = chain.readMaxSupply.bind(chain)
    chain.readMaxSupply = async () => {
      throw new Error("socket closed")
    }
    await sql`update indexer.nft_collections set max_supply = null where contract = ${BURST}`
    await s.scheduler.tick()
    expect(reports).toHaveLength(1)
    expect((await rowOf(BURST)).verdict_dirty).toBe(true)

    chain.readMaxSupply = read
    chain.maxSupplies.set(BURST, 100n)
    clock += 15_000
    expect(await s.verdict.due(sql, new Date(clock))).toEqual([BURST])
    await s.verdict.run(BURST)
    const row = await rowOf(BURST)
    // Sold out in its first block, one public stage: gate 2 fails.
    expect(row).toMatchObject({ kind: "drop", verdict: "junk", max_supply: "100" })
    const gates: NftGates = row.gates
    expect(gates).toEqual({
      page: "pass",
      structure: "fail",
      traits: "pending",
      farm: "pass",
      farmShareBps: 0,
    })
    const [snapshot] = await eventsOf<NftCollectionEvent>("nft.collection")
    expect(snapshot).toMatchObject({ verdict: "junk", kind: "drop", manual: false, gates })
    // The mint ended: the traits sample is due at once.
    expect(row.next_traits_at).toEqual(new Date(T0))
    expect(row.next_verdict_at).toBeNull()

    // A signed stage seen on chain passes gate 2.
    await sql`insert into indexer.nft_stages (contract, stage_index, first_block, first_ts)
      values (${BURST}, 1, ${B0}, ${new Date(T0)})`
    await sql`update indexer.nft_collections set verdict_dirty = true where contract = ${BURST}`
    await s.verdict.run(BURST)
    expect(await rowOf(BURST)).toMatchObject({ verdict: "real", gates: { structure: "pass" } })
  })

  it("milestone marks and a first mint mark the verdict dirty; giving up discovery does too", async () => {
    const s = setup({ [`/chain/ink/contract/${INKVERSE}`]: { status: 404, body: {} } })
    await addCollection(BURST, { seadrop: true, verdict_dirty: false })
    const touch = {
      contract: BURST as Address,
      standard: "erc721" as const,
      firstMint: null,
      seadrop: true,
      launch: null,
    }
    const milestone = (lastMarkBps: number) => ({
      contract: BURST as Address,
      maxSupply: 100n,
      lastMarkBps,
      soldOutBlock: null,
    })
    await sql.begin((tx) =>
      writeRows(tx, { ...emptyBatch(), collections: [touch], milestones: [milestone(0)] }),
    )
    expect((await rowOf(BURST)).verdict_dirty).toBe(false)
    await sql.begin((tx) =>
      writeRows(tx, { ...emptyBatch(), collections: [touch], milestones: [milestone(2500)] }),
    )
    expect((await rowOf(BURST)).verdict_dirty).toBe(true)

    // First mint of a SeaDrop collection known before it minted.
    await addCollection(HORNET, {
      seadrop: true,
      first_mint_block: null,
      first_mint_ts: null,
      verdict_dirty: false,
    })
    await sql.begin((tx) =>
      writeRows(tx, {
        ...emptyBatch(),
        collections: [
          {
            contract: HORNET as Address,
            standard: "erc721",
            firstMint: { block: 5n, ts: 5 },
            seadrop: true,
            launch: null,
          },
        ],
      }),
    )
    expect((await rowOf(HORNET)).verdict_dirty).toBe(true)

    // Discovery gives up on a contract with no slug: gate 1 can now fail.
    await addCollection(INKVERSE, {
      slug: null,
      discovery_attempts: 20,
      next_discovery_at: new Date(T0),
      verdict_dirty: false,
    })
    await s.discovery.run(INKVERSE)
    expect(await rowOf(INKVERSE)).toMatchObject({ next_discovery_at: null, verdict_dirty: true })

    // New activity restarts discovery, and gate 1 waits on it again.
    await sql`update indexer.nft_collections set verdict_dirty = false where contract = ${INKVERSE}`
    await sql.begin((tx) =>
      writeRows(tx, {
        ...emptyBatch(),
        mints: [
          {
            txHash: `0x${"ab".repeat(32)}`,
            logIndex: 0,
            idx: 0,
            contract: INKVERSE as Address,
            tokenId: 7n,
            account: FRESH as Address,
            qty: 1n,
            block: 90n,
          },
        ],
      }),
    )
    expect(await rowOf(INKVERSE)).toMatchObject({ discovery_attempts: 0, verdict_dirty: true })
  })

  it("a creator account that turns verified marks the verdict dirty", async () => {
    const page = recorded("collections/ink-hornet")
    const owner = (page.body as { owner: string }).owner
    let verified = false
    const s = setup({
      "/collections/ink-hornet": page,
      [`/accounts/${owner}`]: () => ({
        status: 200,
        body: { address: owner, username: "maker", is_verified: verified },
      }),
    })
    await addCollection(HORNET, { slug: "ink-hornet", next_metadata_at: new Date(T0) })
    await s.metadata.run(HORNET)
    await sql`update indexer.nft_collections set verdict_dirty = false,
      next_metadata_at = ${new Date(T0)} where contract = ${HORNET}`
    // The page is unchanged and the account still unverified: nothing to look at.
    clock = T0 + 8 * DAY
    await s.metadata.run(HORNET)
    expect((await rowOf(HORNET)).verdict_dirty).toBe(false)
    verified = true
    clock = T0 + 16 * DAY
    await s.metadata.run(HORNET)
    expect((await rowOf(HORNET)).verdict_dirty).toBe(true)
  })
})

describe("legacy collections", () => {
  const minter = (i: number) => `0x${i.toString(16).padStart(40, "b")}`
  /** A mint every minute for 30 minutes from T0, then a verdict run at 30 minutes. */
  async function mintFor30Minutes(contract: string, extra: Record<string, unknown> = {}) {
    const s = setup()
    await addCollection(contract, extra)
    await addMints(
      contract,
      Array.from({ length: 30 }, (_, i) => minter(i)),
      Array.from({ length: 30 }, (_, i) => blockAt(T0 + i * MIN)),
    )
    clock = T0 + 30 * MIN + 5_000
    await s.scheduler.tick()
    return s
  }

  it("a collection whose totalSupply() before its first stored mint is 100 is legacy, with no MINT LIVE", async () => {
    chain.totalSupplyAt.set(PRTSCN, (b) => (b < B0 ? 100n : 130n))
    const s = await mintFor30Minutes(PRTSCN)
    const row = await rowOf(PRTSCN)
    expect(row).toMatchObject({ kind: "legacy", prior_supply: "100", prior_minted: true })
    expect(row.gates).toMatchObject({ structure: "n/a", farm: "n/a" })
    expect(await eventsOf("nft.mint")).toHaveLength(0)
    expect(chain.priorReads).toEqual([
      { method: "totalSupply", address: PRTSCN, block: BigInt(B0 - 1) },
    ])
    // Decided once.
    await sql`update indexer.nft_collections set verdict_dirty = true where contract = ${PRTSCN}`
    await s.verdict.run(PRTSCN)
    expect(chain.priorReads).toHaveLength(1)
  })

  it("a new SeaDrop drop (no supply before its first mint) stays a drop", async () => {
    chain.totalSupplyAt.set(HORNET, (b) => (b < B0 ? 0n : 30n))
    await mintFor30Minutes(HORNET, { seadrop: true })
    expect(await rowOf(HORNET)).toMatchObject({
      kind: "drop",
      prior_supply: "0",
      prior_minted: false,
    })
  })

  it("without totalSupply(): legacy when the contract had code before the history started", async () => {
    chain.deployedAt.set(PRTSCN, HISTORY_BLOCK - 100n)
    await mintFor30Minutes(PRTSCN)
    expect(await rowOf(PRTSCN)).toMatchObject({
      kind: "legacy",
      prior_supply: null,
      prior_minted: true,
    })
    expect(chain.priorReads).toEqual([
      { method: "totalSupply", address: PRTSCN, block: BigInt(B0 - 1) },
      { method: "code", address: PRTSCN, block: HISTORY_BLOCK - 1n },
    ])
    expect(await eventsOf("nft.mint")).toHaveLength(0)
  })

  it("without totalSupply(): a drop when the contract was deployed after the history started", async () => {
    chain.deployedAt.set(PRTSCN, HISTORY_BLOCK + 100n)
    await mintFor30Minutes(PRTSCN)
    expect(await rowOf(PRTSCN)).toMatchObject({ kind: "drop", prior_minted: false })
    expect(await eventsOf("nft.mint")).toHaveLength(1)
  })

  it("a Chimera collection needs no read", async () => {
    await mintFor30Minutes(PRTSCN, { launchpad: "chimera" })
    expect(await rowOf(PRTSCN)).toMatchObject({ kind: "continuous", prior_minted: null })
    expect(chain.priorReads).toEqual([])
  })
})

describe("the traits job", () => {
  it("samples one minted item at each checkpoint after the mint ended; no traits by 72 hours fails gate 3", async () => {
    const path = `/chain/ink/contract/${BURST}/nfts/1`
    const s = setup({ [path]: recorded(`nfts/${BURST}/1`) })
    await addCollection(BURST, { seadrop: true, max_supply: "1" })
    await addMints(BURST, [`0x${"c".repeat(40)}`], [blockAt(T0)])

    const checkAt = async (ms: number) => {
      clock = ms
      await s.scheduler.tick()
      // The sample marks the verdict dirty; the next tick schedules the next checkpoint.
      clock += 10_000
      await s.scheduler.tick()
    }
    await checkAt(T0 + 1_000)
    expect(s.fetch.calls.map((c) => c.path)).toEqual([path])
    let row = await rowOf(BURST)
    expect(row).toMatchObject({ traits_state: "empty", traits_checks: 1 })
    expect(row.next_traits_at).toEqual(new Date(T0 + DAY))
    expect(row.gates.traits).toBe("pending")

    await checkAt(T0 + DAY)
    await checkAt(T0 + 2 * DAY)
    row = await rowOf(BURST)
    expect(row).toMatchObject({ traits_checks: 3, verdict: "junk" })
    expect(row.gates.traits).toBe("pending")

    await checkAt(T0 + 3 * DAY)
    row = await rowOf(BURST)
    expect(s.fetch.calls).toHaveLength(4)
    expect(row).toMatchObject({ traits_state: "empty", traits_checks: 4, next_traits_at: null })
    expect(row.gates.traits).toBe("fail")
    const last = (await eventsOf<NftCollectionEvent>("nft.collection")).at(-1)
    expect(last?.gates.traits).toBe("fail")

    // Nothing more is asked.
    clock += 30 * DAY
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(4)
    expect(reports).toEqual([])
  })

  it("an item with traits passes gate 3 and is not sampled again", async () => {
    const path = `/chain/ink/contract/${HORNET}/nfts/1`
    const s = setup({ [path]: recorded(`nfts/${HORNET}/1`) })
    await addCollection(HORNET, {
      seadrop: true,
      max_supply: "1",
      next_traits_at: new Date(T0),
    })
    await addMints(HORNET, [`0x${"d".repeat(40)}`], [blockAt(T0)])
    clock = T0 + 1_000
    await s.scheduler.tick()
    clock += 10_000
    await s.scheduler.tick()
    const row = await rowOf(HORNET)
    expect(row).toMatchObject({ traits_state: "pass", next_traits_at: null })
    expect(row.gates.traits).toBe("pass")
    clock += 5 * DAY
    await s.scheduler.tick()
    expect(s.fetch.calls).toHaveLength(1)
  })

  it("a transient error tries again in five minutes without counting a check", async () => {
    const path = `/chain/ink/contract/${HORNET}/nfts/1`
    const s = setup({ [path]: { status: 500, body: {} } })
    await addCollection(HORNET, { next_traits_at: new Date(T0) })
    await addMints(HORNET, [`0x${"d".repeat(40)}`], [blockAt(T0)])
    await s.traits.run(HORNET)
    expect(await rowOf(HORNET)).toMatchObject({
      traits_state: "pending",
      traits_checks: 0,
      next_traits_at: new Date(T0 + 5 * MIN),
    })
  })
})

describe("manual marks", () => {
  it("manual mark re-emits the snapshot", async () => {
    const s = setup()
    await addCollection(HORNET, { seadrop: true })
    await addMints(
      HORNET,
      Array.from({ length: 3 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "e")}`),
      [blockAt(T0)],
    )
    clock = T0 + MIN
    await s.scheduler.tick()
    const deps = { sql, verdict: s.verdict }
    let events = await eventsOf<NftCollectionEvent>("nft.collection")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ verdict: "pending", manual: false, kind: "drop" })

    await applyMark(deps, { contract: HORNET, value: "junk" })
    events = await eventsOf<NftCollectionEvent>("nft.collection")
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ verdict: "junk", manual: true })
    expect(
      (await sql`select kind, verdict from indexer.nft_overrides where contract = ${HORNET}`)[0],
    ).toMatchObject({ kind: null, verdict: "junk" })

    await applyMark(deps, { contract: HORNET, value: "continuous" })
    events = await eventsOf<NftCollectionEvent>("nft.collection")
    expect(events.at(-1)).toMatchObject({ verdict: "junk", manual: true, kind: "continuous" })
    expect(events.at(-1)?.gates).toMatchObject({ structure: "n/a", farm: "n/a" })

    await applyMark(deps, { contract: HORNET, value: "clear" })
    events = await eventsOf<NftCollectionEvent>("nft.collection")
    expect(events.at(-1)).toMatchObject({ verdict: "pending", manual: false, kind: "drop" })
    expect(await sql`select 1 from indexer.nft_overrides`).toHaveLength(0)
    expect(reports).toEqual([])
  })

  it("nft:mark validates the address and value", () => {
    expect(parseMark([HORNET.toUpperCase().replace("0X", "0x"), "real"])).toEqual({
      ok: true,
      contract: HORNET,
      value: "real",
    })
    expect(parseMark([HORNET, "clear"])).toMatchObject({ ok: true, value: "clear" })
    expect(parseMark([HORNET, "spam"])).toMatchObject({ ok: false })
    expect(parseMark(["0x1234", "real"])).toMatchObject({ ok: false })
    expect(parseMark([HORNET])).toMatchObject({ ok: false })
  })
})

function emptyBatch(): NftBatch {
  return {
    events: [],
    blocks: [],
    mints: [],
    burns: [],
    seadropMints: [],
    seadropConfig: [],
    sales: [],
    launches: [],
    collections: [],
    stages: [],
    milestones: [],
    touched: [],
  }
}
