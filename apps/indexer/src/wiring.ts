import type { Sql } from "@ink-indexer/db"
import { INKYPUMP_START_BLOCK } from "@ink-indexer/sdk"
import type { Chain } from "./chain"
import type { Logger } from "./log"
import {
  BLOCK_S,
  DEFAULT_OPENSEA_REQUESTS_PER_HOUR,
  TRACKED_SLUGS_EVERY_MS,
} from "./sources/nft/policy"
import { startPrune } from "./sources/nft/prune"
import { createVerdictJob } from "./sources/nft/verdict"
import { createAccounts } from "./sources/opensea/accounts"
import { createBudget } from "./sources/opensea/budget"
import { createDiscoveryJob, createMetadataJob } from "./sources/opensea/discovery"
import { createDropsJob } from "./sources/opensea/drops"
import { createListings } from "./sources/opensea/listings"
import { createRanks } from "./sources/opensea/ranks"
import { createOpenSeaRest } from "./sources/opensea/rest"
import { type Job, startScheduler } from "./sources/opensea/scheduler"
import { createSnapshots } from "./sources/opensea/snapshot"
import { createStageStartsJob } from "./sources/opensea/stage-starts"
import { createStats } from "./sources/opensea/stats"
import { createStream, trackedSlugs, type WebSocketLike } from "./sources/opensea/stream"
import { createTraitsJob } from "./sources/opensea/traits"
import { CURSOR_ROW, type Store } from "./store"

type Env = Record<string, string | undefined>

export type NftSettings =
  | {
      ok: true
      /** Undefined: the OpenSea part is off. */
      key: string | undefined
      perHour: number
      /** Undefined: read from the stored mints (see `resolveHistoryStart`). */
      historyStartBlock: bigint | undefined
    }
  | { ok: false; reason: string }

/** Reads `OPENSEA_API_KEY`, `OPENSEA_REQUESTS_PER_HOUR` and `NFT_HISTORY_START_BLOCK`. Empty means unset. */
export function parseNftEnv(env: Env): NftSettings {
  const key = env.OPENSEA_API_KEY?.trim() || undefined
  const perHourRaw = env.OPENSEA_REQUESTS_PER_HOUR?.trim() || undefined
  const startRaw = env.NFT_HISTORY_START_BLOCK?.trim() || undefined
  let perHour = DEFAULT_OPENSEA_REQUESTS_PER_HOUR
  if (perHourRaw !== undefined) {
    perHour = /^\d+$/.test(perHourRaw) ? Number(perHourRaw) : 0
    if (perHour <= 0 || perHour > 2 ** 31 - 1)
      return { ok: false, reason: "OPENSEA_REQUESTS_PER_HOUR must be a positive integer" }
  }
  if (startRaw !== undefined && !/^\d+$/.test(startRaw))
    return { ok: false, reason: "NFT_HISTORY_START_BLOCK must be a block number" }
  return {
    ok: true,
    key,
    perHour,
    historyStartBlock: startRaw === undefined ? undefined : BigInt(startRaw),
  }
}

/**
 * Where the mint history starts, for `legacy`: the configured block; else the first stored mint
 * (the earliest `first_mint_block` of a collection, which outlives the pruned mint rows, or the
 * earliest `nft_mints` row), dated by its collection row or the chain; else, with no mint stored,
 * the block after the chain cursor (or the loop's first block on a fresh database).
 */
export async function resolveHistoryStart(
  sql: Sql,
  chain: Pick<Chain, "getBlock">,
  configured: bigint | undefined,
): Promise<{ block: bigint; ts: number }> {
  const timeOf = async (n: bigint) => {
    const b = await chain.getBlock(n)
    if (!b) throw new Error(`block ${n} not served; the NFT history start cannot be dated`)
    return Number(b.timestamp)
  }
  if (configured !== undefined) return { block: configured, ts: await timeOf(configured) }
  const [first] = await sql<{ block: string | null; ts: string | null }[]>`
    with f as (
      select least(
        (select min(first_mint_block) from indexer.nft_collections),
        (select min(block) from indexer.nft_mints)) as block)
    select f.block::text as block,
      (select extract(epoch from c.first_mint_ts)::bigint::text from indexer.nft_collections c
        where c.first_mint_block = f.block and c.first_mint_ts is not null limit 1) as ts
    from f`
  if (first?.block) {
    const block = BigInt(first.block)
    return { block, ts: first.ts === null ? await timeOf(block) : Number(first.ts) }
  }
  const [cursor] = await sql<{ block: string }[]>`
    select block::text as block from indexer.cursors where source = ${CURSOR_ROW}`
  if (!cursor) return { block: INKYPUMP_START_BLOCK, ts: await timeOf(INKYPUMP_START_BLOCK) }
  // The next block may not exist yet: date it from the cursor block.
  const at = BigInt(cursor.block)
  return { block: at + 1n, ts: (await timeOf(at)) + BLOCK_S }
}

type VerdictJobDeps = {
  env: Env
  sql: Sql
  store: Store
  chain: Chain
  log: Logger
  now?: () => number
}

/** The verdict job with its history start resolved (also what `nft:mark` runs). */
export async function createNftVerdictJob(deps: VerdictJobDeps): Promise<Job> {
  const { sql, store, chain, log, now } = deps
  const settings = parseNftEnv(deps.env)
  if (!settings.ok) throw new Error(settings.reason)
  const history = await resolveHistoryStart(sql, chain, settings.historyStartBlock)
  log("info", "nft history start", { block: history.block, ts: history.ts })
  return createVerdictJob({
    sql,
    store,
    snapshots: createSnapshots({ sql, store, now }),
    chain,
    historyStartTs: history.ts,
    historyStartBlock: history.block,
    log,
    now,
  })
}

/**
 * Starts what runs beside the chain loop under `start`: the daily NFT prune and, with an OpenSea
 * key, the request budget, the scheduler (discovery, metadata, drops, scheduled stage starts,
 * verdict, traits, tiers and stats) and the Stream with its tracked collections. Without a key
 * only the prune runs, after one warning. A bad setting rejects before anything starts. `stop`
 * ends all of it; call it before stopping the chain loop.
 */
export async function startNftServices(
  deps: VerdictJobDeps & {
    report: (err: unknown) => void
    fetch?: typeof fetch
    socket?: (url: string) => WebSocketLike
    tickMs?: number
  },
): Promise<{ stop(): void }> {
  const { sql, store, chain, log, report, now } = deps
  const settings = parseNftEnv(deps.env)
  if (!settings.ok) throw new Error(settings.reason)
  // Stopped last-started first: the slug timer and the Stream, then the scheduler, then the prune.
  const stops: (() => void)[] = []
  const stop = () => {
    for (const s of stops.splice(0).reverse()) s()
  }
  stops.push(startPrune({ sql, log, report, now }))

  const { key, perHour } = settings
  if (key === undefined) {
    log(
      "warn",
      "OPENSEA_API_KEY is not set: OpenSea collections, drops, stats and listings are off",
    )
    return { stop }
  }
  try {
    await sql`select indexer.opensea_configure(${perHour})`
    const verdict = await createNftVerdictJob(deps)
    const budget = createBudget(sql)
    const rest = createOpenSeaRest({ key, budget, fetch: deps.fetch, log, report, now })
    const snapshots = createSnapshots({ sql, store, now })
    const accounts = createAccounts({ sql, rest, now })
    const jobDeps = { sql, store, rest, snapshots, accounts, log, now }
    const stats = createStats({ sql, store, rest, chain, log, now })
    const ranks = createRanks({ sql, rest, log, now })
    const listings = createListings({ sql, store, stats, ranks, log, report, now })

    const jobs: Job[] = [
      createDiscoveryJob(jobDeps),
      createMetadataJob(jobDeps),
      createDropsJob(jobDeps),
      createStageStartsJob({ sql, store, now }),
      verdict,
      createTraitsJob(jobDeps),
      stats.tierJob,
      stats.job,
    ]
    stops.push(startScheduler(jobs, { sql, log, report, now, tickMs: deps.tickMs }))

    const stream = createStream({
      key,
      socket: deps.socket,
      onEvent: (e) => void listings.handleStreamEvent(e),
      log,
      report,
      now,
    })
    let streaming = true
    stops.push(() => {
      streaming = false
      stream.stop()
    })
    const refreshSlugs = async () => {
      try {
        const slugs = await trackedSlugs(sql)
        if (streaming) stream.setSlugs(slugs)
      } catch (err) {
        if (streaming) log("warn", "tracked collections not read", { error: String(err) })
      }
    }
    void refreshSlugs()
    const slugTimer = setInterval(() => void refreshSlugs(), TRACKED_SLUGS_EVERY_MS)
    slugTimer.unref()
    stops.push(() => clearInterval(slugTimer))
    log("info", "opensea started", { requestsPerHour: perHour })
  } catch (err) {
    stop()
    throw err
  }
  return { stop }
}
