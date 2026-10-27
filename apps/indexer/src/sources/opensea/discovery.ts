import type { Sql } from "@ink-indexer/db"
import { type OsCollection, parseCollection, parseContract } from "@ink-indexer/sdk"
import { CURSOR_ROW } from "../../store"
import {
  ACCOUNT_RETRY_MS,
  BLOCK_S,
  DISCOVERY_DAILY_MS,
  DISCOVERY_GIVE_UP_S,
  DISCOVERY_RETRY_MS,
  JOBS_PER_TICK,
  METADATA_ACTIVE_S,
  METADATA_REFRESH_MS,
  METADATA_SLOW_REFRESH_MS,
  SCHEDULER_TICK_MS,
  SLOW_JOB_EVERY_MS,
  TRANSIENT_RETRY_MS,
} from "../nft/policy"
import { answeredFor, failedFor } from "./backoff"
import type { OsResult } from "./rest"
import { commonOutcome, type Job, type JobOutcome, OS_REQUEST, type OsJobDeps } from "./scheduler"
import type { CollectionPatch } from "./snapshot"

/**
 * Wait after the `failures`-th failed slug lookup, or null once the next try would fall more than
 * seven days after the first.
 *
 * shortcut: the time since the first try is the sum of the scheduled waits, not read from a clock,
 * so a late tick lets the window run a little over. Store the first attempt's time to make it exact.
 */
export function nextDiscoveryDelay(failures: number): number | null {
  const wait = (i: number) => DISCOVERY_RETRY_MS[i - 1] ?? DISCOVERY_DAILY_MS
  let elapsed = 0
  for (let i = 1; i < failures; i++) elapsed += wait(i)
  return elapsed + wait(failures) > DISCOVERY_GIVE_UP_S * 1000 ? null : wait(failures)
}

/**
 * How long until a collection's page is read again: a day for one with a mint or sale in the last
 * week, whatever its verdict, and a week for one with neither. A mint or sale stored for a
 * collection whose read is further away than a day makes it due at once (`writeRows`).
 */
async function refreshDelay(sql: Sql, contract: string): Promise<number> {
  const [row] = await sql<{ slow: boolean }[]>`
    select not (
      exists (select 1 from indexer.nft_mints m
        where m.contract = c.contract and m.block >= h.block - ${METADATA_ACTIVE_S / BLOCK_S})
      or exists (select 1 from indexer.nft_sales s
        where s.contract = c.contract and s.block >= h.block - ${METADATA_ACTIVE_S / BLOCK_S})
    ) as slow
    from indexer.nft_collections c
    left join indexer.cursors h on h.source = ${CURSOR_ROW}
    where c.contract = ${contract}`
  return row?.slow ? METADATA_SLOW_REFRESH_MS : METADATA_REFRESH_MS
}

/** OpenSea writes `calculated_at` without a zone; it is UTC. */
function rarityTime(v: string | null): Date | null {
  if (v === null) return null
  const ms = Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(v) ? v : `${v}Z`)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/** The collection row columns a collection page fills. */
export function pageColumns(c: OsCollection) {
  return {
    slug: c.slug,
    name: c.name,
    image_url: c.imageUrl,
    twitter: c.twitter,
    website: c.website,
    discord: c.discord,
    safelist: c.safelist,
    opensea_url: c.openseaUrl,
    rarity_calculated_at: rarityTime(c.rarityCalculatedAt),
    max_rank: c.maxRank === null ? null : Math.round(c.maxRank),
    owner: c.owner,
  } satisfies CollectionPatch
}

/**
 * The page's total supply, for the stats job. Left out when the page has none (the stored value
 * stays) or when it does not fit the column. It is not a page column: a changing supply must not
 * mark the verdict dirty.
 */
export function supplyColumn(c: OsCollection): { total_supply?: number } {
  const n = c.totalSupply
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 2_147_483_647
    ? { total_supply: n }
    : {}
}

/** When the page is read again after the creator's account could not be read. */
const accountRetryMs = (failed: Extract<OsResult<unknown>, { ok: false }>) =>
  failed.reason === "error" ? ACCOUNT_RETRY_MS : TRANSIENT_RETRY_MS

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b

type PageRow = { [K in keyof ReturnType<typeof pageColumns>]: unknown }

/** Collections with no slug whose lookup is due. */
export function createDiscoveryJob(deps: OsJobDeps): Job {
  const { sql, rest, snapshots, accounts, log } = deps
  const now = deps.now ?? Date.now

  /** The lookup found nothing yet: count it and schedule the next try, or stop. */
  async function failed(contract: string): Promise<void> {
    const t = now()
    const delay = await sql.begin(async (tx) => {
      const [r] = await tx<{ n: number }[]>`
        select discovery_attempts as n from indexer.nft_collections where contract = ${contract} for update`
      if (!r) return undefined
      const failures = r.n + 1
      const wait = nextDiscoveryDelay(failures)
      // Giving up decides gate 1, so the verdict is looked at again.
      await tx`
        update indexer.nft_collections
        set discovery_attempts = ${failures}, next_discovery_at = ${wait === null ? null : new Date(t + wait)},
          verdict_dirty = verdict_dirty or ${wait === null}
        where contract = ${contract}`
      return wait
    })
    if (delay === null) log("info", "opensea discovery gave up", { contract })
  }

  /** An error that says nothing about the contract: try again soon, without counting it. */
  async function transient(contract: string, client = false): Promise<void> {
    const wait = await failedFor(sql, contract, "discovery", client)
    await sql`
      update indexer.nft_collections set next_discovery_at = ${new Date(now() + wait)}
      where contract = ${contract}`
  }

  return {
    name: "opensea-discovery",
    usesApi: true,
    everyMs: SCHEDULER_TICK_MS,
    async due(sql, at) {
      const rows = await sql<{ contract: string }[]>`
        select contract from indexer.nft_collections
        where slug is null and next_discovery_at <= ${at}
        order by next_discovery_at limit ${JOBS_PER_TICK}`
      return rows.map((r) => r.contract)
    },
    async run(contract): Promise<JobOutcome> {
      const [row] = await sql<
        {
          slug: string | null
          standard: string | null
          seadrop: boolean
          next_drops_at: Date | null
          creator_address: string | null
        }[]
      >`
        select slug, standard, seadrop, next_drops_at, creator_address
        from indexer.nft_collections where contract = ${contract}`
      if (!row || row.slug) return

      const found = await rest.get(`/chain/ink/contract/${contract}`, 2, parseContract, OS_REQUEST)
      if (!found.ok) {
        const early = commonOutcome(found)
        if (early) return early
        if (found.reason === "not_found") await answeredFor(sql, contract, "discovery")
        return void (await (found.reason === "not_found"
          ? failed(contract)
          : transient(contract, found.client === true)))
      }
      if (!found.value?.slug) {
        await answeredFor(sql, contract, "discovery")
        return void (await failed(contract))
      }

      const page = await rest.get(
        `/collections/${found.value.slug}`,
        2,
        parseCollection,
        OS_REQUEST,
      )
      if (!page.ok) {
        const early = commonOutcome(page)
        if (early) return early
        if (page.reason !== "not_found")
          return void (await transient(contract, page.client === true))
        await answeredFor(sql, contract, "discovery")
        return void (await failed(contract))
      }
      await answeredFor(sql, contract, "discovery")
      if (!page.value) return void (await failed(contract))

      // The creator's account is read before the snapshot so that the first snapshot carries it. If
      // it cannot be read now the snapshot goes without it and the page is read again soon.
      const who = row.creator_address ?? page.value.owner
      const account = who ? await accounts.getAccount(who) : null
      const accountFailed = account !== null && !account.ok ? account : null

      const t = now()
      const standard = found.value.standard.toLowerCase()
      const patch: CollectionPatch = {
        ...pageColumns(page.value),
        ...supplyColumn(page.value),
        ...(row.standard === null && (standard === "erc721" || standard === "erc1155")
          ? { standard }
          : {}),
        discovery_attempts: 0,
        next_discovery_at: null,
        discovered_at: new Date(t),
        next_metadata_at: new Date(
          t + (accountFailed ? accountRetryMs(accountFailed) : await refreshDelay(sql, contract)),
        ),
        verdict_dirty: true,
        // A SeaDrop collection gets its drop page now, unless that is already due.
        ...(row.seadrop && (row.next_drops_at === null || row.next_drops_at.getTime() > t)
          ? { next_drops_at: new Date(t) }
          : {}),
      }
      await snapshots.emitSnapshotIfChanged(contract, patch)
      return accountFailed ? commonOutcome(accountFailed) : undefined
    },
  }
}

/** Collections with a slug whose page is due to be read again. */
export function createMetadataJob(deps: OsJobDeps): Job {
  const { sql, rest, snapshots, accounts } = deps
  const now = deps.now ?? Date.now

  const reschedule = (contract: string, ms: number) =>
    sql`
      update indexer.nft_collections set next_metadata_at = ${new Date(now() + ms)}
      where contract = ${contract}`
  const errored = async (contract: string, client = false) =>
    reschedule(contract, await failedFor(sql, contract, "metadata", client))

  return {
    name: "opensea-metadata",
    usesApi: true,
    everyMs: SLOW_JOB_EVERY_MS,
    async due(sql, at) {
      const rows = await sql<{ contract: string }[]>`
        select contract from indexer.nft_collections
        where slug is not null and next_metadata_at <= ${at}
        order by next_metadata_at limit ${JOBS_PER_TICK}`
      return rows.map((r) => r.contract)
    },
    async run(contract): Promise<JobOutcome> {
      const [row] = await sql<
        (PageRow & { slug: string | null; creator_address: string | null })[]
      >`
        select slug, name, image_url, twitter, website, discord, safelist, opensea_url,
          rarity_calculated_at, max_rank, owner, creator_address
        from indexer.nft_collections where contract = ${contract}`
      if (!row?.slug) return

      const page = await rest.get(`/collections/${row.slug}`, 2, parseCollection, OS_REQUEST)
      if (!page.ok) {
        const early = commonOutcome(page)
        if (early) return early
        // Gone from OpenSea: look again tomorrow. Any other error: backed off.
        if (page.reason !== "not_found") return void (await errored(contract, page.client === true))
        await answeredFor(sql, contract, "metadata")
        await reschedule(contract, METADATA_REFRESH_MS)
        return
      }
      if (!page.value) return void (await errored(contract))
      await answeredFor(sql, contract, "metadata")

      // The creator's account is read again when its cache has expired; the snapshot is written
      // again if the account changed, and a change of its verified flag (gates 1 and 2) marks the
      // verdict dirty. If it cannot be read, the page is read again soon.
      const who = row.creator_address ?? page.value.owner
      const [cached] = who
        ? await sql<{ verified: boolean }[]>`
            select verified from indexer.nft_accounts where address = ${who.toLowerCase()}`
        : []
      const account = who ? await accounts.getAccount(who) : null
      const accountFailed = account !== null && !account.ok ? account : null

      const columns = pageColumns(page.value)
      const changed = (Object.keys(columns) as (keyof typeof columns)[]).some(
        (k) => !same(row[k], columns[k]),
      )
      await snapshots.emitSnapshotIfChanged(contract, {
        ...columns,
        ...supplyColumn(page.value),
        next_metadata_at: new Date(
          now() +
            (accountFailed ? accountRetryMs(accountFailed) : await refreshDelay(sql, contract)),
        ),
        ...(changed || (account?.ok && account.value.verified !== (cached?.verified ?? false))
          ? { verdict_dirty: true }
          : {}),
      })
      return accountFailed ? commonOutcome(accountFailed) : undefined
    },
  }
}
