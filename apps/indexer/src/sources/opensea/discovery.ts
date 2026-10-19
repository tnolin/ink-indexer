import { type OsCollection, parseCollection, parseContract } from "@ink-indexer/sdk"
import {
  DISCOVERY_DAILY_MS,
  DISCOVERY_GIVE_UP_S,
  DISCOVERY_RETRY_MS,
  JOBS_PER_TICK,
  METADATA_REFRESH_MS,
  SCHEDULER_TICK_MS,
  SLOW_JOB_EVERY_MS,
  TRANSIENT_RETRY_MS,
} from "../nft/policy"
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
      await tx`
        update indexer.nft_collections
        set discovery_attempts = ${failures}, next_discovery_at = ${wait === null ? null : new Date(t + wait)}
        where contract = ${contract}`
      return wait
    })
    if (delay === null) log("info", "opensea discovery gave up", { contract })
  }

  /** An error that says nothing about the contract: try again soon, without counting it. */
  async function transient(contract: string): Promise<void> {
    await sql`
      update indexer.nft_collections set next_discovery_at = ${new Date(now() + TRANSIENT_RETRY_MS)}
      where contract = ${contract}`
  }

  return {
    name: "opensea-discovery",
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
        return void (await (found.reason === "not_found" ? failed(contract) : transient(contract)))
      }
      if (!found.value?.slug) return void (await failed(contract))

      const page = await rest.get(
        `/collections/${found.value.slug}`,
        2,
        parseCollection,
        OS_REQUEST,
      )
      if (!page.ok) {
        const early = commonOutcome(page)
        if (early) return early
        return void (await (page.reason === "not_found" ? failed(contract) : transient(contract)))
      }
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
        ...(row.standard === null && (standard === "erc721" || standard === "erc1155")
          ? { standard }
          : {}),
        discovery_attempts: 0,
        next_discovery_at: null,
        discovered_at: new Date(t),
        next_metadata_at: new Date(t + (accountFailed ? TRANSIENT_RETRY_MS : METADATA_REFRESH_MS)),
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

  return {
    name: "opensea-metadata",
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
        // Gone from OpenSea: look again tomorrow. Any other error: soon.
        await reschedule(
          contract,
          page.reason === "not_found" ? METADATA_REFRESH_MS : TRANSIENT_RETRY_MS,
        )
        return
      }
      if (!page.value) return void (await reschedule(contract, TRANSIENT_RETRY_MS))

      // The creator's account is read again when its cache has expired; the snapshot is written
      // again if the account changed. If it cannot be read, the page is read again soon.
      const who = row.creator_address ?? page.value.owner
      const account = who ? await accounts.getAccount(who) : null
      const accountFailed = account !== null && !account.ok ? account : null

      const columns = pageColumns(page.value)
      const changed = (Object.keys(columns) as (keyof typeof columns)[]).some(
        (k) => !same(row[k], columns[k]),
      )
      await snapshots.emitSnapshotIfChanged(contract, {
        ...columns,
        next_metadata_at: new Date(
          now() + (accountFailed ? TRANSIENT_RETRY_MS : METADATA_REFRESH_MS),
        ),
        ...(changed ? { verdict_dirty: true } : {}),
      })
      return accountFailed ? commonOutcome(accountFailed) : undefined
    },
  }
}
