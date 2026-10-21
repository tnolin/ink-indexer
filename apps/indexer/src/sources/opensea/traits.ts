import { parseNft } from "@ink-indexer/sdk"
import { JOBS_PER_TICK, SCHEDULER_TICK_MS, TRANSIENT_RETRY_MS } from "../nft/policy"
import type { TraitsState } from "../nft/verdict"
import { commonOutcome, type Job, type JobOutcome, OS_REQUEST, type OsJobDeps } from "./scheduler"

/**
 * Gate 3's sample: at each checkpoint the verdict job schedules (`next_traits_at`), one minted item
 * that has not been burned is read from `GET /chain/ink/contract/{contract}/nfts/{id}` (budget
 * class 4). Traits, or a rarity rank, make it `pass`; neither makes it `empty`; an item OpenSea does
 * not know counts as `empty` too. Each sample counts one checkpoint and marks the verdict dirty, and
 * the verdict job schedules the next. Another error tries again in five minutes without counting.
 */
export function createTraitsJob(deps: OsJobDeps): Job {
  const { sql, rest } = deps
  const now = deps.now ?? Date.now

  async function record(contract: string, state: TraitsState | null): Promise<void> {
    await sql`
      update indexer.nft_collections set
        traits_state = coalesce(${state}, traits_state),
        traits_checks = traits_checks + 1,
        next_traits_at = null,
        verdict_dirty = true
      where contract = ${contract}`
  }

  return {
    name: "opensea-traits",
    usesApi: true,
    everyMs: SCHEDULER_TICK_MS,
    async due(sql, at) {
      const rows = await sql<{ contract: string }[]>`
        select contract from indexer.nft_collections
        where next_traits_at <= ${at} and traits_state <> 'pass'
        order by next_traits_at limit ${JOBS_PER_TICK}`
      return rows.map((r) => r.contract)
    },
    async run(contract): Promise<JobOutcome> {
      const [item] = await sql<{ token_id: string }[]>`
        select m.token_id::text as token_id from indexer.nft_mints m
        where m.contract = ${contract}
          and not exists (select 1 from indexer.nft_burns b
            where b.contract = m.contract and b.token_id = m.token_id)
        order by m.block desc limit 1`
      // Nothing stored to sample (pruned or all burned): the checkpoint passes without a sample.
      if (!item) return void (await record(contract, null))

      const res = await rest.get(
        `/chain/ink/contract/${contract}/nfts/${item.token_id}`,
        4,
        parseNft,
        OS_REQUEST,
      )
      if (!res.ok) {
        const early = commonOutcome(res)
        if (early) return early
        if (res.reason === "not_found") return void (await record(contract, "empty"))
      }
      if (!res.ok || !res.value) {
        await sql`
          update indexer.nft_collections set next_traits_at = ${new Date(now() + TRANSIENT_RETRY_MS)}
          where contract = ${contract}`
        return
      }
      const nft = res.value
      await record(contract, nft.traits.length > 0 || nft.rank !== null ? "pass" : "empty")
    },
  }
}
