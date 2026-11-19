import type { Sql } from "@ink-indexer/db"
import { type NftStatsEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import { INK_CHAIN_ID } from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../../chain"
import { FLOOR_CHANGE_WINDOW_MS } from "../nft/policy"
import type { EventRow } from "../source"
import { combineFloor } from "./floor"

/** A pool price that moves this much (in percent) from the last one emitted is announced. */
const MOVE_PERCENT = 1n

export type PricePoint = {
  collection: Address
  block: bigint
  logIndex: number
  priceWei: bigint | null
  /** Unix seconds of the block. */
  at: number
}

/** What a collection's stored state says about the stats already emitted. */
export type StatsBasis = {
  /** The pool price last emitted and its block; null before the first. */
  statsPriceWei: bigint | null
  statsBlock: bigint | null
  /** When combined floor history began; null until a combined row is written live. */
  combinedSince: Date | null
  slug: string | null
  maxSupply: string | null
}

/** One `nft_stats` row written from a pool move. */
export type StatsRow = {
  collection: Address
  block: bigint
  at: number
  floorWei: bigint | null
  floorMarket: "opensea" | "nftx" | null
  osFloorWei: bigint | null
  nftxFloorWei: bigint
  poolCount: number | null
  owners: number | null
  volume24hWei: string | null
  sales24h: number | null
  totalSupply: number | null
}

export type StatsPlan = {
  rows: StatsRow[]
  events: EventRow[]
  /** Per collection, the last pool price emitted in this span and the pool size read with it. */
  last: { collection: Address; priceWei: bigint; block: bigint; poolCount: number | null }[]
  /** Collections whose combined history begins with the first row of this span. */
  combinedSince: { collection: Address; at: number }[]
}

const moved = (last: bigint, next: bigint) => {
  const diff = next > last ? next - last : last - next
  return next !== last && diff * 100n >= last * MOVE_PERCENT
}

/**
 * The price a collection's stats last announced before `block`. Stored state answers when it is
 * from an earlier block; a span that reads blocks already announced (a backfill over rows the live
 * tick wrote) looks at the rows before it, so the same moves qualify again and give the same rows.
 */
async function lastBefore(sql: Sql, collection: Address, block: bigint, basis: StatsBasis) {
  if (basis.statsBlock === null) return null
  if (basis.statsBlock < block) return basis.statsPriceWei
  const [row] = await sql<{ price: string | null }[]>`
    select nftx_floor_wei::text as price from indexer.nft_stats
    where contract = ${collection} and block is not null and block < ${block.toString()}
    order by block desc, at desc limit 1`
  return row?.price == null ? null : BigInt(row.price)
}

/**
 * Stats for the pool moves of a span. A move of at least 1% from the last announced price (or the
 * first price of a collection) is announced as `nft.stats` and stored as an `nft_stats` row carrying
 * its block. The pool size is read at the block of each move. Owners, volume and sales are copied
 * from the newest OpenSea row at or before the move's own time, so a backfilled move reads the
 * OpenSea data of its time; with no such row they are null. A pool price that is not defined is
 * never announced.
 */
export async function planStats(
  deps: { sql: Sql; chain: Pick<Chain, "readNftxPoolCounts"> },
  input: {
    prices: PricePoint[]
    basis: Map<Address, StatsBasis>
    blockHash: (block: bigint) => Hash
    /** Whether the span is the live tick's, which starts combined history. */
    live: boolean
  },
): Promise<StatsPlan> {
  const { sql, chain } = deps
  const plan: StatsPlan = { rows: [], events: [], last: [], combinedSince: [] }

  const moves: (PricePoint & { priceWei: bigint })[] = []
  const lastOf = new Map<Address, bigint | null>()
  for (const p of input.prices) {
    if (p.priceWei === null) continue
    const basis = input.basis.get(p.collection)
    if (!basis) continue
    if (!lastOf.has(p.collection))
      lastOf.set(p.collection, await lastBefore(sql, p.collection, p.block, basis))
    const last = lastOf.get(p.collection) ?? null
    if (last !== null && !moved(last, p.priceWei)) continue
    lastOf.set(p.collection, p.priceWei)
    moves.push({ ...p, priceWei: p.priceWei })
  }
  if (moves.length === 0) return plan

  // The pool size of each move's collection at its block: one read per block.
  const counts = new Map<string, number | null>()
  for (const block of new Set(moves.map((m) => m.block))) {
    const at = [...new Set(moves.filter((m) => m.block === block).map((m) => m.collection))]
    const read = await chain.readNftxPoolCounts(at, block)
    for (const [i, c] of at.entries()) counts.set(`${c}:${block}`, read[i] ?? null)
  }

  for (const m of moves) {
    const basis = input.basis.get(m.collection)!
    const when = new Date(m.at * 1000)
    const [os] = await sql<
      {
        owners: number | null
        volume: string | null
        sales: number | null
        supply: number | null
        listed: number | null
        capped: boolean | null
        floor: string | null
      }[]
    >`
      select owners, volume_24h_wei::text as volume, sales_24h as sales, total_supply as supply,
        listed_count as listed, listed_capped as capped,
        (case when floor_market is null then floor_wei else os_floor_wei end)::text as floor
      from indexer.nft_stats
      where contract = ${m.collection} and block is null and at <= ${when}
      order by at desc limit 1`
    const osFloor = os?.floor == null ? null : BigInt(os.floor)
    const floor = combineFloor({
      osFloorWei: osFloor,
      osAt: os ? when : null,
      nftxFloorWei: m.priceWei,
    })
    const [ago] =
      basis.combinedSince === null
        ? []
        : await sql<{ floor_wei: string | null }[]>`
            select floor_wei::text as floor_wei from indexer.nft_stats
            where contract = ${m.collection} and at >= ${basis.combinedSince}
              and at <= ${new Date(when.getTime() - FLOOR_CHANGE_WINDOW_MS)}
            order by at desc limit 1`
    const poolCount = counts.get(`${m.collection}:${m.block}`) ?? null

    plan.rows.push({
      collection: m.collection,
      block: m.block,
      at: m.at,
      floorWei: floor.floorWei,
      floorMarket: floor.market,
      osFloorWei: osFloor,
      nftxFloorWei: m.priceWei,
      poolCount,
      owners: os?.owners ?? null,
      volume24hWei: os?.volume ?? null,
      sales24h: os?.sales ?? null,
      totalSupply: os?.supply ?? null,
    })
    const event: NftStatsEvent = {
      v: SCHEMA_VERSION,
      chainId: INK_CHAIN_ID,
      contract: m.collection,
      source: "chain",
      txHash: `nftx:stats:${m.collection}:${m.block}:${m.logIndex}`,
      logIndex: m.logIndex,
      blockNumber: m.block.toString(),
      blockTimestamp: m.at,
      type: "nft.stats",
      floorWei: floor.floorWei?.toString() ?? null,
      floor24hAgoWei: ago?.floor_wei ?? null,
      owners: os?.owners ?? null,
      volume24hWei: os?.volume ?? null,
      sales24h: os?.sales ?? null,
      totalSupply: os?.supply == null ? null : String(os.supply),
      maxSupply: basis.maxSupply,
      listedCount: os?.listed ?? null,
      listedCapped: os?.capped ?? false,
      floorMarket: floor.market,
      nftxFloorWei: m.priceWei.toString(),
      poolCount,
      nftxSlug: basis.slug,
    }
    plan.events.push({ event, block: m.block, blockHash: input.blockHash(m.block), sub: "" })
  }

  for (const [collection, priceWei] of lastOf) {
    const own = moves.filter((m) => m.collection === collection)
    const final = own.at(-1)
    if (!final || priceWei === null) continue
    plan.last.push({
      collection,
      priceWei,
      block: final.block,
      poolCount: counts.get(`${collection}:${final.block}`) ?? null,
    })
    const basis = input.basis.get(collection)!
    if (input.live && basis.combinedSince === null)
      plan.combinedSince.push({ collection, at: own[0]!.at })
  }
  return plan
}
