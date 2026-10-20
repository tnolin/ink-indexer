import type { Sql } from "@ink-indexer/db"
import { type NftStatsEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import { INK_CHAIN_ID, type OsStats, parseStats } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { CURSOR_ROW } from "../../store"
import {
  BLOCK_S,
  COLD_WINDOW_S,
  FLOOR_CHANGE_WINDOW_MS,
  HOT_MINT_S,
  HOT_TOP,
  JOBS_PER_TICK,
  LISTED_INTERVAL_S,
  LISTED_NOT_FOUND_GIVE_UP,
  LISTED_PAGE_SIZE,
  LISTED_PAGES,
  LISTED_RETRY_MS,
  OPENSEA_MAX_WAIT_MS,
  RANK_WINDOW_S,
  SCHEDULER_TICK_MS,
  STATS_INTERVAL_S,
  STATS_REQUEST_THROTTLE_MS,
  TIER_EVERY_MS,
  TRANSIENT_RETRY_MS,
  WARM_SIZE,
} from "../nft/policy"
import type { Tx } from "../source"
import type { OsResult } from "./rest"
import { commonOutcome, type Job, type JobOutcome, type OsJobDeps } from "./scheduler"

export type Tier = "hot" | "warm" | "cold"

/** What `planTiers` needs to know about a collection that has a slug and recent activity. */
export type TierCandidate = {
  contract: string
  filtered: boolean
  /** A mint within the last ten minutes. */
  minting: boolean
  /** Sales over the last seven days. */
  sales7d: number
}

/**
 * The tier of each candidate. Hot: collections minting now, and the 30 tracked collections with
 * the most sales in 7 days (at least one). Warm: the next 70 of the tracked collections, in the
 * same order. Cold: every other candidate. Filtered is tracked by nobody but followers, so it is always
 * cold; the order of ties is the contract.
 */
export function planTiers(rows: TierCandidate[]): Map<string, Tier> {
  const plan = new Map<string, Tier>()
  const ranked = rows
    .filter((r) => !r.filtered)
    .sort((a, b) => b.sales7d - a.sales7d || (a.contract < b.contract ? -1 : 1))
  const hot = new Set(ranked.filter((r) => r.minting).map((r) => r.contract))
  for (const r of ranked.filter((r) => r.sales7d > 0).slice(0, HOT_TOP)) hot.add(r.contract)
  let warm = 0
  for (const r of ranked) {
    if (hot.has(r.contract)) plan.set(r.contract, "hot")
    else if (warm < WARM_SIZE) {
      warm++
      plan.set(r.contract, "warm")
    } else plan.set(r.contract, "cold")
  }
  for (const r of rows) if (r.filtered) plan.set(r.contract, "cold")
  return plan
}

/**
 * Sets `stats_tier` on every collection with a slug and a mint in the last 10 minutes, a sale in
 * 30 days or a listing in 30 days; the others get none (and no schedule). A collection that enters a
 * tier is polled at once, and one that moves to a hotter tier is polled within that tier's interval.
 *
 * "Now" for the block windows is the chain cursor: the sales and mints carry blocks, not times.
 * shortcut: a lagging indexer (a backfill) reads its windows relative to the block it has reached,
 * not the clock. Store block times if the tiers should follow the clock then.
 */
export async function assignTiers(sql: Sql, now: Date): Promise<void> {
  const [cursor] = await sql<{ block: string }[]>`
    select block::text as block from indexer.cursors where source = ${CURSOR_ROW}`
  if (!cursor) return
  const head = BigInt(cursor.block)
  const blockBefore = (seconds: number) => (head - BigInt(Math.floor(seconds / BLOCK_S))).toString()
  const [mintCut, rankCut, coldCut] = [HOT_MINT_S, RANK_WINDOW_S, COLD_WINDOW_S].map(blockBefore)
  const listedCut = new Date(now.getTime() - COLD_WINDOW_S * 1000)

  const rows = await sql<
    { contract: string; filtered: boolean; minting: boolean; sales7d: number; active: boolean }[]
  >`
    select c.contract, c.verdict = 'filtered' as filtered,
      exists (select 1 from indexer.nft_mints m
        where m.contract = c.contract and m.block >= ${mintCut!}) as minting,
      (select count(*)::int from indexer.nft_sales s
        where s.contract = c.contract and s.block >= ${rankCut!}) as sales7d,
      (c.last_listing_at >= ${listedCut}
        or exists (select 1 from indexer.nft_sales s
          where s.contract = c.contract and s.block >= ${coldCut!})) as active
    from indexer.nft_collections c
    where c.slug is not null`
  const plan = planTiers(rows.filter((r) => r.minting || r.active))

  const contracts = [...plan.keys()]
  const tiers = [...plan.values()]
  const due = tiers.map((t) => new Date(now.getTime() + STATS_INTERVAL_S[t] * 1000).toISOString())
  await sql`
    update indexer.nft_collections c set
      stats_tier = t.tier,
      next_stats_at = case
        when c.stats_tier is null or c.next_stats_at is null then ${now}::timestamptz
        else least(c.next_stats_at, t.due) end
    from unnest(${sql.array(contracts)}::text[], ${sql.array(tiers)}::text[], ${sql.array(due)}::timestamptz[])
      as t(contract, tier, due)
    where c.contract = t.contract and c.stats_tier is distinct from t.tier`
  await sql`
    update indexer.nft_collections set stats_tier = null, next_stats_at = null
    where stats_tier is not null and contract <> all(${sql.array(contracts)}::text[])`
}

/** The newest floor of each contract that has a stats row (null when that row has none). */
export async function latestFloors(
  sql: Sql,
  contracts: string[],
): Promise<Map<string, bigint | null>> {
  if (contracts.length === 0) return new Map()
  const rows = await sql<{ contract: string; floor_wei: string | null }[]>`
    select distinct on (contract) contract, floor_wei::text as floor_wei
    from indexer.nft_stats where contract = any(${sql.array(contracts)}::text[])
    order by contract, at desc`
  return new Map(rows.map((r) => [r.contract, r.floor_wei === null ? null : BigInt(r.floor_wei)]))
}

/** One page of `GET /listings/collection/{slug}/best`: how many listings it holds and the cursor. */
function parseListingsPage(j: unknown): { count: number; next: string | null } | null {
  if (j === null || typeof j !== "object") return null
  const o = j as { listings?: unknown; next?: unknown }
  if (!Array.isArray(o.listings)) return null
  return {
    count: o.listings.length,
    next: typeof o.next === "string" && o.next !== "" ? o.next : null,
  }
}

const int = (n: number | null) => (n === null ? null : Math.round(n))
const INT_MAX = 2_147_483_647
const toDb = (v: bigint | null) => (v === null ? null : v.toString())

/** A stats event was written for the collection since this caller read its count. */
class StatsRaced extends Error {
  constructor(contract: string) {
    super(`nft.stats of ${contract} changed while it was being written`)
  }
}

export type StatsDeps = Pick<OsJobDeps, "sql" | "store" | "rest" | "log"> & {
  now?: () => number
}

type CollectionRow = {
  slug: string | null
  stats_tier: Tier | null
  max_supply: string | null
  total_supply: number | null
  listed_due_at: Date | null
  listed_counted_at: Date | null
  stats_n: number
}

type Poll = { wrote: boolean; outcome: JobOutcome }

/**
 * Collection stats: the tier job, the stats job, the on-demand refresh and the latest floor.
 *
 * A poll reads `GET /collections/{slug}/stats` (budget class 3), adds a listed count when one is
 * due, stores an `nft_stats` row and writes `nft.stats` (`os:stats:<contract>:<n>`) when the floor,
 * owners or 24 hour volume differ from the previous row. The supply comes from the collection's
 * `total_supply` (its OpenSea page) and `max_supply`, for Chimera collections too. All network reads
 * finish before the database transaction opens.
 */
export function createStats(deps: StatsDeps) {
  const { sql, store, rest, log } = deps
  const now = deps.now ?? Date.now

  /**
   * Listed count: pages of the best listings, up to three. A third page that still has a next
   * cursor means there are more than the limit: the count is the limit, `capped`.
   */
  async function countListed(
    slug: string,
    maxWaitMs: number,
  ): Promise<OsResult<{ count: number; capped: boolean }>> {
    let count = 0
    let next: string | null = null
    for (let page = 1; page <= LISTED_PAGES; page++) {
      const cursor: string = next === null ? "" : `&next=${encodeURIComponent(next)}`
      const res = await rest.get(
        `/listings/collection/${slug}/best?limit=${LISTED_PAGE_SIZE}${cursor}`,
        3,
        parseListingsPage,
        { maxWaitMs },
      )
      if (!res.ok) return res
      if (!res.value) return { ok: false, reason: "error" }
      count += res.value.count
      next = res.value.next
      if (next === null) return { ok: true, value: { count, capped: false } }
    }
    return { ok: true, value: { count: LISTED_PAGES * LISTED_PAGE_SIZE, capped: true } }
  }

  /** The supply the event reports: the collection's columns. */
  const supplyOf = (row: CollectionRow) => ({
    total: row.total_supply === null ? null : BigInt(row.total_supply),
    max: row.max_supply === null ? null : BigInt(row.max_supply),
  })

  function listedWanted(row: CollectionRow, at: number): boolean {
    if (row.listed_due_at !== null && row.listed_due_at.getTime() <= at) return true
    if (row.stats_tier === null || row.stats_tier === "cold") return false
    return (
      row.listed_counted_at === null ||
      at - row.listed_counted_at.getTime() >= LISTED_INTERVAL_S[row.stats_tier] * 1000
    )
  }

  async function reschedule(contract: string, afterMs: number): Promise<void> {
    await sql`
      update indexer.nft_collections set next_stats_at = ${new Date(now() + afterMs)}
      where contract = ${contract} and stats_tier is not null`
  }

  /**
   * A scheduled poll failed before it could count: a listed count that is due moves back by
   * `LISTED_RETRY_MS`, so a collection with no tier (only `listed_due_at` makes it due) is not
   * polled on every tick. A collection OpenSea does not know is dropped after a few tries.
   */
  async function holdListed(contract: string, notFound: boolean): Promise<void> {
    const t = now()
    await sql`
      update indexer.nft_collections set
        listed_failures = case
          when not ${notFound} then listed_failures
          when listed_failures + 1 >= ${LISTED_NOT_FOUND_GIVE_UP} then 0
          else listed_failures + 1 end,
        listed_due_at = case when ${notFound} and listed_failures + 1 >= ${LISTED_NOT_FOUND_GIVE_UP}
          then null else ${new Date(t + LISTED_RETRY_MS)}::timestamptz end
      where contract = ${contract} and listed_due_at <= ${new Date(t)}`
  }

  /**
   * One poll. `scheduled` polls (the job's) move the collection's schedule on failure too and may
   * count listings; an on-demand refresh does neither.
   */
  async function poll(
    contract: string,
    opts: { scheduled: boolean; maxWaitMs: number },
  ): Promise<Poll> {
    const [row] = await sql<CollectionRow[]>`
      select slug, stats_tier, max_supply::text as max_supply, total_supply,
        listed_due_at, listed_counted_at, stats_n
      from indexer.nft_collections where contract = ${contract}`
    if (!row?.slug) return { wrote: false, outcome: undefined }
    const { slug } = row

    const res = await rest.get(`/collections/${slug}/stats`, 3, parseStats, {
      maxWaitMs: opts.maxWaitMs,
    })
    const stats: OsStats | null = res.ok ? res.value : null
    if (!stats) {
      const early = res.ok ? undefined : commonOutcome(res)
      if (early) {
        if (opts.scheduled) await holdListed(contract, false)
        return { wrote: false, outcome: early }
      }
      if (opts.scheduled) {
        await holdListed(contract, !res.ok && res.reason === "not_found")
        // Unknown to OpenSea: look again at the tier's own pace. Any other failure: soon.
        const unknown = !res.ok && res.reason === "not_found"
        await reschedule(
          contract,
          unknown && row.stats_tier ? STATS_INTERVAL_S[row.stats_tier] * 1000 : TRANSIENT_RETRY_MS,
        )
      }
      return { wrote: false, outcome: undefined }
    }

    const at = new Date(now())
    let listed: { count: number; capped: boolean } | null = null
    let listingFailed: Extract<OsResult<unknown>, { ok: false }> | null = null
    if (opts.scheduled && listedWanted(row, at.getTime())) {
      const counted = await countListed(slug, opts.maxWaitMs)
      if (counted.ok) listed = counted.value
      else listingFailed = counted
    }
    const supply = supplyOf(row)

    const [prev] = await sql<
      { floor_wei: string | null; owners: number | null; volume: string | null }[]
    >`
      select floor_wei::text as floor_wei, owners, volume_24h_wei::text as volume
      from indexer.nft_stats where contract = ${contract} order by at desc limit 1`
    // The listed count is compared with the last poll that counted, which may be an older one.
    const [counted] = await sql<{ listed_count: number; listed_capped: boolean }[]>`
      select listed_count, listed_capped from indexer.nft_stats
      where contract = ${contract} and listed_count is not null order by at desc limit 1`
    const [ago] = await sql<{ floor_wei: string | null }[]>`
      select floor_wei::text as floor_wei from indexer.nft_stats
      where contract = ${contract} and at <= ${new Date(at.getTime() - FLOOR_CHANGE_WINDOW_MS)}
      order by at desc limit 1`

    const values = {
      contract,
      at,
      floor_wei: toDb(stats.floorWei),
      owners: int(stats.owners),
      volume_24h_wei: toDb(stats.volume24hWei),
      sales_24h: int(stats.sales24h),
      total_supply:
        supply.total !== null && supply.total <= BigInt(INT_MAX) ? Number(supply.total) : null,
      listed_count: listed ? listed.count : null,
      listed_capped: listed ? listed.capped : null,
    }
    const changed =
      !prev ||
      prev.floor_wei !== values.floor_wei ||
      prev.owners !== values.owners ||
      prev.volume !== values.volume_24h_wei ||
      (listed !== null &&
        (counted?.listed_count !== listed.count || counted?.listed_capped !== listed.capped))
    const event: NftStatsEvent | null = changed
      ? {
          v: SCHEMA_VERSION,
          chainId: INK_CHAIN_ID,
          contract: contract as Address,
          source: "opensea",
          txHash: `os:stats:${contract}:${row.stats_n + 1}`,
          logIndex: 0,
          // The store stamps the block of the chain cursor.
          blockNumber: "0",
          blockTimestamp: Math.floor(at.getTime() / 1000),
          type: "nft.stats",
          floorWei: values.floor_wei,
          floor24hAgoWei: ago?.floor_wei ?? null,
          owners: values.owners ?? 0,
          volume24hWei: values.volume_24h_wei ?? "0",
          sales24h: values.sales_24h ?? 0,
          totalSupply: supply.total === null ? null : supply.total.toString(),
          maxSupply: supply.max === null ? null : supply.max.toString(),
          listedCount: listed ? listed.count : null,
          listedCapped: listed ? listed.capped : false,
        }
      : null

    const nextAt =
      row.stats_tier === null
        ? null
        : new Date(at.getTime() + STATS_INTERVAL_S[row.stats_tier] * 1000)
    const retryListed = new Date(at.getTime() + LISTED_RETRY_MS)
    const step = async (tx: Tx) => {
      await tx`insert into indexer.nft_stats ${tx(values)} on conflict (contract, at) do nothing`
      const moved = await tx`
        update indexer.nft_collections set
          stats_n = stats_n + ${event ? 1 : 0},
          next_stats_at = coalesce(${nextAt}::timestamptz, next_stats_at),
          listed_counted_at = case when ${listed !== null} then ${at}::timestamptz else listed_counted_at end,
          listed_failures = case when ${listed !== null} then 0 else listed_failures end,
          listed_due_at = case
            when ${listed !== null} then null
            when ${listingFailed !== null} and listed_due_at is not null then ${retryListed}::timestamptz
            else listed_due_at end
        where contract = ${contract} and (${event === null} or stats_n = ${row.stats_n})
        returning 1`
      if (event && moved.length === 0) throw new StatsRaced(contract)
    }
    if (event) await store.writeOffchain([{ event }], step)
    else await sql.begin(step)
    return { wrote: true, outcome: listingFailed ? commonOutcome(listingFailed) : undefined }
  }

  const job: Job = {
    name: "opensea-stats",
    usesApi: true,
    everyMs: SCHEDULER_TICK_MS,
    async due(sql, at) {
      const rows = await sql<{ contract: string }[]>`
        select contract from indexer.nft_collections
        where slug is not null
          and ((stats_tier is not null and next_stats_at <= ${at}) or listed_due_at <= ${at})
        order by least(coalesce(next_stats_at, 'infinity'), coalesce(listed_due_at, 'infinity'))
        limit ${JOBS_PER_TICK}`
      return rows.map((r) => r.contract)
    },
    async run(contract) {
      return (await poll(contract, { scheduled: true, maxWaitMs: OPENSEA_MAX_WAIT_MS })).outcome
    },
  }

  /**
   * Assigns the tiers every ten minutes. The scheduler runs jobs through `due`, and this one does
   * its work there: it has no per-contract run.
   */
  const tierJob: Job = {
    name: "opensea-stats-tiers",
    usesApi: true,
    everyMs: TIER_EVERY_MS,
    async due(sql, at) {
      await assignTiers(sql, at)
      return []
    },
    async run() {},
  }

  /**
   * An immediate refresh of one collection's stats, at most once per contract per 30 minutes (a
   * second call inside that time makes no request and answers false). True when the refresh wrote a
   * row within `waitMs`; false when it did not finish in time (it carries on and may still write),
   * when the budget or OpenSea refused, or when the collection has no slug.
   */
  async function requestStats(contract: string, waitMs: number): Promise<boolean> {
    const at = now()
    const claimed = await sql`
      update indexer.nft_collections set stats_requested_at = ${new Date(at)}
      where contract = ${contract} and slug is not null
        and (stats_requested_at is null
          or stats_requested_at <= ${new Date(at - STATS_REQUEST_THROTTLE_MS)})
      returning 1`
    if (claimed.length === 0) return false
    const refresh = poll(contract, { scheduled: false, maxWaitMs: waitMs }).then(
      (r) => r.wrote,
      (err) => {
        log("warn", "on-demand stats refresh failed", { contract, error: String(err) })
        return false
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs)
    })
    try {
      return await Promise.race([refresh, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async function latestFloor(
    contract: string,
  ): Promise<{ floorWei: bigint | null; at: Date } | null> {
    const [row] = await sql<{ floor_wei: string | null; at: Date }[]>`
      select floor_wei::text as floor_wei, at from indexer.nft_stats
      where contract = ${contract} order by at desc limit 1`
    return row
      ? { floorWei: row.floor_wei === null ? null : BigInt(row.floor_wei), at: row.at }
      : null
  }

  return { job, tierJob, requestStats, latestFloor }
}

export type Stats = ReturnType<typeof createStats>
