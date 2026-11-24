import type { Sql } from "@ink-indexer/db"
import { type NftListingEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import { INK_CHAIN_ID, type NftxListingRead, nftxOrderHash } from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../../chain"
import type { Logger } from "../../log"
import { LISTING_WAIT_MS, NEAR_FLOOR_RATIO } from "../nft/policy"
import { seenItems } from "../opensea/listings"
import { cachedRanks, itemKey, type Ranks } from "../opensea/ranks"
import type { EventRow } from "../source"
import { combineFloor, floorParts } from "./floor"
import type { TxLog } from "./sales"
import { type LogItem, spotAt, spotPrices } from "./spot"
import type { PricePoint } from "./stats"

export type ListingType = "liquid" | "dutch"

export type ListingDraft = {
  collection: Address
  tokenId: bigint
  /** The listing's owner. */
  maker: Address
  /** Wei for this one NFT. */
  priceWei: bigint
  /** 100 is 1.00x the pool's price. */
  floorMultiple: number
  listingType: ListingType | null
  /** Unix seconds. */
  expiresAt: number
  block: bigint
  logIndex: number
}

export type ListingReads = {
  /** The Listings contract's record of an item at the log's block, keyed `collection:tokenId`; null when the call reverted. */
  at: Map<string, NftxListingRead | null>
  spotAt: (block: bigint, logIndex: number, collection: Address) => bigint | null
  /** Unix seconds of a block. */
  timestamp: (block: bigint) => number
  warn: (msg: string, fields: Record<string, unknown>) => void
}

const ZERO = "0x0000000000000000000000000000000000000000"
const key = (collection: Address, tokenId: bigint) => `${collection}:${tokenId}`

/**
 * The listings the logs announce: one per id of a `ListingsCreated`, and one for each relist and
 * floor-multiple update. Every listing counts, whatever its price and expiry; one whose pool has no
 * price is not announced. The price is the listing's floor multiple times the pool's spot price at
 * the log. A relist and an update take their type, and an update its owner and times, from the
 * Listings contract at the block; a read that reverts announces nothing.
 */
export function listingDrafts(logs: TxLog[], reads: ListingReads): ListingDraft[] {
  const out: ListingDraft[] = []
  const add = (
    log: { block: bigint; logIndex: number },
    l: Omit<ListingDraft, "block" | "logIndex" | "priceWei" | "expiresAt"> & {
      created: number
      duration: number
    },
  ) => {
    const spot = reads.spotAt(log.block, log.logIndex, l.collection)
    if (spot === null) return
    const expiresAt = l.created + l.duration
    const { created: _c, duration: _d, ...rest } = l
    out.push({ ...rest, ...log, priceWei: (BigInt(l.floorMultiple) * spot) / 100n, expiresAt })
  }
  for (const { block, logIndex, d } of logs) {
    const at = { block, logIndex }
    switch (d.kind) {
      case "listingsCreated":
        for (const tokenId of new Set(d.tokenIds))
          add(at, {
            collection: d.collection,
            tokenId,
            maker: d.listing.owner,
            floorMultiple: d.listing.floorMultiple,
            listingType: d.listingType,
            created: d.listing.created,
            duration: d.listing.duration,
          })
        break
      case "relisted": {
        const read = reads.at.get(key(d.collection, d.tokenId))
        if (!read) {
          reads.warn("ignoring a relisting: the listing read reverted", {
            collection: d.collection,
            tokenId: d.tokenId.toString(),
          })
          break
        }
        add(at, {
          collection: d.collection,
          tokenId: d.tokenId,
          maker: d.listing.owner,
          floorMultiple: d.listing.floorMultiple,
          listingType: read.type,
          created: d.listing.created,
          duration: d.listing.duration,
        })
        break
      }
      case "multipleUpdated": {
        const read = reads.at.get(key(d.collection, d.tokenId))
        if (!read) {
          reads.warn("ignoring a floor-multiple update: the listing read reverted", {
            collection: d.collection,
            tokenId: d.tokenId.toString(),
          })
          break
        }
        // The listing is gone by the end of the block (filled or cancelled after the update).
        if (read.owner === ZERO) break
        add(at, {
          collection: d.collection,
          tokenId: d.tokenId,
          maker: read.owner,
          floorMultiple: d.newMultiple,
          listingType: read.type,
          created: read.created,
          duration: read.duration,
        })
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * `nft.listing` events of a span. Only collections the source knows are read. The rank of a listing
 * within a tenth of the floor is fetched from OpenSea when its services run and the span is live;
 * every other listing carries a cached one.
 *
 * shortcut: ranks are fetched one at a time, each waiting up to `LISTING_WAIT_MS` for a budget
 * token, so a batch of many near-floor listings is slow. Fetch them in parallel if that shows.
 */
export async function planListings(
  deps: {
    sql: Sql
    chain: Pick<Chain, "readNftxListings">
    logger: Logger
    ranks: { current: Pick<Ranks, "getRank"> | null }
  },
  input: {
    items: LogItem[]
    slugOf: (collection: Address) => string | null | undefined
    prices: PricePoint[]
    timestamp: (block: bigint) => number
    /** Whether the span is the live tick's. */
    live: boolean
  },
): Promise<EventRow[]> {
  const { sql, chain, logger } = deps
  const known = input.items.filter(
    (i) =>
      ["listingsCreated", "relisted", "multipleUpdated"].includes(i.d.kind) &&
      input.slugOf(i.d.collection) !== undefined,
  )
  if (known.length === 0) return []

  // Relists and updates are read at their block.
  const wanted = new Map<
    bigint,
    Map<string, { collection: Address; tokenId: bigint; listings: Address }>
  >()
  for (const { log, d } of known) {
    if (d.kind !== "relisted" && d.kind !== "multipleUpdated") continue
    const at = wanted.get(log.blockNumber) ?? new Map()
    at.set(key(d.collection, d.tokenId), {
      collection: d.collection,
      tokenId: d.tokenId,
      listings: log.address,
    })
    wanted.set(log.blockNumber, at)
  }
  const read = new Map<bigint, Map<string, NftxListingRead | null>>()
  for (const [block, items] of wanted) {
    const list = [...items.values()]
    const out = await chain.readNftxListings(list, block)
    read.set(block, new Map(list.map((it, i) => [key(it.collection, it.tokenId), out[i] ?? null])))
  }

  const spots = await spotPrices(sql, known, input.prices)
  const txs = new Map<Hash, LogItem[]>()
  for (const i of known)
    txs.set(i.log.transactionHash, [...(txs.get(i.log.transactionHash) ?? []), i])
  const drafts: { txHash: Hash; blockHash: Hash; draft: ListingDraft }[] = []
  for (const [txHash, logs] of txs)
    for (const draft of listingDrafts(
      logs.map(({ log, d }) => ({ block: log.blockNumber, logIndex: log.logIndex, d })),
      {
        at: read.get(logs[0]!.log.blockNumber) ?? new Map(),
        spotAt: (block, logIndex, collection) => spotAt(spots.get(collection), block, logIndex),
        timestamp: input.timestamp,
        warn: (msg, fields) => logger("warn", msg, { ...fields, tx: txHash }),
      },
    ))
      drafts.push({ txHash, blockHash: logs[0]!.log.blockHash, draft })
  if (drafts.length === 0) return []

  const items = [
    ...new Map(
      drafts.map((x) => [
        itemKey(x.draft.collection, x.draft.tokenId.toString()),
        { contract: x.draft.collection, tokenId: x.draft.tokenId.toString() },
      ]),
    ).values(),
  ]
  const [parts, cached, seen] = await Promise.all([
    floorParts(sql, [...new Set(drafts.map((x) => x.draft.collection))], true),
    cachedRanks(sql, items, new Date()),
    seenItems(sql, items),
  ])

  const events: EventRow[] = []
  for (const { txHash, blockHash, draft: l } of drafts) {
    const at = input.timestamp(l.block)
    const p = parts.get(l.collection)
    const spot = spotAt(spots.get(l.collection), l.block, l.logIndex)
    const floor = combineFloor({
      osFloorWei: p?.osFloorWei ?? null,
      osAt: p?.osAt ?? null,
      nftxFloorWei: spot,
    })
    const k = itemKey(l.collection, l.tokenId.toString())
    const near =
      floor.floorWei !== null &&
      l.priceWei * NEAR_FLOOR_RATIO.den <= floor.floorWei * NEAR_FLOOR_RATIO.num
    const rank =
      near && input.live && deps.ranks.current
        ? await deps.ranks.current.getRank(l.collection, l.tokenId.toString(), {
            maxWaitMs: LISTING_WAIT_MS,
          })
        : (cached.get(k) ?? null)
    const orderHash = nftxOrderHash(txHash, l.logIndex, l.tokenId)
    const event: NftListingEvent = {
      v: SCHEMA_VERSION,
      chainId: INK_CHAIN_ID,
      type: "nft.listing",
      contract: l.collection,
      source: "chain",
      txHash,
      logIndex: l.logIndex,
      blockNumber: l.block.toString(),
      blockTimestamp: at,
      tokenId: l.tokenId.toString(),
      priceWei: l.priceWei.toString(),
      currency: "ETH",
      maker: l.maker,
      expiresAt: l.expiresAt,
      orderHash,
      itemName: seen.get(k)?.name ?? null,
      imageUrl: seen.get(k)?.imageUrl ?? null,
      floorWei: floor.floorWei?.toString() ?? null,
      // The pool's price holds until its next swap, so as of this event; OpenSea's has its own time.
      floorAt: floor.market === "nftx" ? at : p?.osAt ? Math.floor(p.osAt.getTime() / 1000) : null,
      rank: rank?.rank ?? null,
      maxRank: rank?.maxRank ?? null,
      market: "nftx",
      floorMultiple: l.floorMultiple,
      listingType: l.listingType,
      nftxSlug: input.slugOf(l.collection) ?? null,
    }
    events.push({ event, block: l.block, blockHash, sub: `list:${l.tokenId}` })
  }
  return events
}
