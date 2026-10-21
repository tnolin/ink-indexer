import type { Sql } from "@ink-indexer/db"
import type { Logger } from "../../log"
import { CURSOR_ROW } from "../../store"
import {
  BLOCK_S,
  MINTS_RETENTION_S,
  PRUNE_AT_UTC,
  RANK_CACHE_MS,
  SALES_RETENTION_S,
  STATS_RETENTION_MS,
} from "./policy"

export type PruneCounts = {
  nft_mints: number
  nft_burns: number
  nft_seadrop_mints: number
  nft_sales: number
  nft_stats: number
  nft_listing_state: number
  nft_ranks: number
}

/**
 * Deletes the NFT rows past their retention and returns how many went from each table:
 * - `nft_mints`, `nft_burns` and `nft_seadrop_mints` more than 8 days of blocks below the chain
 *   cursor, and `nft_sales` more than 90 days below it (the rows carry blocks, not times; with no
 *   cursor yet they are kept);
 * - `nft_stats` polled more than 8 days ago;
 * - `nft_listing_state` rows that have expired (an expired row is replaced by the next listing
 *   anyway, so deleting it changes nothing);
 * - `nft_ranks` fetched 7 days ago or more (no longer valid).
 *
 * shortcut: each table is pruned in one statement, so the first run after a long backfill can
 * delete millions of rows at once (a daily run deletes about a day's worth). Delete in batches by
 * block if that run holds locks too long.
 *
 * shortcut: `nft_items_seen` has no retention: one row per item ever listed in a tracked collection.
 * Prune it by `seen_at`, keeping items with a recent sale, if the table grows past what is useful.
 */
export async function pruneNft(sql: Sql, now: Date): Promise<PruneCounts> {
  const [cursor] = await sql<{ block: string }[]>`
    select block::text as block from indexer.cursors where source = ${CURSOR_ROW}`
  const head = cursor ? BigInt(cursor.block) : null
  const below = async (table: string, seconds: number) => {
    if (head === null) return 0
    const cut = (head - BigInt(Math.floor(seconds / BLOCK_S))).toString()
    return (await sql`delete from ${sql(`indexer.${table}`)} where block < ${cut}::bigint`).count
  }
  const t = now.getTime()
  return {
    nft_mints: await below("nft_mints", MINTS_RETENTION_S),
    nft_burns: await below("nft_burns", MINTS_RETENTION_S),
    nft_seadrop_mints: await below("nft_seadrop_mints", MINTS_RETENTION_S),
    nft_sales: await below("nft_sales", SALES_RETENTION_S),
    nft_stats: (
      await sql`delete from indexer.nft_stats where at < ${new Date(t - STATS_RETENTION_MS)}`
    ).count,
    nft_listing_state: (await sql`delete from indexer.nft_listing_state where expires_at <= ${now}`)
      .count,
    nft_ranks: (
      await sql`delete from indexer.nft_ranks where fetched_at <= ${new Date(t - RANK_CACHE_MS)}`
    ).count,
  }
}

/** The first prune time (03:30 UTC) strictly after `nowMs`. */
export function nextPruneAt(nowMs: number): number {
  const d = new Date(nowMs)
  const today = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    PRUNE_AT_UTC.hour,
    PRUNE_AT_UTC.minute,
  )
  return today > nowMs ? today : today + 86_400_000
}

/** Runs `pruneNft` daily at 03:30 UTC until the returned function is called. A failure is logged and reported, and the next day runs as usual. */
export function startPrune(deps: {
  sql: Sql
  log: Logger
  report: (err: unknown) => void
  now?: () => number
}): () => void {
  const { sql, log, report } = deps
  const now = deps.now ?? Date.now
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  // The next run is planned from the one just due, so a timer that fires early never runs twice.
  const plan = (after: number) => {
    if (stopped) return
    const at = nextPruneAt(Math.max(now(), after))
    timer = setTimeout(() => void run(at), Math.max(0, at - now()))
    timer.unref?.()
  }
  async function run(at: number) {
    try {
      log("info", "nft prune done", await pruneNft(sql, new Date(now())))
    } catch (err) {
      log("error", "nft prune failed", {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
      try {
        report(err)
      } catch {}
    }
    plan(at)
  }

  plan(now())
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
