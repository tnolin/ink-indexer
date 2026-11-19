import type { Sql } from "@ink-indexer/db"
import { type NftSaleEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import {
  INK_CHAIN_ID,
  NFTX_LOCKER,
  type NftxListingRead,
  type NftxLog,
  nftxOrderHash,
  splitTotal,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../../chain"
import type { Logger } from "../../log"
import { seenItems } from "../opensea/listings"
import { cachedRanks, itemKey } from "../opensea/ranks"
import type { EventRow } from "../source"
import { combineFloor, floorParts } from "./floor"
import { type LogItem, spotAt, spotPrices } from "./spot"
import type { PricePoint } from "./stats"

const E18 = 10n ** 18n
const ZERO = "0x0000000000000000000000000000000000000000"

export type SaleVia = "listing" | "instant_sell" | "instant_buy"

export type SaleDraft = {
  collection: Address
  tokenId: bigint
  /** Wei for this one NFT. */
  priceWei: bigint
  buyer: Address
  seller: Address
  via: SaleVia
  /** The log the item was classified at. */
  logIndex: number
}

/** One decoded log of a transaction. */
export type TxLog = { block: bigint; logIndex: number; d: NftxLog }

export type SaleReads = {
  /** The Listings contract's record of an item at the block before the transaction, keyed `collection:tokenId`; null when the call reverted. */
  listingsBefore: Map<string, NftxListingRead | null>
  /** The pool's spot price, wei per NFT, at a log; null when it has none. */
  spotAt: (block: bigint, logIndex: number, collection: Address) => bigint | null
  warn: (msg: string, fields: Record<string, unknown>) => void
}

const key = (collection: Address, tokenId: bigint) => `${collection}:${tokenId}`
const unique = (ids: bigint[]) => [...new Set(ids)]

/**
 * The sales of one transaction, from its NFTX logs in log order. An item is sold once per
 * transaction: the first log that classifies it wins.
 *
 * - A listing fill is bought by the recipient of the item's `TokenWithdrawal` and sold by the
 *   listing's owner, or by the Locker when the owner is zero (a floor item). A Zap's `ethSpent` is
 *   split across the filled items in proportion to their listing prices; without a Zap each is
 *   priced at its listing price times the spot.
 * - A relist pays the old owner and the new listing's owner is the buyer. A relist of a floor item
 *   (zero owner) pays nobody and is no sale.
 * - An instant sell is bought by the Locker and an instant buy sold by it; the trade's total is
 *   split evenly across its items.
 *
 * A total is split rounded down per item with the remainder on the last item.
 */
export function classifySales(tx: TxLog[], reads: SaleReads): SaleDraft[] {
  const withdrawn = new Map<string, Address>()
  const zapSpent = new Map<Address, bigint>()
  for (const { d } of tx) {
    if (d.kind === "withdrawal") withdrawn.set(key(d.collection, d.tokenId), d.recipient)
    if (d.kind === "zapBought")
      zapSpent.set(d.collection, (zapSpent.get(d.collection) ?? 0n) + d.ethSpent)
  }
  const fills = pricedFills(tx, withdrawn, zapSpent, reads)

  const out: SaleDraft[] = []
  const sold = new Set<string>()
  const add = (s: SaleDraft) => {
    const k = key(s.collection, s.tokenId)
    if (sold.has(k)) return
    sold.add(k)
    out.push(s)
  }
  for (const { block, logIndex, d } of tx) {
    switch (d.kind) {
      case "filled":
        for (const id of unique(d.tokenIds)) {
          const fill = fills.get(key(d.collection, id))
          if (fill) add(fill)
        }
        break
      case "relisted": {
        const read = reads.listingsBefore.get(key(d.collection, d.tokenId))
        const at = { collection: d.collection, tokenId: d.tokenId.toString() }
        if (read === undefined || read === null) {
          reads.warn("ignoring a relist: the listing read reverted", at)
          break
        }
        if (read.owner === ZERO) break
        const spot = reads.spotAt(block, logIndex, d.collection)
        if (read.priceTokens === null || spot === null) {
          reads.warn(
            "ignoring a relist: the listing read has no price or the pool has no price",
            at,
          )
          break
        }
        add({
          collection: d.collection,
          tokenId: d.tokenId,
          priceWei: (read.priceTokens * spot) / E18,
          buyer: d.listing.owner,
          seller: read.owner,
          via: "listing",
          logIndex,
        })
        break
      }
      case "zapSold":
      case "gatedSale": {
        const ids = unique(d.tokenIds)
        const parts = splitTotal(
          d.ethReceived,
          ids.map(() => 1n),
        )
        for (const [i, id] of ids.entries())
          add({
            collection: d.collection,
            tokenId: id,
            priceWei: parts[i]!,
            buyer: NFTX_LOCKER,
            seller: d.seller,
            via: "instant_sell",
            logIndex,
          })
        break
      }
      case "zapRedeemed": {
        const ids = unique(d.tokenIds)
        const parts = splitTotal(
          d.ethSpent,
          ids.map(() => 1n),
        )
        for (const [i, id] of ids.entries())
          add({
            collection: d.collection,
            tokenId: id,
            priceWei: parts[i]!,
            buyer: d.redeemer,
            seller: NFTX_LOCKER,
            via: "instant_buy",
            logIndex,
          })
        break
      }
      default:
        break
    }
  }
  return out
}

/** The listing fills of a transaction by item, each at the first fill log that names it. */
function pricedFills(
  tx: TxLog[],
  withdrawn: Map<string, Address>,
  zapSpent: Map<Address, bigint>,
  reads: SaleReads,
): Map<string, SaleDraft> {
  type Fill = {
    collection: Address
    tokenId: bigint
    block: bigint
    logIndex: number
    buyer: Address
    read: NftxListingRead
  }
  const items = new Map<string, Fill>()
  const missed = new Set<string>()
  for (const { block, logIndex, d } of tx) {
    if (d.kind !== "filled") continue
    for (const id of unique(d.tokenIds)) {
      const k = key(d.collection, id)
      if (items.has(k) || missed.has(k)) continue
      const at = { collection: d.collection, tokenId: id.toString() }
      const buyer = withdrawn.get(k)
      if (!buyer) {
        reads.warn("ignoring a fill: the item has no withdrawal in its transaction", at)
        missed.add(k)
        continue
      }
      const read = reads.listingsBefore.get(k)
      if (!read) {
        reads.warn("ignoring a fill: the listing read reverted", at)
        missed.add(k)
        continue
      }
      items.set(k, { collection: d.collection, tokenId: id, block, logIndex, buyer, read })
    }
  }

  const byCollection = new Map<Address, Fill[]>()
  for (const it of items.values())
    byCollection.set(it.collection, [...(byCollection.get(it.collection) ?? []), it])

  const out = new Map<string, SaleDraft>()
  for (const [collection, list] of byCollection) {
    const total = zapSpent.get(collection)
    // With a Zap's total, the parts follow the listing prices; when any price is unreadable, they are equal.
    const prices = list.map((it) => it.read.priceTokens)
    const parts =
      total === undefined
        ? null
        : splitTotal(
            total,
            prices.every((p) => p !== null) ? (prices as bigint[]) : list.map(() => 1n),
          )
    for (const [i, it] of list.entries()) {
      const spot = reads.spotAt(it.block, it.logIndex, collection)
      const tokens = it.read.priceTokens
      let priceWei: bigint
      if (parts) priceWei = parts[i]!
      else if (tokens !== null && spot !== null) priceWei = (tokens * spot) / E18
      else {
        reads.warn("ignoring a fill: the listing read has no price or the pool has no price", {
          collection,
          tokenId: it.tokenId.toString(),
        })
        continue
      }
      const floorItem = it.read.owner === ZERO
      out.set(key(collection, it.tokenId), {
        collection,
        tokenId: it.tokenId,
        priceWei,
        buyer: it.buyer,
        seller: floorItem ? NFTX_LOCKER : it.read.owner,
        via: floorItem ? "instant_buy" : "listing",
        logIndex: it.logIndex,
      })
    }
  }
  return out
}

/** One `nft_sales` row of an NFTX sale. */
export type SaleRow = {
  txHash: Hash
  logIndex: number
  collection: Address
  tokenId: bigint
  priceWei: bigint
  buyer: Address
  seller: Address
  orderHash: Hash
  block: bigint
}

export type SalesPlan = {
  rows: SaleRow[]
  events: EventRow[]
  /** Items whose listing ended in this span: filled, relisted, cancelled or closed as stale. */
  closed: { collection: Address; tokenId: bigint }[]
}

/**
 * Sales of a span. Only collections the source knows are read. Listings are read one block before
 * each transaction with fills or relists, and the pool's spot at a log is the newest price at or
 * before it, from this span's prices and the stored ones.
 */
export async function planSales(
  deps: { sql: Sql; chain: Pick<Chain, "readNftxListings">; logger: Logger },
  input: {
    items: LogItem[]
    /** The collection's NFTX link name, null while it has none; undefined for a collection the source does not know. */
    slugOf: (collection: Address) => string | null | undefined
    prices: PricePoint[]
    timestamp: (block: bigint) => number
  },
): Promise<SalesPlan> {
  const { sql, chain, logger } = deps
  const plan: SalesPlan = { rows: [], events: [], closed: [] }
  const known = input.items.filter((i) => input.slugOf(i.d.collection) !== undefined)

  for (const { d } of known) {
    const ids =
      d.kind === "filled" || d.kind === "cancelled"
        ? d.tokenIds
        : d.kind === "relisted" || d.kind === "stale"
          ? [d.tokenId]
          : []
    for (const tokenId of ids) plan.closed.push({ collection: d.collection, tokenId })
  }

  const txs = new Map<Hash, LogItem[]>()
  for (const i of known)
    txs.set(i.log.transactionHash, [...(txs.get(i.log.transactionHash) ?? []), i])
  const sellers = [...txs].filter(([, logs]) =>
    logs.some(({ d }) =>
      ["filled", "relisted", "zapSold", "gatedSale", "zapRedeemed"].includes(d.kind),
    ),
  )
  if (sellers.length === 0) return plan

  // Listings one block before each block with a fill or a relist.
  const listed = new Map<bigint, Map<string, { collection: Address; tokenId: bigint }>>()
  for (const { log, d } of known) {
    const ids = d.kind === "filled" ? d.tokenIds : d.kind === "relisted" ? [d.tokenId] : []
    for (const tokenId of ids) {
      const at = listed.get(log.blockNumber) ?? new Map()
      at.set(`${d.collection}:${tokenId}`, { collection: d.collection, tokenId })
      listed.set(log.blockNumber, at)
    }
  }
  const before = new Map<bigint, Map<string, NftxListingRead | null>>()
  for (const [block, items] of listed) {
    const list = [...items.values()]
    const read = await chain.readNftxListings(list, block - 1n)
    before.set(
      block,
      new Map(list.map((it, i) => [`${it.collection}:${it.tokenId}`, read[i] ?? null])),
    )
  }

  const spots = await spotPrices(sql, known, input.prices)
  const drafts: { txHash: Hash; blockHash: Hash; block: bigint; draft: SaleDraft }[] = []
  for (const [txHash, logs] of sellers) {
    const first = logs[0]!.log
    const block = first.blockNumber
    for (const draft of classifySales(
      logs.map(({ log, d }) => ({ block: log.blockNumber, logIndex: log.logIndex, d })),
      {
        listingsBefore: before.get(block) ?? new Map(),
        spotAt: (b, logIndex, collection) => spotAt(spots.get(collection), b, logIndex),
        warn: (msg, fields) => logger("warn", msg, { ...fields, tx: txHash }),
      },
    ))
      drafts.push({ txHash, blockHash: first.blockHash, block, draft })
  }
  if (drafts.length === 0) return plan

  const collections = [...new Set(drafts.map((x) => x.draft.collection))]
  const items = [
    ...new Map(
      drafts.map((x) => [
        itemKey(x.draft.collection, x.draft.tokenId.toString()),
        { contract: x.draft.collection, tokenId: x.draft.tokenId.toString() },
      ]),
    ).values(),
  ]
  const [parts, ranks, seen] = await Promise.all([
    floorParts(sql, collections),
    cachedRanks(sql, items, new Date()),
    seenItems(sql, items),
  ])
  for (const { txHash, blockHash, block, draft: s } of drafts) {
    const orderHash = nftxOrderHash(txHash, s.logIndex, s.tokenId)
    plan.rows.push({
      txHash,
      logIndex: s.logIndex,
      collection: s.collection,
      tokenId: s.tokenId,
      priceWei: s.priceWei,
      buyer: s.buyer,
      seller: s.seller,
      orderHash,
      block,
    })
    const k = itemKey(s.collection, s.tokenId.toString())
    const floor = combineFloor({
      osFloorWei: parts.get(s.collection)?.osFloorWei ?? null,
      osAt: parts.get(s.collection)?.osAt ?? null,
      nftxFloorWei: spotAt(spots.get(s.collection), block, s.logIndex),
    })
    const event: NftSaleEvent = {
      v: SCHEMA_VERSION,
      chainId: INK_CHAIN_ID,
      type: "nft.sale",
      contract: s.collection,
      source: "chain",
      txHash,
      logIndex: s.logIndex,
      blockNumber: block.toString(),
      blockTimestamp: input.timestamp(block),
      tokenId: s.tokenId.toString(),
      priceWei: s.priceWei.toString(),
      currency: "ETH",
      buyer: s.buyer,
      seller: s.seller,
      orderHash,
      itemName: seen.get(k)?.name ?? null,
      imageUrl: seen.get(k)?.imageUrl ?? null,
      rank: ranks.get(k)?.rank ?? null,
      maxRank: ranks.get(k)?.maxRank ?? null,
      floorWei: floor.floorWei?.toString() ?? null,
      market: "nftx",
      via: s.via,
      nftxSlug: input.slugOf(s.collection) ?? null,
    }
    plan.events.push({ event, block, blockHash, sub: `sale:${s.tokenId}` })
  }
  return plan
}
