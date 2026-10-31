import type { Sql } from "@ink-indexer/db"
import { INKYPUMP_START_BLOCK } from "@ink-indexer/sdk"
import type { Chain } from "./chain"
import { DEFAULT_IPFS_GATEWAY } from "./ipfs"
import type { Logger } from "./log"
import {
  BLOCK_S,
  DEFAULT_OPENSEA_MIN_INTERVAL_MS,
  DEFAULT_OPENSEA_REQUESTS_PER_HOUR,
  SCHEDULER_TICK_MS,
  TRACKED_SLUGS_EVERY_MS,
  TRANSIENT_RETRY_MS,
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
import type { BackfillSource } from "./sources/source"
import { CURSOR_ROW, type Store } from "./store"

type Env = Record<string, string | undefined>

/**
 * The platforms `INDEXER_SOURCES` names: the backfill groups each one reads, and whether it needs
 * the OpenSea API and Stream services. A new launchpad adds a row.
 */
const PLATFORMS = {
  inkypump: { groups: ["inkypump", "v4-swaps"], openSea: false },
  opensea: { groups: ["nft-mints", "nft-sales"], openSea: true },
  chimera: { groups: ["nft-launches"], openSea: false },
} as const satisfies Record<string, { groups: readonly BackfillSource[]; openSea: boolean }>
type Platform = keyof typeof PLATFORMS

export type SourceSelection = {
  names: Platform[]
  /** The filter groups of the enabled platforms, for `Indexer`'s `only`. */
  groups: BackfillSource[]
  /** Whether `startNftServices` runs. */
  openSea: boolean
}

/**
 * Reads `INDEXER_SOURCES`, a comma-separated list of platform names (trimmed, case-sensitive).
 * Unset or blank enables every platform. An unknown name, a duplicate or an empty entry throws,
 * naming the value and the allowed names. Logs what runs.
 */
export function readSources(env: Env, log: Logger): SourceSelection {
  const allowed = Object.keys(PLATFORMS) as Platform[]
  const raw = env.INDEXER_SOURCES?.trim()
  const names: Platform[] = []
  for (const name of raw ? raw.split(",").map((s) => s.trim()) : allowed) {
    const known = allowed.find((p) => p === name)
    if (name === "")
      throw new Error(`INDEXER_SOURCES: empty entry (expected ${allowed.join(", ")})`)
    if (!known)
      throw new Error(`INDEXER_SOURCES: unknown platform: ${name} (expected ${allowed.join(", ")})`)
    if (names.includes(known)) throw new Error(`INDEXER_SOURCES: duplicate platform: ${name}`)
    names.push(known)
  }
  log("info", "sources", { running: names })
  return {
    names,
    groups: names.flatMap((n) => PLATFORMS[n].groups),
    openSea: names.some((n) => PLATFORMS[n].openSea),
  }
}

export type NftSettings = {
  /** Undefined: the OpenSea part is off. */
  key: string | undefined
  perHour: number
  /** Minimum time between two OpenSea requests on the key. */
  minIntervalMs: number
  /** Undefined: read from the stored mints (see `resolveHistoryStart`). */
  historyStartBlock: bigint | undefined
  /**
   * Settings whose value was not valid, why, and the default used instead. Never the value: a key
   * pasted into the wrong variable would end up in the logs.
   */
  invalid: { variable: string; reason: string; using: number | null }[]
}

/**
 * Reads `OPENSEA_API_KEY`, `OPENSEA_REQUESTS_PER_HOUR`, `OPENSEA_MIN_INTERVAL_MS` and
 * `NFT_HISTORY_START_BLOCK`. Empty means unset. These are optional, so an invalid value never
 * stops the process: it is listed in `invalid` and its default is used.
 */
export function parseNftEnv(env: Env): NftSettings {
  const invalid: NftSettings["invalid"] = []
  const raw = (name: string) => env[name]?.trim() || undefined
  /** A whole number in [min, max], or the default (listed as invalid) for anything else. */
  const int = (name: string, fallback: number, min: number, max: number) => {
    const v = raw(name)
    if (v === undefined) return fallback
    const n = /^\d+$/.test(v) ? Number(v) : Number.NaN
    if (n >= min && n <= max) return n
    invalid.push({
      variable: name,
      reason: `not a whole number from ${min} to ${max}`,
      using: fallback,
    })
    return fallback
  }
  const perHour = int(
    "OPENSEA_REQUESTS_PER_HOUR",
    DEFAULT_OPENSEA_REQUESTS_PER_HOUR,
    1,
    2 ** 31 - 1,
  )
  const minIntervalMs = int(
    "OPENSEA_MIN_INTERVAL_MS",
    DEFAULT_OPENSEA_MIN_INTERVAL_MS,
    0,
    3_600_000,
  )
  const start = raw("NFT_HISTORY_START_BLOCK")
  let historyStartBlock: bigint | undefined
  if (start !== undefined) {
    if (/^\d+$/.test(start)) historyStartBlock = BigInt(start)
    else
      invalid.push({
        variable: "NFT_HISTORY_START_BLOCK",
        reason: "not a block number",
        using: null,
      })
  }
  return { key: raw("OPENSEA_API_KEY"), perHour, minIntervalMs, historyStartBlock, invalid }
}

/** `parseNftEnv`, logging one warning per invalid setting: its name, the reason and the default, never its value. */
export function readNftSettings(env: Env, log: Logger): NftSettings {
  const settings = parseNftEnv(env)
  for (const fields of settings.invalid) log("warn", "invalid NFT setting ignored", fields)
  return settings
}

/** The longest `TICK_MIN_INTERVAL_MS`, well under the stall watchdog's 5 minutes. */
const MAX_TICK_MIN_INTERVAL_MS = 60_000

/**
 * `TICK_MIN_INTERVAL_MS`: the least time between the starts of two live ticks, a whole number from
 * 0 to 60000 (default 0, no minimum). An invalid value logs one warning, never the value, and uses 0.
 */
export function readTickMinIntervalMs(env: Env, log: Logger): number {
  const v = env.TICK_MIN_INTERVAL_MS?.trim()
  if (!v) return 0
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN
  if (n <= MAX_TICK_MIN_INTERVAL_MS) return n
  log("warn", "invalid setting ignored", {
    variable: "TICK_MIN_INTERVAL_MS",
    reason: `not a whole number from 0 to ${MAX_TICK_MIN_INTERVAL_MS}`,
    using: 0,
  })
  return 0
}

/**
 * `IPFS_GATEWAY`: the HTTPS origin that serves ink.fun token metadata and images. Empty uses the
 * default gateway. A value that is not an `https://` origin logs one warning, never the value, and
 * uses the default.
 */
export function readIpfsSettings(env: Env, log: Logger): { gateway: string } {
  const v = env.IPFS_GATEWAY?.trim()
  if (!v) return { gateway: DEFAULT_IPFS_GATEWAY }
  const origin = (() => {
    try {
      const u = new URL(v)
      const bare =
        u.protocol === "https:" &&
        u.pathname === "/" &&
        !u.search &&
        !u.hash &&
        !u.username &&
        !u.password
      return bare ? u.origin : null
    } catch {
      return null
    }
  })()
  if (origin !== null) return { gateway: origin }
  log("warn", "invalid setting ignored", {
    variable: "IPFS_GATEWAY",
    reason: "not an https:// origin",
    using: DEFAULT_IPFS_GATEWAY,
  })
  return { gateway: DEFAULT_IPFS_GATEWAY }
}

/** The one line logged when the live loop is running. */
export function logStarted(
  log: Logger,
  fields: { transports: unknown; tickMinIntervalMs: number },
) {
  log("info", "indexer started", fields)
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
  log?: Logger,
): Promise<{ block: bigint; ts: number }> {
  const timeOf = async (n: bigint) => {
    const b = await chain.getBlock(n)
    if (!b) throw new Error(`block ${n} not served; the NFT history start cannot be dated`)
    return Number(b.timestamp)
  }
  if (configured !== undefined) {
    const b = await chain.getBlock(configured).catch(() => null)
    if (b) return { block: configured, ts: Number(b.timestamp) }
    log?.("warn", "NFT_HISTORY_START_BLOCK cannot be dated; using the stored history")
  }
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
  /** From `NFT_HISTORY_START_BLOCK`; undefined uses the stored history. */
  historyStartBlock: bigint | undefined
  sql: Sql
  store: Store
  chain: Chain
  log: Logger
  now?: () => number
}

/** The verdict job with its history start resolved (also what `nft:mark` runs). */
export async function createNftVerdictJob(deps: VerdictJobDeps): Promise<Job> {
  const { sql, store, chain, log, now } = deps
  const history = await resolveHistoryStart(sql, chain, deps.historyStartBlock, log)
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
 * The verdict job, built on the first tick that can date the history start. Until then it has
 * nothing due; a failed read is logged and tried again after `TRANSIENT_RETRY_MS`, so a node that is
 * down at startup does not stop the chain loop or the other jobs.
 */
function startVerdictJob(deps: VerdictJobDeps): Job {
  const now = deps.now ?? Date.now
  let job: Job | undefined
  let retryAt = 0
  return {
    name: "nft-verdict",
    everyMs: SCHEDULER_TICK_MS,
    async due(sql, at) {
      if (!job) {
        if (now() < retryAt) return []
        try {
          job = await createNftVerdictJob(deps)
        } catch (err) {
          retryAt = now() + TRANSIENT_RETRY_MS
          deps.log("warn", "nft verdict job not started", { error: String(err) })
          return []
        }
      }
      return job.due(sql, at)
    },
    run: (contract) => job!.run(contract),
  }
}

/**
 * Starts what runs beside the chain loop under `start`: the daily NFT prune and, with an OpenSea
 * key, the request budget, the scheduler (discovery, metadata, drops, scheduled stage starts,
 * verdict, traits, tiers and stats) and the Stream with its tracked collections. Without a key
 * only the prune runs, after one warning. An invalid setting is warned about and replaced by its
 * default. `stop` ends all of it; call it before stopping the chain loop.
 */
export async function startNftServices(
  deps: Omit<VerdictJobDeps, "historyStartBlock"> & {
    env: Env
    report: (err: unknown) => void
    fetch?: typeof fetch
    socket?: (url: string) => WebSocketLike
    tickMs?: number
  },
): Promise<{ stop(): void }> {
  const { sql, store, log, report, now } = deps
  const settings = readNftSettings(deps.env, log)
  // Stopped last-started first: the slug timer and the Stream, then the scheduler, then the prune.
  const stops: (() => void)[] = []
  const stop = () => {
    for (const s of stops.splice(0).reverse()) s()
  }
  stops.push(startPrune({ sql, log, report, now }))

  const { key, perHour, minIntervalMs } = settings
  if (key === undefined) {
    log(
      "warn",
      "OPENSEA_API_KEY is not set: OpenSea collections, drops, stats and listings are off",
    )
    return { stop }
  }
  try {
    await sql`select indexer.opensea_configure(${perHour}, ${minIntervalMs})`
    const verdict = startVerdictJob({ ...deps, historyStartBlock: settings.historyStartBlock })
    const budget = createBudget(sql)
    const rest = createOpenSeaRest({ key, budget, fetch: deps.fetch, log, report, now })
    const snapshots = createSnapshots({ sql, store, now })
    const accounts = createAccounts({ sql, rest, now })
    const jobDeps = { sql, store, rest, snapshots, accounts, log, now }
    const stats = createStats({ sql, store, rest, log, now })
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
    log("info", "opensea started", { requestsPerHour: perHour, minIntervalMs })
  } catch (err) {
    stop()
    throw err
  }
  return { stop }
}

/** `startNftServices` when `opensea` is enabled; otherwise nothing starts. */
export async function startSourceServices(
  sources: SourceSelection,
  deps: Parameters<typeof startNftServices>[0],
): Promise<{ stop(): void }> {
  return sources.openSea ? startNftServices(deps) : { stop() {} }
}
