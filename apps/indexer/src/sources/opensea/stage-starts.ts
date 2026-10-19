import type { Sql } from "@ink-indexer/db"
import { type NftDropStage, type NftMintEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import type { Address } from "viem"
import type { Store } from "../../store"
import { SCHEDULED_FIRST_BLOCK } from "../nft/milestones"
import {
  JOBS_PER_TICK,
  STAGE_START_EVERY_MS,
  STAGE_START_WINDOW_MS,
  SYNTHETIC_STAGE_INDEX,
} from "../nft/policy"
import type { Job } from "./scheduler"

/** A stage row as `nft_stages` holds it: its index and the unix second of its first mint (or scheduled start). */
type KnownStage = { index: number; ts: number }

const isPublic = (s: NftDropStage) => /^public/.test(s.type)

/**
 * The stages of a drop that start now and have not been announced.
 *
 * A stage starts when `now` has reached its start time and that was less than ten minutes ago, so
 * a drop found already under way is not announced late. Its index is the one SeaDrop gives the
 * public stage (0) or, for any other stage, `SYNTHETIC_STAGE_INDEX` plus its place in the order of
 * starts, because the on-chain index of a signed stage is only learned from its first mint. A stage
 * counts as announced when `nft_stages` has its index, or has a stage whose time falls in its window
 * (from its start to its end or the next stage's start, whichever is first): its first mint came
 * first, under whatever index the chain gave it.
 */
export function startingStages(
  stages: NftDropStage[],
  known: KnownStage[],
  nowMs: number,
): { index: number; stage: NftDropStage }[] {
  const ordered = [...stages].sort((a, b) => a.startTime - b.startTime)
  const out: { index: number; stage: NftDropStage }[] = []
  const used = new Set(known.map((k) => k.index))
  ordered.forEach((stage, position) => {
    const startMs = stage.startTime * 1000
    if (startMs > nowMs || startMs <= nowMs - STAGE_START_WINDOW_MS) return
    const index = isPublic(stage) ? 0 : SYNTHETIC_STAGE_INDEX + position
    const end = Math.min(
      stage.endTime ?? Number.POSITIVE_INFINITY,
      ordered[position + 1]?.startTime ?? Number.POSITIVE_INFINITY,
    )
    const inWindow = known.some((k) => k.ts >= stage.startTime && k.ts < end)
    if (used.has(index) || inWindow) return
    used.add(index)
    out.push({ index, stage })
  })
  return out
}

/** A stage row for the same index was written between the plan and the write. */
class StageRaced extends Error {
  constructor(contract: string) {
    super(`a stage of ${contract} was recorded while its start was being written`)
  }
}

type DropRow = { stages: NftDropStage[]; max_supply: string | null }

async function plan(sql: Sql, contract: string, nowMs: number) {
  const [drop] = await sql<DropRow[]>`
    select stages, max_supply::text as max_supply from indexer.nft_drops where contract = ${contract}`
  if (!drop) return null
  const known = (
    await sql<{ stage_index: number; ts: string }[]>`
      select stage_index, extract(epoch from first_ts)::bigint as ts
      from indexer.nft_stages where contract = ${contract}`
  ).map((r) => ({ index: r.stage_index, ts: Number(r.ts) }))
  const starting = startingStages(drop.stages, known, nowMs)
  return starting.length > 0 ? { drop, starting } : null
}

/**
 * Announces each stage of a stored drop when it starts: an `nft.mint` `stage_start` event at the
 * stage's scheduled start (`blockTimestamp`), without waiting for its first mint. Every 30 seconds
 * it looks at the drops that have a stage starting now.
 *
 * The event is `nft:stage:<contract>:<index>` with `sub` `mint:stage_start:<index>`, and the stage's
 * `nft_stages` row goes in with it (first block 0, first time = the scheduled start), so the first
 * mint of the stage, which looks the row up, announces nothing. See `startingStages` for the index.
 *
 * shortcut: `minted` is the sum of the stored mints (or the supply of the latest `nft.mint` event),
 * which is the supply before the stage starts to within a mint or two, and `mintStartTs` is the
 * first scheduled start, not the first mint. A stage that never starts on schedule (the drop page
 * changed after it was stored) is announced by its first mint as before.
 */
export function createStageStartsJob(deps: { sql: Sql; store: Store; now?: () => number }): Job {
  const { sql, store } = deps
  const now = deps.now ?? Date.now

  return {
    name: "stage-starts",
    everyMs: STAGE_START_EVERY_MS,
    async due(sql, at) {
      const nowS = Math.floor(at.getTime() / 1000)
      const candidates = await sql<{ contract: string }[]>`
        select d.contract from indexer.nft_drops d
        where exists (
          select 1 from jsonb_array_elements(d.stages) s
          where (s->>'startTime')::bigint <= ${nowS}
            and (s->>'startTime')::bigint > ${nowS - STAGE_START_WINDOW_MS / 1000})
        order by d.contract`
      const due: string[] = []
      for (const { contract } of candidates) {
        if (due.length >= JOBS_PER_TICK) break
        if (await plan(sql, contract, at.getTime())) due.push(contract)
      }
      return due
    },
    async run(contract) {
      const planned = await plan(sql, contract, now())
      if (!planned) return
      const { drop, starting } = planned
      const [counts] = await sql<
        { minted: string; minters: number; first_ts: Date | null; max_supply: string | null }[]
      >`
        select
          coalesce(
            (select e.payload->>'minted' from indexer.events e
              where e.type = 'nft.mint' and e.entity = ${contract} order by e.id desc limit 1),
            (select sum(qty)::text from indexer.nft_mints where contract = ${contract}),
            '0') as minted,
          (select count(distinct recipient)::int from indexer.nft_mints where contract = ${contract}) as minters,
          c.first_mint_ts as first_ts,
          c.max_supply::text as max_supply
        from indexer.nft_collections c where c.contract = ${contract}`
      const firstStart = Math.min(
        ...drop.stages.map((s) => s.startTime),
        ...(counts?.first_ts ? [Math.floor(counts.first_ts.getTime() / 1000)] : []),
      )
      const maxSupply = drop.max_supply ?? counts?.max_supply ?? "0"

      const rows = starting.map(({ index, stage }) => {
        const event: NftMintEvent = {
          v: SCHEMA_VERSION,
          chainId: 57073,
          contract: contract as Address,
          source: "opensea",
          txHash: `nft:stage:${contract}:${index}`,
          logIndex: 0,
          blockNumber: "0",
          blockTimestamp: stage.startTime,
          type: "nft.mint",
          kind: "stage_start",
          stageIndex: index,
          stageLabel: stage.label,
          stagePriceWei: stage.priceWei,
          markBps: null,
          minted: counts?.minted ?? "0",
          maxSupply,
          mintStartTs: firstStart,
          stageStartTs: stage.startTime,
          minters: counts?.minters ?? 0,
        }
        return { event, sub: `mint:stage_start:${index}` }
      })
      try {
        await store.writeOffchain(rows, async (tx) => {
          const stored = await tx`
            insert into indexer.nft_stages (contract, stage_index, first_block, first_ts)
            select * from unnest(
              ${tx.array(starting.map(() => contract))}::text[],
              ${tx.array(starting.map((s) => s.index))}::int[],
              ${tx.array(starting.map(() => SCHEDULED_FIRST_BLOCK))}::bigint[],
              ${tx.array(starting.map((s) => new Date(s.stage.startTime * 1000).toISOString()))}::timestamptz[])
            on conflict do nothing returning 1`
          if (stored.length !== starting.length) throw new StageRaced(contract)
        })
      } catch (err) {
        // The first mint got there first: nothing was written, and the next look finds the row.
        if (!(err instanceof StageRaced)) throw err
      }
    },
  }
}
