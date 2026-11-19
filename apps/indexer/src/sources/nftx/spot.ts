import type { Sql } from "@ink-indexer/db"
import type { ChainLog, NftxLog } from "@ink-indexer/sdk"
import type { Address } from "viem"
import type { PricePoint } from "./stats"

/** A decoded log with the log it came from. */
export type LogItem = { log: ChainLog; d: NftxLog }

type SpotList = { block: bigint; logIndex: number; priceWei: bigint }[]
export type Spots = Map<Address, SpotList>

/** The newest price at or before a log; null when there is none. */
export function spotAt(list: SpotList | undefined, block: bigint, logIndex: number) {
  let best: bigint | null = null
  for (const p of list ?? []) {
    if (p.block > block || (p.block === block && p.logIndex > logIndex)) break
    best = p.priceWei
  }
  return best
}

/** Each collection's prices around the span, in log order: the span's own and the stored ones. */
export async function spotPrices(sql: Sql, items: LogItem[], prices: PricePoint[]): Promise<Spots> {
  const collections = [...new Set(items.map((i) => i.d.collection))]
  const blocks = items.map((i) => i.log.blockNumber)
  const low = blocks.reduce((a, b) => (b < a ? b : a))
  const high = blocks.reduce((a, b) => (b > a ? b : a))
  type Stored = { collection: Address; block: string; log_index: number; price: string }[]
  const inSpan = await sql<Stored>`
    select collection, block::text, log_index, price_wei::text as price from indexer.nftx_prices
    where collection = any(${sql.array(collections)}::text[]) and price_wei is not null
      and block >= ${low.toString()} and block <= ${high.toString()}`
  const lastBefore = await sql<Stored>`
    select distinct on (collection) collection, block::text, log_index, price_wei::text as price
    from indexer.nftx_prices
    where collection = any(${sql.array(collections)}::text[]) and price_wei is not null
      and block < ${low.toString()}
    order by collection, block desc, log_index desc`
  const out: Spots = new Map()
  const push = (collection: Address, block: bigint, logIndex: number, priceWei: bigint) =>
    out.set(collection, [...(out.get(collection) ?? []), { block, logIndex, priceWei }])
  for (const r of [...inSpan, ...lastBefore])
    push(r.collection, BigInt(r.block), r.log_index, BigInt(r.price))
  for (const p of prices)
    if (p.priceWei !== null) push(p.collection, p.block, p.logIndex, p.priceWei)
  for (const list of out.values())
    list.sort((a, b) =>
      a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1,
    )
  return out
}
