import type { Sql } from "@ink-indexer/db"
import { type NftDropStage, type NftMintEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import { INK_CHAIN_ID } from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../../chain"
import type { Logger } from "../../log"
import type { EventRow } from "../source"
import type { CollectionTouch, SeaDropMintRow, TransferRow } from "./index"
import { MINT_MARKS_BPS } from "./policy"

/** `nft_stages.first_block` of a stage announced from the drop schedule (see stage-starts). */
export const SCHEDULED_FIRST_BLOCK = 0

// Mint milestones of a SeaDrop collection: each stage's first mint, 25/50/75% of the max supply
// and the sell-out. `planMilestones` decides; `milestoneEvents` gathers its inputs and turns the
// drafts into event rows.

/** A collection's drop as stored in `nft_drops`. */
export type StoredDrop = {
  slug: string | null
  stages: NftDropStage[]
  maxSupply: bigint | null
}

/**
 * The name of a stage. Mints report a stage by index only, so the drop's stage whose
 * `[startTime, endTime)` holds `ts` names it. Without one: `Public` for index 0, `Stage N` otherwise.
 */
export function stageLabel(drop: StoredDrop | null, index: number, ts: number): string {
  const named = drop?.stages.find(
    (s) => s.startTime <= ts && (s.endTime === null || ts < s.endTime),
  )
  return named?.label ?? (index === 0 ? "Public" : `Stage ${index}`)
}

export type MilestoneInput = {
  contract: Address
  /** The highest mark already announced, 0 for none. */
  lastMarkBps: number
  /** The sell-out was already announced. */
  soldOut: boolean
  totalSupply: bigint
  maxSupply: bigint
  /** Stage indexes seen for the first time, in order of their first mint. */
  newStages: { index: number; block: bigint; ts: number; priceWei: bigint }[]
  /** The stage of the latest mint: the stage that progress and sell-out events report. */
  current: { index: number; priceWei: bigint }
  drop: StoredDrop | null
  /** Unix seconds. */
  mintStartTs: number
  /** Unix seconds of each known stage's first mint, new stages included. */
  stageStartTs: Map<number, number>
  minters: number
  stageCounts: { stageIndex: number; minted: bigint }[]
}

/** The payload of an `nft.mint` event, less where it sits on the chain, plus its `sub`. */
export type MilestoneDraft = Pick<
  NftMintEvent,
  | "kind"
  | "stageIndex"
  | "stageLabel"
  | "stagePriceWei"
  | "markBps"
  | "minted"
  | "maxSupply"
  | "mintStartTs"
  | "stageStartTs"
  | "minters"
  | "stageCounts"
> & {
  contract: Address
  /** Unique among the events of one log: several milestones can come from the same mint. */
  sub: string
}

/** Which milestones this reading of the supply announces. Pure. */
export function planMilestones(i: MilestoneInput): MilestoneDraft[] {
  const startOf = (index: number) => i.stageStartTs.get(index) ?? i.mintStartTs
  const common = {
    contract: i.contract,
    minted: i.totalSupply.toString(),
    maxSupply: i.maxSupply.toString(),
    mintStartTs: i.mintStartTs,
    minters: i.minters,
  }
  const drafts: MilestoneDraft[] = []
  for (const st of i.newStages)
    drafts.push({
      ...common,
      kind: "stage_start",
      sub: `mint:stage_start:${st.index}`,
      stageIndex: st.index,
      stageLabel: stageLabel(i.drop, st.index, st.ts),
      stagePriceWei: st.priceWei.toString(),
      markBps: null,
      stageStartTs: st.ts,
    })

  const now = {
    ...common,
    stageIndex: i.current.index,
    stageLabel: stageLabel(i.drop, i.current.index, startOf(i.current.index)),
    stagePriceWei: i.current.priceWei.toString(),
    stageStartTs: startOf(i.current.index),
  }
  const bps = i.maxSupply > 0n ? (i.totalSupply * 10_000n) / i.maxSupply : 0n
  for (const mark of MINT_MARKS_BPS)
    if (mark > i.lastMarkBps && bps >= BigInt(mark))
      drafts.push({ ...now, kind: "progress", sub: `mint:progress:${mark}`, markBps: mark })

  if (!i.soldOut && i.maxSupply > 0n && i.totalSupply >= i.maxSupply)
    drafts.push({
      ...now,
      kind: "sold_out",
      sub: "mint:sold_out:0",
      markBps: null,
      stageCounts: i.stageCounts.map((c) => ({
        stageIndex: c.stageIndex,
        label: stageLabel(i.drop, c.stageIndex, startOf(c.stageIndex)),
        minted: c.minted.toString(),
      })),
    })
  return drafts
}

// ---- Gathering the inputs ----

/** What the database already knows about a contract with SeaDrop mints in the batch. */
export type MilestoneContext = {
  contract: Address
  /** The batch's SeaDrop mints of this contract in chain order. */
  rows: SeaDropMintRow[]
  /** Stage index to unix seconds of its first mint, as stored. */
  knownStages: Map<number, number>
  /** Unix seconds of the stages announced from the drop's schedule rather than by a mint. */
  scheduledStarts: number[]
  lastMarkBps: number
  soldOutBlock: bigint | null
  /** Unix seconds; null when the collection has no first mint yet. */
  firstMintTs: number | null
  drop: StoredDrop | null
  /** The first mint of each stage not stored yet, in chain order. */
  newStageRows: SeaDropMintRow[]
}

export type StageRow = { contract: Address; index: number; block: bigint; ts: number }
/** What the write step stores per contract after milestones were planned. */
export type MilestoneUpdate = {
  contract: Address
  maxSupply: bigint
  lastMarkBps: number
  soldOutBlock: bigint | null
}
export type Milestones = { events: EventRow[]; stages: StageRow[]; updates: MilestoneUpdate[] }

const byChainOrder = (a: SeaDropMintRow, b: SeaDropMintRow) =>
  a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1

/**
 * Reads what the milestones of the batch's SeaDrop contracts start from.
 *
 * shortcut: the stages are read before the batch is written, so a scheduled start recorded between
 * this read and that write is not seen and its stage can be announced a second time by its first
 * mint. The reverse also holds: a first mint written between the stage-start job's plan and its
 * write is not seen by the job, and for a signed stage (synthetic index, so no key clash) the
 * stage is announced twice. Each window is one batch or one job run; closing them takes the
 * reads inside the write transactions, under the same lock.
 */
export async function loadMilestoneContexts(
  sql: Sql,
  mints: SeaDropMintRow[],
): Promise<MilestoneContext[]> {
  const byContract = new Map<Address, SeaDropMintRow[]>()
  for (const m of mints) {
    const rows = byContract.get(m.contract) ?? []
    rows.push(m)
    byContract.set(m.contract, rows)
  }
  if (byContract.size === 0) return []
  const contracts = sql.array([...byContract.keys()])

  const collections = await sql<
    {
      contract: Address
      last_mark_bps: number
      sold_out_block: string | null
      first_ts: string | null
    }[]
  >`
    select contract, last_mark_bps, sold_out_block, extract(epoch from first_mint_ts)::bigint as first_ts
    from indexer.nft_collections where contract = any(${contracts}::text[])`
  const stages = await sql<
    { contract: Address; stage_index: number; ts: string; first_block: string }[]
  >`
    select contract, stage_index, extract(epoch from first_ts)::bigint as ts, first_block::text
    from indexer.nft_stages where contract = any(${contracts}::text[])`
  const drops = await sql<
    { contract: Address; slug: string | null; stages: NftDropStage[]; max_supply: string | null }[]
  >`
    select contract, slug, stages, max_supply
    from indexer.nft_drops where contract = any(${contracts}::text[])`

  return [...byContract].map(([contract, rows]) => {
    rows.sort(byChainOrder)
    const c = collections.find((x) => x.contract === contract)
    const drop = drops.find((x) => x.contract === contract)
    const knownStages = new Map(
      stages.filter((x) => x.contract === contract).map((x) => [x.stage_index, Number(x.ts)]),
    )
    const scheduledStarts = stages
      .filter((x) => x.contract === contract && Number(x.first_block) === SCHEDULED_FIRST_BLOCK)
      .map((x) => Number(x.ts))
    const seen = new Set(knownStages.keys())
    const newStageRows = rows.filter((r) => !seen.has(r.stage) && seen.add(r.stage))
    return {
      contract,
      rows,
      knownStages,
      scheduledStarts,
      lastMarkBps: c?.last_mark_bps ?? 0,
      soldOutBlock: c?.sold_out_block != null ? BigInt(c.sold_out_block) : null,
      firstMintTs: c?.first_ts != null ? Number(c.first_ts) : null,
      drop: drop
        ? {
            slug: drop.slug,
            stages: drop.stages,
            maxSupply: drop.max_supply === null ? null : BigInt(drop.max_supply),
          }
        : null,
      newStageRows,
    }
  })
}

/**
 * The stages of a drop in order of start, each with its window `[start, end)` in unix seconds: it
 * ends at its own end time or when the next stage starts, whichever is first. This one rule decides
 * both when a scheduled start and a first mint count as the same stage (see stage-starts), so the
 * two paths cannot disagree about announced stages.
 */
export function stageWindows(
  stages: NftDropStage[],
): { stage: NftDropStage; start: number; end: number }[] {
  const ordered = [...stages].sort((a, b) => a.startTime - b.startTime)
  return ordered.map((stage, k) => ({
    stage,
    start: stage.startTime,
    end: Math.min(
      stage.endTime ?? Number.POSITIVE_INFINITY,
      ordered[k + 1]?.startTime ?? Number.POSITIVE_INFINITY,
    ),
  }))
}

/**
 * True when a stage of the stored drop that holds `ts` has a scheduled start already announced.
 * Without a stored drop nothing matches.
 */
function announcedOnSchedule(ctx: MilestoneContext, ts: number): boolean {
  const w = stageWindows(ctx.drop?.stages ?? []).find((x) => x.start <= ts && ts < x.end)
  return w !== undefined && ctx.scheduledStarts.some((t) => t >= w.start && t < w.end)
}

/** The blocks whose times `milestoneEvents` will want: each new stage's first mint, each contract's last. */
export function milestoneBlocks(contexts: MilestoneContext[]): bigint[] {
  return contexts.flatMap((c) => [...c.newStageRows.map((r) => r.block), c.rows.at(-1)!.block])
}

export type MilestoneDeps = {
  sql: Sql
  chain: Pick<Chain, "readMintStats">
  logger: Logger
}

/**
 * Reads each contract's supply once, at the end of the batch, and plans its milestones. A contract
 * that does not answer `getMintStats` gets none, and its stages stay unrecorded so they are
 * announced once it does.
 *
 * shortcut: `minted` is the supply at the end of the batch, not at the block of the milestone.
 * In live ingestion a batch is a few blocks, so they agree to a handful of mints; a backfill over
 * a long range reports the supply at the end of the range. Per-milestone supply would need one
 * historical read per milestone.
 */
export async function milestoneEvents(
  contexts: MilestoneContext[],
  deps: MilestoneDeps,
  at: {
    toBlock: bigint
    times: Map<bigint, number>
    blockHash: (block: bigint) => Hash
    mints: TransferRow[]
    collections: CollectionTouch[]
  },
): Promise<Milestones> {
  const out: Milestones = { events: [], stages: [], updates: [] }
  for (const ctx of contexts) {
    const last = ctx.rows.at(-1)!
    const stats = await deps.chain.readMintStats(ctx.contract, last.minter, at.toBlock)
    if (!stats || stats.maxSupply === 0n) {
      deps.logger("debug", "no mint stats for a SeaDrop contract; skipping its milestones", {
        contract: ctx.contract,
      })
      continue
    }
    const time = (block: bigint) => at.times.get(block)!
    const newStages = ctx.newStageRows.map((r) => ({
      index: r.stage,
      block: r.block,
      ts: time(r.block),
      priceWei: r.unitPrice,
    }))
    // A stage whose scheduled start was already announced is recorded under its on-chain index but
    // not announced again.
    const unannounced = newStages.filter((st) => !announcedOnSchedule(ctx, st.ts))
    const stageStartTs = new Map([
      ...ctx.knownStages,
      ...newStages.map((s) => [s.index, s.ts] as const),
    ])
    const batchFirst = at.collections.find((c) => c.contract === ctx.contract)?.firstMint?.ts
    const mintStartTs = Math.min(
      ...[ctx.firstMintTs, batchFirst, ...stageStartTs.values()].filter((t) => t != null),
    )
    const base: MilestoneInput = {
      contract: ctx.contract,
      lastMarkBps: ctx.lastMarkBps,
      soldOut: ctx.soldOutBlock !== null,
      totalSupply: stats.totalSupply,
      maxSupply: stats.maxSupply,
      newStages: unannounced,
      current: { index: last.stage, priceWei: last.unitPrice },
      drop: ctx.drop,
      mintStartTs,
      stageStartTs,
      minters: 0,
      stageCounts: [],
    }

    let drafts = planMilestones(base)
    if (drafts.length > 0) {
      // The counts cost a query each, so only a contract that announces something pays for them.
      const [minters, stageCounts] = await Promise.all([
        countMinters(deps.sql, ctx.contract, at.mints),
        drafts.some((d) => d.kind === "sold_out")
          ? countStages(deps.sql, ctx.contract, ctx.rows)
          : [],
      ])
      drafts = planMilestones({ ...base, minters, stageCounts })
    }

    for (const d of drafts) {
      const row =
        d.kind === "stage_start" ? ctx.newStageRows.find((r) => r.stage === d.stageIndex)! : last
      const { contract, sub, ...payload } = d
      const event: NftMintEvent = {
        v: SCHEMA_VERSION,
        chainId: INK_CHAIN_ID,
        type: "nft.mint",
        contract,
        source: "chain",
        txHash: row.txHash,
        logIndex: row.logIndex,
        blockNumber: row.block.toString(),
        blockTimestamp: time(row.block),
        ...payload,
      }
      out.events.push({ event, block: row.block, blockHash: at.blockHash(row.block), sub })
    }

    out.stages.push(...newStages.map((s) => ({ contract: ctx.contract, ...s })))
    const marks = drafts.map((d) => d.markBps ?? 0)
    out.updates.push({
      contract: ctx.contract,
      maxSupply: stats.maxSupply,
      lastMarkBps: Math.max(ctx.lastMarkBps, ...marks),
      soldOutBlock: drafts.some((d) => d.kind === "sold_out") ? last.block : ctx.soldOutBlock,
    })
  }
  return out
}

/** Distinct `nft_mints` recipients of the contract, stored rows and the batch's together, each counted once. */
async function countMinters(sql: Sql, contract: Address, batch: TransferRow[]): Promise<number> {
  const recipients = batch.filter((m) => m.contract === contract).map((m) => m.account)
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from (
      select recipient from indexer.nft_mints where contract = ${contract}
      union
      select unnest(${sql.array(recipients)}::text[])
    ) r`
  return row!.n
}

/** Mints per stage over the contract's stored SeaDrop mints and the batch's, each counted once. */
async function countStages(
  sql: Sql,
  contract: Address,
  batch: SeaDropMintRow[],
): Promise<{ stageIndex: number; minted: bigint }[]> {
  const rows = await sql<{ stage: number; minted: string }[]>`
    select stage, sum(qty)::text as minted from (
      select tx_hash, log_index, stage, qty from indexer.nft_seadrop_mints where contract = ${contract}
      union
      select * from unnest(
        ${sql.array(batch.map((m) => m.txHash))}::text[],
        ${sql.array(batch.map((m) => m.logIndex))}::int[],
        ${sql.array(batch.map((m) => m.stage))}::int[],
        ${sql.array(batch.map((m) => m.qty.toString()))}::numeric[])
    ) m group by stage order by stage`
  return rows.map((r) => ({ stageIndex: r.stage, minted: BigInt(r.minted) }))
}
