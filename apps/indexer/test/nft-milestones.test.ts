import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { NftMintEvent } from "@ink-indexer/events"
import { type ChainLog, decodeNftTransfers } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { loadNftFixture } from "../../../packages/sdk/test/fixtures"
import { Indexer } from "../src/loop"
import { nftSource } from "../src/sources/nft/index"
import {
  type MilestoneInput,
  planMilestones,
  type StoredDrop,
  stageLabel,
} from "../src/sources/nft/milestones"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"

const CONTRACT = "0x00000000000000000000000000000000000000c1" as Address
const INKVERSE = "0xfffbd67f37e1e9fd9d9ebef9b687daa72a33da64" as Address

const input = (over: Partial<MilestoneInput> = {}): MilestoneInput => ({
  contract: CONTRACT,
  lastMarkBps: 0,
  soldOut: false,
  totalSupply: 0n,
  maxSupply: 10_000n,
  newStages: [],
  current: { index: 1, priceWei: 5n },
  drop: null,
  mintStartTs: 1_000,
  stageStartTs: new Map([[1, 1_000]]),
  minters: 3,
  stageCounts: [],
  ...over,
})

const DROP: StoredDrop = {
  slug: "x",
  maxSupply: 10_000n,
  stages: [
    {
      type: "allowlist",
      label: "Allowlist",
      priceWei: "0",
      startTime: 100,
      endTime: 200,
      maxPerWallet: 1,
      allowlistCount: 10,
    },
    {
      type: "public",
      label: "Public sale",
      priceWei: "5",
      startTime: 200,
      endTime: null,
      maxPerWallet: null,
      allowlistCount: null,
    },
  ],
}

describe("planMilestones", () => {
  it("burst crossing 25/50/75 in one batch emits three progress events with distinct sub", () => {
    const drafts = planMilestones(input({ totalSupply: 8_000n }))
    expect(drafts.map((d) => [d.kind, d.markBps, d.sub])).toEqual([
      ["progress", 2500, "mint:progress:2500"],
      ["progress", 5000, "mint:progress:5000"],
      ["progress", 7500, "mint:progress:7500"],
    ])
    for (const d of drafts)
      expect(d).toMatchObject({
        stageIndex: 1,
        stageLabel: "Stage 1",
        stagePriceWei: "5",
        minted: "8000",
        maxSupply: "10000",
        mintStartTs: 1_000,
        stageStartTs: 1_000,
        minters: 3,
      })
    expect(drafts.every((d) => d.stageCounts === undefined)).toBe(true)
  })

  it("sold out emits sold_out with stageCounts", () => {
    const drafts = planMilestones(
      input({
        lastMarkBps: 7500,
        totalSupply: 10_000n,
        stageStartTs: new Map([
          [1, 1_000],
          [2, 1_500],
        ]),
        stageCounts: [
          { stageIndex: 1, minted: 4_000n },
          { stageIndex: 2, minted: 6_000n },
        ],
      }),
    )
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      kind: "sold_out",
      sub: "mint:sold_out:0",
      markBps: null,
      minted: "10000",
      maxSupply: "10000",
      stageCounts: [
        { stageIndex: 1, label: "Stage 1", minted: "4000" },
        { stageIndex: 2, label: "Stage 2", minted: "6000" },
      ],
    })
  })

  it("a sold-out collection that never fired a mark emits all three marks, then sold_out", () => {
    const drafts = planMilestones(input({ totalSupply: 10_000n }))
    expect(drafts.map((d) => d.sub)).toEqual([
      "mint:progress:2500",
      "mint:progress:5000",
      "mint:progress:7500",
      "mint:sold_out:0",
    ])
  })

  it("a new stage index emits stage_start labelled from the drop by time", () => {
    const drafts = planMilestones(
      input({
        drop: DROP,
        newStages: [
          { index: 1, block: 10n, ts: 150, priceWei: 7n },
          { index: 2, block: 20n, ts: 250, priceWei: 9n },
        ],
        stageStartTs: new Map([
          [1, 150],
          [2, 250],
        ]),
        current: { index: 2, priceWei: 9n },
        totalSupply: 100n,
      }),
    )
    expect(drafts.map((d) => [d.kind, d.sub, d.stageIndex, d.stageLabel, d.stagePriceWei])).toEqual(
      [
        ["stage_start", "mint:stage_start:1", 1, "Allowlist", "7"],
        ["stage_start", "mint:stage_start:2", 2, "Public sale", "9"],
      ],
    )
    expect(drafts.map((d) => d.stageStartTs)).toEqual([150, 250])
    expect(drafts.every((d) => d.markBps === null && d.minted === "100")).toBe(true)
  })

  it("orders stage starts, then marks, then sold out", () => {
    const drafts = planMilestones(
      input({
        totalSupply: 10_000n,
        newStages: [{ index: 1, block: 10n, ts: 1_000, priceWei: 5n }],
      }),
    )
    expect(drafts.map((d) => d.kind)).toEqual([
      "stage_start",
      "progress",
      "progress",
      "progress",
      "sold_out",
    ])
  })

  it("no repeat when lastMarkBps already 5000", () => {
    expect(planMilestones(input({ lastMarkBps: 5000, totalSupply: 6_000n }))).toEqual([])
    const drafts = planMilestones(input({ lastMarkBps: 5000, totalSupply: 8_000n }))
    expect(drafts.map((d) => d.markBps)).toEqual([7500])
  })

  it("nothing below the first mark, and nothing once sold out was announced", () => {
    expect(planMilestones(input({ totalSupply: 2_499n }))).toEqual([])
    expect(
      planMilestones(input({ lastMarkBps: 7500, soldOut: true, totalSupply: 10_000n })),
    ).toEqual([])
  })

  it("exact mark boundaries count", () => {
    const drafts = planMilestones(input({ totalSupply: 2_500n }))
    expect(drafts.map((d) => d.markBps)).toEqual([2500])
  })
})

describe("stageLabel", () => {
  it("falls back to Public / Stage N", () => {
    expect(stageLabel(null, 0, 500)).toBe("Public")
    expect(stageLabel(null, 3, 500)).toBe("Stage 3")
    // A drop with no stage around that time falls back the same way.
    expect(stageLabel(DROP, 0, 50)).toBe("Public")
    expect(stageLabel(DROP, 4, 50)).toBe("Stage 4")
  })

  it("takes the stage whose [startTime, endTime) holds the time", () => {
    expect(stageLabel(DROP, 1, 100)).toBe("Allowlist")
    expect(stageLabel(DROP, 1, 199)).toBe("Allowlist")
    expect(stageLabel(DROP, 1, 200)).toBe("Public sale")
    expect(stageLabel(DROP, 1, 9_999_999)).toBe("Public sale")
  })
})

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

const lastBlock = (logs: ChainLog[]) =>
  logs.reduce((m, l) => (l.blockNumber > m ? l.blockNumber : m), 0n)
const firstBlock = (logs: ChainLog[]) =>
  logs.reduce((m, l) => (l.blockNumber < m ? l.blockNumber : m), logs[0]!.blockNumber)

/** The collection's running supply: the mint transfers on the chain up to a block. */
function supplyFrom(chain: FakeChain, contract: Address, maxSupply: bigint) {
  chain.mintStats.set(contract, (block) => {
    let totalSupply = 0n
    for (const l of chain.logs)
      if (l.blockNumber <= block)
        for (const t of decodeNftTransfers(l))
          if (t.kind === "mint" && t.contract === contract) totalSupply += t.qty
    return { totalSupply, maxSupply }
  })
}

const blocksOf = (logs: ChainLog[]) =>
  [...new Set(logs.map((l) => l.blockNumber))].sort((a, b) => (a < b ? -1 : 1))
const mintsIn = (l: ChainLog) =>
  decodeNftTransfers(l)
    .filter((t) => t.kind === "mint")
    .reduce((n, t) => n + t.qty, 0n)

/**
 * The inkverse recording with its blocks renumbered one after another, so a stretch of mints is a
 * short stretch of blocks and fits in the 128 block hashes the store keeps for reorgs.
 */
function compactInkverse(): ChainLog[] {
  const all = loadNftFixture("inkverse-mints")
  const rank = new Map(blocksOf(all).map((b, i) => [b, firstBlock(all) + BigInt(i)]))
  return all.map((l) => ({ ...l, blockNumber: rank.get(l.blockNumber)! }))
}

/** An indexer with only the NFT source, its cursor just below the first log. */
async function start(chain: FakeChain, logs: ChainLog[]) {
  const idx = new Indexer({
    chain,
    store,
    logger: () => {},
    sources: [nftSource({ sql, chain, logger: () => {} })],
  })
  await idx.init()
  const first = firstBlock(logs)
  await store.writeBatch([], [], {
    cursor: { block: first - 1n, hash: chain.hashOf(first - 1n) },
    head: chain.head,
  })
  return idx
}

type MintRow = { payload: NftMintEvent; block: bigint; sub: string }
const mintEvents = async () =>
  (
    await sql<MintRow[]>`
    select payload, block, sub from indexer.events where type = 'nft.mint' order by id`
  ).map((r) => ({ ...r, block: BigInt(r.block) }))

describe("mint milestones in the NFT source", () => {
  it("inkverse fixture end to end", async () => {
    const logs = loadNftFixture("inkverse-mints")
    const chain = new FakeChain(lastBlock(logs) + 5n)
    for (const l of logs) chain.add(l)
    supplyFrom(chain, INKVERSE, 1_000n)
    const idx = await start(chain, logs)
    await idx.trigger()
    const firstMintBlock = firstBlock(logs.filter((l) => mintsIn(l) > 0n))

    const events = await mintEvents()
    const p = events.map((e) => e.payload)
    expect(p.filter((e) => e.kind === "stage_start").map((e) => e.stageIndex)).toEqual([1, 2, 3])
    expect(p.filter((e) => e.kind === "progress").map((e) => e.markBps)).toEqual([2500, 5000, 7500])
    const soldOut = p.filter((e) => e.kind === "sold_out")
    expect(soldOut).toHaveLength(1)
    expect(p.at(-1)!.kind).toBe("sold_out")
    expect(soldOut[0]).toMatchObject({
      type: "nft.mint",
      contract: INKVERSE,
      source: "chain",
      minted: "1000",
      maxSupply: "1000",
      markBps: null,
      stageIndex: 3,
      stageLabel: "Stage 3",
      stageCounts: [
        { stageIndex: 1, label: "Stage 1", minted: "100" },
        { stageIndex: 2, label: "Stage 2", minted: "487" },
        { stageIndex: 3, label: "Stage 3", minted: "413" },
      ],
    })
    // Every milestone is its own row.
    expect(new Set(events.map((e) => e.sub))).toEqual(
      new Set([
        "mint:stage_start:1",
        "mint:stage_start:2",
        "mint:stage_start:3",
        "mint:progress:2500",
        "mint:progress:5000",
        "mint:progress:7500",
        "mint:sold_out:0",
      ]),
    )
    expect(events).toHaveLength(7)
    for (const e of events) {
      expect(e.payload.minters).toBeGreaterThan(0)
      expect(e.payload.mintStartTs).toBe(Number(firstMintBlock))
      expect(e.payload.blockNumber).toBe(e.block.toString())
    }
    // A progress event reports the supply at the end of its batch: at least its mark.
    for (const e of p.filter((e) => e.kind === "progress"))
      expect(BigInt(e.minted) * 10_000n).toBeGreaterThanOrEqual(BigInt(e.markBps!) * 1_000n)
    // A stage starts at the time of its first mint.
    for (const e of p.filter((e) => e.kind === "stage_start"))
      expect(e.stageStartTs).toBe(Number(e.blockNumber))

    const stages =
      await sql`select contract, stage_index, first_block from indexer.nft_stages order by stage_index`
    expect(stages.map((r) => r.stage_index)).toEqual([1, 2, 3])
    const [c] = await sql`select * from indexer.nft_collections where contract = ${INKVERSE}`
    expect(c).toMatchObject({ last_mark_bps: 7500 })
    expect(c!.sold_out_block).not.toBeNull()
    expect(c!.max_supply).toBe("1000")
  })

  it("labels stages from a stored drop and reads nothing for a contract without mint stats", async () => {
    const logs = loadNftFixture("inkverse-mints")
    const first = firstBlock(logs.filter((l) => mintsIn(l) > 0n))
    await sql`insert into indexer.nft_drops (contract, slug, stages, max_supply, fetched_at) values
      (${INKVERSE}, 'inkverse', ${sql.json([
        {
          type: "allowlist",
          label: "Early",
          priceWei: "0",
          startTime: 0,
          endTime: Number(first) + 1,
          maxPerWallet: 1,
          allowlistCount: 5,
        },
        {
          type: "public",
          label: "Open",
          priceWei: "0",
          startTime: Number(first) + 1,
          endTime: null,
          maxPerWallet: null,
          allowlistCount: null,
        },
      ])}, 1000, now())`
    const chain = new FakeChain(lastBlock(logs) + 5n)
    for (const l of logs) chain.add(l)
    supplyFrom(chain, INKVERSE, 1_000n)
    const idx = await start(chain, logs)
    await idx.trigger()
    const starts = (await mintEvents())
      .map((e) => e.payload)
      .filter((e) => e.kind === "stage_start")
    expect(starts.map((e) => e.stageLabel)).toEqual(["Early", "Open", "Open"])

    // No mint stats: no milestones and no stage rows.
    await sql`truncate indexer.events, indexer.nft_stages, indexer.nft_mints, indexer.nft_seadrop_mints, indexer.nft_collections, indexer.cursors, indexer.recent_blocks`
    const bare = new FakeChain(lastBlock(logs) + 5n)
    for (const l of logs) bare.add(l)
    const idx2 = await start(bare, logs)
    await idx2.trigger()
    expect(await mintEvents()).toEqual([])
    expect((await sql`select 1 from indexer.nft_stages`).length).toBe(0)
    const [c] =
      await sql`select last_mark_bps, max_supply from indexer.nft_collections where contract = ${INKVERSE}`
    expect(c).toMatchObject({ last_mark_bps: 0, max_supply: null })
  })

  it("one log that starts a stage, crosses every mark and sells out keeps all five events", async () => {
    // The recording's first mint transaction, whose supply is the whole collection.
    const all = loadNftFixture("inkverse-mints")
    const at = firstBlock(all.filter((l) => mintsIn(l) > 0n))
    const logs = all.filter((l) => l.blockNumber === at)
    const supply = logs.reduce((n, l) => n + mintsIn(l), 0n)
    const chain = new FakeChain(at + 5n)
    for (const l of logs) chain.add(l)
    supplyFrom(chain, INKVERSE, supply)
    const idx = await start(chain, logs)
    await idx.trigger()

    const rows = await sql<{ sub: string; tx_hash: string; log_index: number }[]>`
      select sub, tx_hash, log_index from indexer.events where type = 'nft.mint' order by id`
    expect(rows.map((r) => r.sub)).toEqual([
      "mint:stage_start:1",
      "mint:progress:2500",
      "mint:progress:5000",
      "mint:progress:7500",
      "mint:sold_out:0",
    ])
    // All five sit on the same log, told apart by `sub` alone.
    expect(new Set(rows.map((r) => `${r.tx_hash}:${r.log_index}`)).size).toBe(1)
  })

  it("one batch holding the whole recording stores every milestone with its own sub", async () => {
    const logs = loadNftFixture("inkverse-mints")
    const chain = new FakeChain(lastBlock(logs) + 5n)
    chain.maxSpan = 1_000_000n
    for (const l of logs) chain.add(l)
    supplyFrom(chain, INKVERSE, 1_000n)
    const idx = await start(chain, logs)
    await idx.trigger()
    // Every filter was asked for the same single range.
    expect(new Set(chain.getLogsCalls.map((c) => c.join())).size).toBe(1)

    const rows = await sql<{ sub: string; tx_hash: string; log_index: number }[]>`
      select sub, tx_hash, log_index from indexer.events where type = 'nft.mint' order by id`
    expect(rows.map((r) => r.sub).sort()).toEqual(
      [
        "mint:stage_start:1",
        "mint:stage_start:2",
        "mint:stage_start:3",
        "mint:progress:2500",
        "mint:progress:5000",
        "mint:progress:7500",
        "mint:sold_out:0",
      ].sort(),
    )
    // The marks and the sell-out share the batch's last mint log.
    const shared = rows.filter((r) => !r.sub.startsWith("mint:stage_start"))
    expect(new Set(shared.map((r) => `${r.tx_hash}:${r.log_index}`)).size).toBe(1)
  })

  it("announces each milestone once after mint stats start to answer", async () => {
    const logs = loadNftFixture("inkverse-mints")
    const mintBlocks = blocksOf(logs.filter((l) => mintsIn(l) > 0n))
    const half = mintBlocks[300]!
    const chain = new FakeChain(half)
    for (const l of logs) chain.add(l)
    const idx = await start(chain, logs)
    // Without stats nothing is announced and no stage is recorded.
    await idx.trigger()
    expect(await mintEvents()).toEqual([])
    expect((await sql`select 1 from indexer.nft_stages`).length).toBe(0)

    supplyFrom(chain, INKVERSE, 1_000n)
    chain.head = lastBlock(logs) + 5n
    await idx.trigger()
    const subs = (await mintEvents()).map((e) => e.sub)
    expect(new Set(subs).size).toBe(subs.length)
    for (const k of [
      "mint:progress:2500",
      "mint:progress:5000",
      "mint:progress:7500",
      "mint:sold_out:0",
    ])
      expect(subs.filter((x) => x === k)).toHaveLength(1)
    // Every stage seen after the switch is announced once and stored once.
    const stored = (await sql`select stage_index from indexer.nft_stages`).map((r) => r.stage_index)
    expect(subs.filter((x) => x.startsWith("mint:stage_start:")).sort()).toEqual(
      stored.map((i) => `mint:stage_start:${i}`).sort(),
    )
    expect(stored.length).toBeGreaterThan(0)
  })

  it("rollback below the 75% mark recomputes last_mark_bps to 5000 and re-emits 75% on replay", async () => {
    // The first 200 mints of the recording. The collection is "sold out" at its last mint.
    const all = compactInkverse()
    let mints = 0n
    const cutoff = blocksOf(all).find((b) => {
      for (const l of all) if (l.blockNumber === b) mints += mintsIn(l)
      return mints >= 200n
    })!
    const logs = all.filter((l) => l.blockNumber <= cutoff)

    const chain = new FakeChain(lastBlock(logs) + 5n)
    chain.maxSpan = 4n
    for (const l of logs) chain.add(l)
    supplyFrom(chain, INKVERSE, mints)
    const idx = await start(chain, logs)
    await idx.trigger()

    const before = await mintEvents()
    const mark = (k: string) => before.find((e) => e.sub === k)!
    expect(before.map((e) => e.payload.markBps).filter((m) => m !== null)).toEqual([
      2500, 5000, 7500,
    ])
    const fork = mark("mint:progress:7500").block
    expect(mark("mint:progress:5000").block).toBeLessThan(fork)
    expect(mark("mint:sold_out:0")).toBeDefined()

    const removed = logs.filter((l) => l.blockNumber >= fork)
    chain.reorg(fork)
    await idx.trigger()
    const [mid] =
      await sql`select last_mark_bps, sold_out_block from indexer.nft_collections where contract = ${INKVERSE}`
    expect(mid).toMatchObject({ last_mark_bps: 5000, sold_out_block: null })
    expect((await mintEvents()).map((e) => e.sub)).not.toContain("mint:progress:7500")
    expect((await mintEvents()).map((e) => e.sub)).toContain("mint:progress:5000")

    // The same mints land again on another fork.
    chain.reorg(fork)
    for (const l of removed) chain.add(l)
    await idx.trigger()
    const after = await mintEvents()
    expect(after.map((e) => e.sub).sort()).toEqual(before.map((e) => e.sub).sort())
    const [end] =
      await sql`select last_mark_bps, sold_out_block from indexer.nft_collections where contract = ${INKVERSE}`
    expect(end!.last_mark_bps).toBe(7500)
    expect(end!.sold_out_block).not.toBeNull()
  })

  it("a stage above the fork is forgotten and starts again on replay", async () => {
    // The first mint block (stage 1), then a later stretch of mints that starts on stage 3.
    const all = compactInkverse()
    const mintBlocks = blocksOf(all.filter((l) => mintsIn(l) > 0n))
    const keep = new Set([mintBlocks[0]!, ...mintBlocks.slice(300, 340)])
    const logs = all.filter((l) => keep.has(l.blockNumber))
    const chain = new FakeChain(lastBlock(logs) + 5n)
    for (const l of logs) chain.add(l)
    supplyFrom(chain, INKVERSE, 1_000n)
    const idx = await start(chain, logs)
    await idx.trigger()
    const stageIndexes = async () =>
      (await sql`select stage_index from indexer.nft_stages order by stage_index`).map(
        (r) => r.stage_index,
      )
    expect(await stageIndexes()).toEqual([1, 3])
    const fork = BigInt(
      (await sql`select first_block from indexer.nft_stages where stage_index = 3`)[0]!.first_block,
    )

    const removed = logs.filter((l) => l.blockNumber >= fork)
    chain.reorg(fork)
    await idx.trigger()
    expect(await stageIndexes()).toEqual([1])
    expect((await mintEvents()).map((e) => e.sub)).not.toContain("mint:stage_start:3")

    chain.reorg(fork)
    for (const l of removed) chain.add(l)
    await idx.trigger()
    expect(await stageIndexes()).toEqual([1, 3])
    const subs = (await mintEvents()).map((e) => e.sub)
    expect(subs.filter((k) => k === "mint:stage_start:3")).toHaveLength(1)
  })
})
