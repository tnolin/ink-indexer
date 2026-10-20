import type { Sql } from "@ink-indexer/db"
import { type NftListingEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import { INK_CHAIN_ID, WETH_INK } from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Logger } from "../../log"
import type { Store } from "../../store"
import {
  FLOOR_MAX_AGE_MS,
  LISTING_MIN_LIFE_S,
  LISTING_WAIT_MS,
  METADATA_BURST_COUNT,
  METADATA_BURST_WINDOW_MS,
  NEAR_FLOOR_RATIO,
} from "../nft/policy"
import { itemKey, type Ranks } from "./ranks"
import type { Stats } from "./stats"
import type { StreamEvent } from "./stream"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/** The latest name and image the listings saw for each item, by `itemKey`. */
export async function seenItems(
  sql: Sql,
  items: { contract: string; tokenId: string }[],
): Promise<Map<string, { name: string | null; imageUrl: string | null }>> {
  if (items.length === 0) return new Map()
  const rows = await sql<
    { contract: string; token_id: string; name: string | null; image_url: string | null }[]
  >`
    select s.contract, s.token_id::text as token_id, s.name, s.image_url
    from unnest(${sql.array(items.map((i) => i.contract))}::text[],
      ${sql.array(items.map((i) => i.tokenId))}::numeric[]) as q(contract, token_id)
    join indexer.nft_items_seen s on s.contract = q.contract and s.token_id = q.token_id`
  return new Map(
    rows.map((r) => [itemKey(r.contract, r.token_id), { name: r.name, imageUrl: r.image_url }]),
  )
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

/** The item's name and image in an `item_listed` payload. */
function itemMeta(payload: unknown): { name: string | null; imageUrl: string | null } {
  const meta = obj(obj(obj(payload)?.item)?.metadata)
  return { name: str(meta?.name), imageUrl: str(meta?.image_url) }
}

/** A listing that passed the filter's payload checks (steps 1 to 4). */
type Listed = {
  orderHash: Hash
  /** Wei for one unit. */
  unitPriceWei: bigint
  currency: "ETH" | "WETH"
  maker: Address
  expiresAtMs: number
  name: string | null
  imageUrl: string | null
}

/**
 * Steps 1 to 4 of the listing filter, which need only the payload: private listings are dropped,
 * then anything not paid in ETH or WETH, then a listing that lives under an hour; the price is
 * per unit. Null for a dropped listing and for a payload that cannot be read.
 */
export function parseListed(payload: unknown): Listed | null {
  const p = obj(payload)
  if (!p) return null
  if (p.is_private !== false) return null

  const token = obj(p.payment_token)
  const paid = str(token?.address)?.toLowerCase()
  const currency = paid === ZERO_ADDRESS ? "ETH" : paid === WETH_INK ? "WETH" : null
  if (currency === null) return null

  const listedAt = Date.parse(str(p.listing_date) ?? "")
  const expiresAt = Date.parse(str(p.expiration_date) ?? "")
  if (!Number.isFinite(listedAt) || !Number.isFinite(expiresAt)) return null
  if (expiresAt - listedAt < LISTING_MIN_LIFE_S * 1000) return null

  const total = str(p.base_price)
  const quantity = p.quantity === undefined || p.quantity === null ? 1 : p.quantity
  if (total === null || !/^\d+$/.test(total)) return null
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1) return null

  const orderHash = str(p.order_hash)?.toLowerCase()
  const maker = str(obj(p.maker)?.address)?.toLowerCase()
  if (!orderHash || !/^0x[0-9a-f]{64}$/.test(orderHash)) return null
  if (!maker || !/^0x[0-9a-f]{40}$/.test(maker)) return null

  const meta = itemMeta(p)
  return {
    orderHash: orderHash as Hash,
    unitPriceWei: BigInt(total) / BigInt(quantity),
    currency,
    maker: maker as Address,
    expiresAtMs: expiresAt,
    name: meta.name,
    imageUrl: meta.imageUrl,
  }
}

/** Another listing of the item was written first, at the same price or lower. */
class ListingStale extends Error {}

export type ListingsDeps = {
  sql: Sql
  store: Pick<Store, "writeOffchain">
  stats: Pick<Stats, "latestFloor" | "requestStats">
  ranks: Pick<Ranks, "cachedRank" | "getRank">
  log: Logger
  report?: (err: unknown) => void
  now?: () => number
}

/**
 * Stream events to `nft.listing` events and listing state.
 *
 * An `item_listed` goes through the filter (spec "Listing filter"): the payload checks, then the
 * item's state (only a strictly lower price than the last one written), then the floor (refreshed
 * first when older than 2 hours), then the rank (fetched only for a price at or under floor × 11/10;
 * a cached rank is attached whatever the price). The floor refresh and the rank fetch each wait up
 * to 10 s, and both finish before the write transaction opens. A cancel, sale or transfer of the item
 * clears its state. A burst of `item_metadata_updated` of one collection marks its traits re-check due.
 *
 * Events of one item run one after the other, so a cancel never overtakes the listing before it.
 * `handleStreamEvent` does not reject: a failure is logged and reported.
 */
export function createListings(deps: ListingsDeps) {
  const { sql, store, stats, ranks, log } = deps
  const now = deps.now ?? Date.now

  // Events of an item run in order.
  const tails = new Map<string, Promise<void>>()
  function inOrder(key: string, fn: () => Promise<void>): Promise<void> {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => {})
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }

  // One stats refresh per collection at a time: listings that arrive meanwhile wait for the same one.
  const refreshing = new Map<string, Promise<unknown>>()
  function refresh(contract: string): Promise<unknown> {
    let p = refreshing.get(contract)
    if (!p) {
      p = stats
        .requestStats(contract, LISTING_WAIT_MS)
        .catch(() => false)
        .finally(() => refreshing.delete(contract))
      refreshing.set(contract, p)
    }
    return p
  }

  /** The collection's newest floor row, refreshed first when it is missing or older than 2 hours. */
  async function currentFloor(contract: string) {
    const first = await stats.latestFloor(contract)
    if (first && now() - first.at.getTime() <= FLOOR_MAX_AGE_MS) return first
    await refresh(contract)
    return stats.latestFloor(contract)
  }

  async function onListed(e: StreamEvent): Promise<void> {
    const { contract, tokenId } = e
    const at = now()

    // Every listing frame, dropped or not, leaves the item's name and image if none is known yet,
    // so a sale of an item whose listings were all dropped still has a name. Never overwrites.
    const meta = itemMeta(e.payload)
    if (meta.name !== null || meta.imageUrl !== null)
      await sql`
        insert into indexer.nft_items_seen (contract, token_id, name, image_url, seen_at)
        values (${contract}, ${tokenId}, ${meta.name}, ${meta.imageUrl}, ${new Date(at)})
        on conflict (contract, token_id) do nothing`

    const l = parseListed(e.payload)
    if (!l) return

    // The item's state: only a lower price than the last one written, and only until that listing expires.
    const [state] = await sql<{ last_price_wei: string; expires_at: Date }[]>`
      select last_price_wei::text as last_price_wei, expires_at from indexer.nft_listing_state
      where contract = ${contract} and token_id = ${tokenId}`
    if (state && state.expires_at.getTime() > at && l.unitPriceWei >= BigInt(state.last_price_wei))
      return

    const floor = await currentFloor(contract)
    const floorWei = floor?.floorWei ?? null
    const near =
      floorWei !== null && l.unitPriceWei * NEAR_FLOOR_RATIO.den <= floorWei * NEAR_FLOOR_RATIO.num
    const rank = near
      ? await ranks.getRank(contract, tokenId, { maxWaitMs: LISTING_WAIT_MS })
      : await ranks.cachedRank(contract, tokenId)

    const event: NftListingEvent = {
      v: SCHEMA_VERSION,
      chainId: INK_CHAIN_ID,
      contract,
      source: "opensea",
      txHash: `os:list:${l.orderHash}`,
      logIndex: 0,
      // The store stamps the block of the chain cursor.
      blockNumber: "0",
      blockTimestamp: Math.floor(e.receivedAt / 1000),
      type: "nft.listing",
      tokenId,
      priceWei: l.unitPriceWei.toString(),
      currency: l.currency,
      maker: l.maker,
      expiresAt: Math.floor(l.expiresAtMs / 1000),
      orderHash: l.orderHash,
      itemName: l.name,
      imageUrl: l.imageUrl,
      floorWei: floorWei === null ? null : floorWei.toString(),
      floorAt: floor ? Math.floor(floor.at.getTime() / 1000) : null,
      rank: rank?.rank ?? null,
      maxRank: rank?.maxRank ?? null,
    }
    try {
      await store.writeOffchain([{ event }], async (tx) => {
        // The state is decided again here, where it cannot race: a listing that is not lower than
        // the one written meanwhile (or the same order seen twice) rolls the event back.
        const set = await tx`
          insert into indexer.nft_listing_state (contract, token_id, last_price_wei, order_hash, expires_at)
          values (${contract}, ${tokenId}, ${l.unitPriceWei.toString()}, ${l.orderHash}, ${new Date(l.expiresAtMs)})
          on conflict (contract, token_id) do update set
            last_price_wei = excluded.last_price_wei, order_hash = excluded.order_hash,
            expires_at = excluded.expires_at
          where indexer.nft_listing_state.last_price_wei > excluded.last_price_wei
            or indexer.nft_listing_state.expires_at <= ${new Date(at)}
          returning 1`
        if (set.length === 0) throw new ListingStale()
        // State rows are replaced by the item's next listing; the daily prune deletes expired ones.
        // The item's name and image have no retention (see the shortcut in `pruneNft`).
        await tx`
          insert into indexer.nft_items_seen (contract, token_id, name, image_url, seen_at)
          values (${contract}, ${tokenId}, ${l.name}, ${l.imageUrl}, ${new Date(at)})
          on conflict (contract, token_id) do update set
            name = coalesce(excluded.name, indexer.nft_items_seen.name),
            image_url = coalesce(excluded.image_url, indexer.nft_items_seen.image_url),
            seen_at = excluded.seen_at`
        await tx`
          update indexer.nft_collections set
            last_listing_at = greatest(last_listing_at, ${new Date(at)}::timestamptz)
          where contract = ${contract}`
      })
    } catch (err) {
      if (!(err instanceof ListingStale)) throw err
    }
  }

  /** A cancel, sale or transfer: the next listing of the item is judged afresh. */
  async function onEnded(e: StreamEvent): Promise<void> {
    await sql`
      delete from indexer.nft_listing_state where contract = ${e.contract} and token_id = ${e.tokenId}`
  }

  // shortcut: the bursts are counted in memory, so a restart forgets a partial count (a reveal
  // that straddles it is marked 20 events later). Count in the database if that ever matters.
  const bursts = new Map<string, { times: number[]; quietUntil: number }>()

  /**
   * 20 metadata updates of one collection within 10 minutes mark its traits re-check due and its
   * verdict dirty (a reveal looks like this). Then the collection is left alone for the window, so a
   * long reveal is re-checked at most every 10 minutes. A collection whose traits passed has
   * nothing to re-check.
   */
  async function onMetadata(e: StreamEvent): Promise<void> {
    const t = e.receivedAt
    const b = bursts.get(e.contract) ?? { times: [], quietUntil: 0 }
    bursts.set(e.contract, b)
    if (t < b.quietUntil) return
    b.times = b.times.filter((x) => x > t - METADATA_BURST_WINDOW_MS)
    b.times.push(t)
    if (b.times.length < METADATA_BURST_COUNT) return
    b.times = []
    b.quietUntil = t + METADATA_BURST_WINDOW_MS
    await sql`
      update indexer.nft_collections set
        next_traits_at = ${new Date(now())}, verdict_dirty = true
      where contract = ${e.contract} and traits_state <> 'pass'`
  }

  return {
    async handleStreamEvent(e: StreamEvent): Promise<void> {
      const handler =
        e.type === "item_listed"
          ? onListed
          : e.type === "item_metadata_updated"
            ? onMetadata
            : onEnded
      try {
        await inOrder(itemKey(e.contract, e.tokenId), () => handler(e))
      } catch (err) {
        log("error", "listing event not handled", {
          type: e.type,
          contract: e.contract,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        })
        try {
          deps.report?.(err)
        } catch {}
      }
    },
  }
}

export type Listings = ReturnType<typeof createListings>
