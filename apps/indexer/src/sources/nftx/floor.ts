import type { Sql } from "@ink-indexer/db"

/** What a collection's floor is made of: the newest OpenSea floor and the pool's spot price. */
export type FloorParts = {
  /** The OpenSea floor alone, null when the newest OpenSea row has none. */
  osFloorWei: bigint | null
  /** When that OpenSea row was written; null when there is none. */
  osAt: Date | null
  /** The NFTX pool's spot price per NFT, null when the collection is not trading on NFTX. */
  nftxFloorWei: bigint | null
}

export type Floor = { floorWei: bigint | null; market: "opensea" | "nftx" | null }

/** The cheapest place to buy one: the lower of the two floors, OpenSea on a tie. */
export function combineFloor(p: FloorParts): Floor {
  const { osFloorWei: os, nftxFloorWei: nx } = p
  if (os === null)
    return nx === null ? { floorWei: null, market: null } : { floorWei: nx, market: "nftx" }
  if (nx === null || os <= nx) return { floorWei: os, market: "opensea" }
  return { floorWei: nx, market: "nftx" }
}

/** Collections whose NFTX pool is open and not sunset. */
export async function onNftx(sql: Sql, contracts: string[]): Promise<Set<string>> {
  if (contracts.length === 0) return new Set()
  const rows = await sql<{ collection: string }[]>`
    select collection from indexer.nftx_collections
    where collection = any(${sql.array(contracts)}::text[])
      and initialized_block is not null and sunset_block is null`
  return new Set(rows.map((r) => r.collection))
}

/**
 * The parts of each contract's floor. A contract with neither an OpenSea row nor an NFTX price is
 * absent. Rows written from pool moves have a block and are not OpenSea rows: their OpenSea floor
 * is a copy, so the newest OpenSea row speaks for it. Rows written before NFTX carry the raw
 * OpenSea floor in `floor_wei`; later ones in `os_floor_wei`.
 *
 * The pool's spot price is the newest one that is defined. With `nftx` false it is not read, so a
 * process that does not run the NFTX source floors a collection as it did before NFTX.
 */
export async function floorParts(
  sql: Sql,
  contracts: string[],
  nftx: boolean,
): Promise<Map<string, FloorParts>> {
  if (contracts.length === 0) return new Map()
  const rows = await sql<
    { contract: string; at: Date | null; os: string | null; nx: string | null }[]
  >`
    select q.contract, os.at, os.floor as os, nx.price_wei::text as nx
    from unnest(${sql.array(contracts)}::text[]) as q(contract)
    left join lateral (
      select at, (case when floor_market is null then floor_wei else os_floor_wei end)::text as floor
      from indexer.nft_stats where contract = q.contract and block is null
      order by at desc limit 1) os on true
    left join lateral (
      select p.price_wei from indexer.nftx_prices p
      join indexer.nftx_collections n on n.collection = p.collection
      where ${nftx} and p.collection = q.contract and p.price_wei is not null
        and n.initialized_block is not null and n.sunset_block is null
      order by p.block desc, p.log_index desc limit 1) nx on true
    where os.at is not null or nx.price_wei is not null`
  return new Map(
    rows.map((r) => [
      r.contract,
      {
        osFloorWei: r.os === null ? null : BigInt(r.os),
        osAt: r.at,
        nftxFloorWei: r.nx === null ? null : BigInt(r.nx),
      },
    ]),
  )
}
