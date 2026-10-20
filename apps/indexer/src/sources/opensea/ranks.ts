import type { Sql } from "@ink-indexer/db"
import { parseNft } from "@ink-indexer/sdk"
import type { Logger } from "../../log"
import { RANK_CACHE_MS } from "../nft/policy"
import type { OpenSeaRest } from "./rest"

/** OpenSea's rarity rank of an item and the highest rank of its collection. */
export type Rank = { rank: number; maxRank: number }

const INT_MAX = 2_147_483_647

/** The key of an item in the maps below. */
export const itemKey = (contract: string, tokenId: string) => `${contract}:${tokenId}`

/**
 * The cached ranks that are still valid at `at`, by `itemKey`: fetched under 7 days before, with the
 * `calculated_at` the collection's `rarity_calculated_at` has now (a reveal moves it). Reads only.
 */
export async function cachedRanks(
  sql: Sql,
  items: { contract: string; tokenId: string }[],
  at: Date,
): Promise<Map<string, Rank>> {
  if (items.length === 0) return new Map()
  const since = new Date(at.getTime() - RANK_CACHE_MS)
  const rows = await sql<{ contract: string; token_id: string; rank: number; max_rank: number }[]>`
    select r.contract, r.token_id::text as token_id, r.rank, r.max_rank
    from unnest(${sql.array(items.map((i) => i.contract))}::text[],
      ${sql.array(items.map((i) => i.tokenId))}::numeric[]) as q(contract, token_id)
    join indexer.nft_ranks r on r.contract = q.contract and r.token_id = q.token_id
    join indexer.nft_collections c on c.contract = r.contract
    where r.fetched_at > ${since}
      and r.calculated_at is not distinct from c.rarity_calculated_at`
  return new Map(
    rows.map((r) => [
      itemKey(r.contract, r.token_id),
      { rank: r.rank, maxRank: r.max_rank } satisfies Rank,
    ]),
  )
}

export type RanksDeps = {
  sql: Sql
  rest: OpenSeaRest
  log: Logger
  now?: () => number
}

/**
 * Item ranks, fetched lazily and one item at a time (budget class 1): never for a whole collection
 * and never for a sale. A rank OpenSea does not give is never invented, so an item without one has
 * no row.
 */
export function createRanks(deps: RanksDeps) {
  const { sql, rest } = deps
  const now = deps.now ?? Date.now

  /** The collection's rarity state and the item's cached row, if any. Null for an unknown collection. */
  async function load(contract: string, tokenId: string) {
    const [row] = await sql<
      {
        rarity_calculated_at: Date | null
        max_rank: number | null
        rank: number | null
        cached_max_rank: number | null
        cached_calculated_at: Date | null
        fetched_at: Date | null
      }[]
    >`
      select c.rarity_calculated_at, c.max_rank, r.rank, r.max_rank as cached_max_rank,
        r.calculated_at as cached_calculated_at, r.fetched_at
      from indexer.nft_collections c
      left join indexer.nft_ranks r on r.contract = c.contract and r.token_id = ${tokenId}
      where c.contract = ${contract}`
    return row ?? null
  }

  type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>
  function valid(row: Loaded): Rank | null {
    if (row.rank === null || row.cached_max_rank === null || row.fetched_at === null) return null
    if (now() - row.fetched_at.getTime() >= RANK_CACHE_MS) return null
    if (row.cached_calculated_at?.getTime() !== row.rarity_calculated_at?.getTime()) return null
    return { rank: row.rank, maxRank: row.cached_max_rank }
  }

  return {
    /** The cached rank when it is valid; no request. */
    async cachedRank(contract: string, tokenId: string): Promise<Rank | null> {
      const row = await load(contract, tokenId)
      return row ? valid(row) : null
    },

    /**
     * The item's rank: the cached one when valid, else fetched from `nfts/{id}` (waiting up to
     * `maxWaitMs` for a budget token) and cached. Null, with nothing cached, when OpenSea gives no
     * rank, the collection has no `max_rank` yet, or the request cannot be made in time.
     */
    async getRank(
      contract: string,
      tokenId: string,
      opts: { maxWaitMs: number },
    ): Promise<Rank | null> {
      const row = await load(contract, tokenId)
      if (!row) return null
      const cached = valid(row)
      if (cached) return cached

      const res = await rest.get(
        `/chain/ink/contract/${contract}/nfts/${tokenId}`,
        1,
        parseNft,
        opts,
      )
      if (!res.ok || !res.value) return null
      const rank = res.value.rank
      if (rank === null || !Number.isInteger(rank) || rank < 1 || rank > INT_MAX) return null
      if (row.max_rank === null) return null
      // The calculated_at read before the request is the one kept: if the collection's rarity moved
      // meanwhile, the row no longer matches it and the next listing fetches again.
      await sql`
        insert into indexer.nft_ranks (contract, token_id, rank, max_rank, calculated_at, fetched_at)
        values (${contract}, ${tokenId}, ${rank}, ${row.max_rank}, ${row.rarity_calculated_at}, ${new Date(now())})
        on conflict (contract, token_id) do update set rank = excluded.rank,
          max_rank = excluded.max_rank, calculated_at = excluded.calculated_at,
          fetched_at = excluded.fetched_at`
      return { rank, maxRank: row.max_rank }
    },
  }
}

export type Ranks = ReturnType<typeof createRanks>
