import type { Sql } from "@ink-indexer/db"
import type { Logger } from "../../log"
import type { Snapshots } from "../opensea/snapshot"

/** NFTX's launch API for Ink, one launch record per Launchpad collection. */
const LAUNCHES_URL = "https://api.nftx.io/v1/57073/launches"
/** A launch's media is served from the same API; any other host is not taken as the image. */
const MEDIA_PREFIX = "https://api.nftx.io/v1/media/"
const REQUEST_TIMEOUT_MS = 5_000
const ATTEMPTS = 3
const RETRY_PAUSE_MS = 1_000
const MIN_MS = 60_000
/** Waits after a collection's first, second and later lookups that found no image. */
const MISS_WAITS_MS = [5 * MIN_MS, 30 * MIN_MS, 120 * MIN_MS]
const URL_MAX = 500

type LaunchRecord = { collection?: unknown; profile?: { avatarUrl?: unknown } | null }

/**
 * The avatar of the launch the response holds for `collection`, or null when it holds none: an
 * empty list, a `LAUNCH_NOT_FOUND` error body, a record of another collection, a launch whose
 * profile has no avatar yet, or an avatar that is not served from NFTX's media path.
 */
export function launchAvatar(body: unknown, collection: string): string | null {
  const list = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) return null
  for (const r of list as LaunchRecord[]) {
    if (typeof r?.collection !== "string" || r.collection.toLowerCase() !== collection) continue
    const url = r.profile?.avatarUrl
    if (typeof url === "string" && url.length <= URL_MAX && url.startsWith(MEDIA_PREFIX)) return url
  }
  return null
}

export type LaunchImagesDeps = {
  sql: Sql
  snapshots: Snapshots
  log: Logger
  report: (err: unknown) => void
  fetch?: typeof fetch
  now?: () => number
  /** Pause between the attempts of one lookup. */
  retryDelayMs?: number
}

/**
 * Gives a Launchpad collection that has no image the avatar from its NFTX launch page, while its
 * auction is still running (a collection has no token to take an image from before bidders claim,
 * and OpenSea has no page for it yet). An image OpenSea provides replaces it. The lookup runs on
 * its own timer and writes through the snapshot path, so it never holds up the chain loop.
 *
 * shortcut: the schedule of misses is kept in memory, so a restart looks again at once. Store it if
 * restarts get frequent enough for that to matter to the API.
 */
export function createLaunchImages(deps: LaunchImagesDeps) {
  const { sql, snapshots, log, report } = deps
  const now = deps.now ?? Date.now
  const get = deps.fetch ?? fetch
  const pause = deps.retryDelayMs ?? RETRY_PAUSE_MS
  const next = new Map<string, { misses: number; at: number }>()
  let running = false

  /** The avatar, null when the launch has none yet, undefined when the API could not be read. */
  async function lookup(collection: string): Promise<string | null | undefined> {
    for (let i = 0; i < ATTEMPTS; i++) {
      if (i > 0 && pause > 0) await new Promise((r) => setTimeout(r, pause))
      try {
        const res = await get(`${LAUNCHES_URL}?collection=${collection}`, {
          headers: { accept: "application/json", "user-agent": "ink-indexer" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        // A launch the API does not know answers 404 with LAUNCH_NOT_FOUND: no image yet.
        if (res.status === 404) return null
        if (!res.ok) continue
        return launchAvatar(await res.json(), collection)
      } catch {}
    }
    return undefined
  }

  async function one(collection: string): Promise<void> {
    const avatar = await lookup(collection)
    if (avatar) {
      // OpenSea may have filled the image while the request was out.
      const [row] = await sql<{ image_url: string | null }[]>`
        select image_url from indexer.nft_collections where contract = ${collection}`
      if (row && !row.image_url)
        await snapshots.emitSnapshotIfChanged(collection, { image_url: avatar })
      next.delete(collection)
      return
    }
    const misses = (next.get(collection)?.misses ?? 0) + 1
    if (avatar === undefined) log("warn", "nftx launch lookup failed", { collection })
    next.set(collection, {
      misses,
      at: now() + MISS_WAITS_MS[Math.min(misses, MISS_WAITS_MS.length) - 1]!,
    })
  }

  /** Looks up every due collection with no image whose auction has not ended. Never throws. */
  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const rows = await sql<{ contract: string }[]>`
        select c.contract from indexer.nft_collections c
        where c.launchpad = 'nftx' and coalesce(c.image_url, '') = ''
          and exists (select 1 from indexer.nftx_auctions a
            where a.collection = c.contract and a.ended_block is null)`
      const at = now()
      for (const { contract } of rows) {
        if ((next.get(contract)?.at ?? 0) > at) continue
        try {
          await one(contract)
        } catch (err) {
          next.set(contract, {
            misses: next.get(contract)?.misses ?? 1,
            at: at + MISS_WAITS_MS[0]!,
          })
          log("error", "nftx launch image failed", { collection: contract, error: String(err) })
          report(err)
        }
      }
    } catch (err) {
      log("error", "nftx launch image query failed", { error: String(err) })
      report(err)
    } finally {
      running = false
    }
  }

  return { tick }
}

/** Runs `tick` now and then every minute; returns what stops it. */
export function startLaunchImages(images: ReturnType<typeof createLaunchImages>): () => void {
  void images.tick()
  const timer = setInterval(() => void images.tick(), MIN_MS)
  timer.unref()
  return () => clearInterval(timer)
}
