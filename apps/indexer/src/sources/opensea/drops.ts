import type { NftDropEvent, NftDropStage } from "@ink-indexer/events"
import { SCHEMA_VERSION } from "@ink-indexer/events"
import { INK_CHAIN_ID, type OsDrop, parseDrop } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { DROP_404_RECHECK_MS, DROPS_LEAD_MS, JOBS_PER_TICK, SCHEDULER_TICK_MS } from "../nft/policy"
import type { Tx } from "../source"
import { answeredFor, failedFor } from "./backoff"
import { commonOutcome, type Job, type JobOutcome, OS_REQUEST, type OsJobDeps } from "./scheduler"
import { canonicalJson } from "./snapshot"

const stagesOf = (d: OsDrop): NftDropStage[] =>
  d.stages.map((s) => ({
    type: s.type,
    label: s.label,
    priceWei: s.priceWei.toString(),
    startTime: s.startTime,
    endTime: s.endTime,
    maxPerWallet: s.maxPerWallet,
    allowlistCount: s.allowlistCount,
  }))

/**
 * Collections with a slug whose drop page is due. The page is read when a SeaDrop configuration log
 * names the collection, and once more an hour before the first stage starts. A collection with no
 * drop page yet is read again daily until its first mint.
 */
export function createDropsJob(deps: OsJobDeps): Job {
  const { sql, store, rest } = deps
  const now = deps.now ?? Date.now

  const reschedule = (contract: string, at: Date | null) =>
    sql`update indexer.nft_collections set next_drops_at = ${at} where contract = ${contract}`

  /** An error that is not "not found": try again later, further apart while it keeps failing. */
  const errored = async (contract: string, client = false) =>
    reschedule(contract, new Date(now() + (await failedFor(sql, contract, "drops", client))))

  /** No drop page: record it, and look again a day later unless the collection has minted. */
  const missing = (contract: string, minted: boolean) =>
    sql`
      update indexer.nft_collections set drop_404_at = ${new Date(now())},
        next_drops_at = ${minted ? null : new Date(now() + DROP_404_RECHECK_MS)}
      where contract = ${contract}`

  return {
    name: "opensea-drops",
    usesApi: true,
    everyMs: SCHEDULER_TICK_MS,
    async due(sql, at) {
      const rows = await sql<{ contract: string }[]>`
        select contract from indexer.nft_collections
        where slug is not null and next_drops_at <= ${at}
        order by next_drops_at limit ${JOBS_PER_TICK}`
      return rows.map((r) => r.contract)
    },
    async run(contract): Promise<JobOutcome> {
      const [row] = await sql<
        {
          slug: string | null
          drop_n: number
          stages: NftDropStage[] | null
          max_supply: string | null
          first_mint_block: string | null
        }[]
      >`
        select c.slug, c.drop_n, d.stages, d.max_supply::text as max_supply,
          c.first_mint_block::text as first_mint_block
        from indexer.nft_collections c left join indexer.nft_drops d on d.contract = c.contract
        where c.contract = ${contract}`
      if (!row?.slug) return

      const page = await rest.get(`/drops/${row.slug}`, 2, parseDrop, OS_REQUEST)
      if (!page.ok) {
        const early = commonOutcome(page)
        if (early) return early
        // No drop page: asked again daily until the collection's first mint, then not until a
        // configuration log names it. Another error: soon.
        if (page.reason === "not_found") {
          await answeredFor(sql, contract, "drops")
          await missing(contract, row.first_mint_block !== null)
        } else await errored(contract, page.client === true)
        return
      }
      if (!page.value) return void (await errored(contract))
      await answeredFor(sql, contract, "drops")

      const t = now()
      const stages = stagesOf(page.value)
      const maxSupply = page.value.maxSupply === null ? null : page.value.maxSupply.toString()
      const firstStart = stages[0] ? new Date(stages[0].startTime * 1000) : null
      // Read again just before the first stage starts, if that is still ahead.
      const refetch =
        firstStart && firstStart.getTime() - DROPS_LEAD_MS > t
          ? new Date(firstStart.getTime() - DROPS_LEAD_MS)
          : null
      const changed =
        row.stages === null ||
        canonicalJson(row.stages) !== canonicalJson(stages) ||
        row.max_supply !== maxSupply

      const save = async (tx: Tx) => {
        await tx`
          insert into indexer.nft_drops (contract, slug, stages, max_supply, fetched_at)
          values (${contract}, ${row.slug}, ${tx.json(stages as never)}, ${maxSupply}, ${new Date(t)})
          on conflict (contract) do update set
            slug = excluded.slug, stages = excluded.stages, max_supply = excluded.max_supply,
            fetched_at = excluded.fetched_at`
        await tx`
          update indexer.nft_collections
          set drop_first_start = ${firstStart}, next_drops_at = ${refetch}, drop_404_at = null,
            verdict_dirty = verdict_dirty or ${changed}
          where contract = ${contract}`
      }

      if (!changed) return void (await sql.begin(save))

      const event: NftDropEvent = {
        v: SCHEMA_VERSION,
        chainId: INK_CHAIN_ID,
        contract: contract as Address,
        source: "opensea",
        txHash: `os:drop:${contract}:${row.drop_n + 1}`,
        logIndex: 0,
        blockNumber: "0",
        blockTimestamp: Math.floor(t / 1000),
        type: "nft.drop",
        slug: row.slug,
        maxSupply,
        stages,
      }
      await store.writeOffchain([{ event }], async (tx) => {
        await save(tx)
        const moved = await tx`
          update indexer.nft_collections set drop_n = drop_n + 1
          where contract = ${contract} and drop_n = ${row.drop_n} returning 1`
        if (moved.length === 0)
          throw new Error(`nft.drop of ${contract} changed while it was being written`)
      })
    },
  }
}
