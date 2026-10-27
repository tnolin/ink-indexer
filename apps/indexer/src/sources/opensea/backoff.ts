import type { Sql } from "@ink-indexer/db"
import { ERROR_BACKOFF_DAILY_MS, ERROR_BACKOFF_MS, OUTAGE_BACKOFF_MAX_MS } from "../nft/policy"

/** The jobs that retry a collection after an error. */
export type BackoffJob = "discovery" | "metadata" | "drops" | "traits" | "stats"

/** Wait after the `failures`-th consecutive failure. */
export const errorBackoffMs = (failures: number): number =>
  ERROR_BACKOFF_MS[failures - 1] ?? ERROR_BACKOFF_DAILY_MS

/**
 * Counts one more consecutive failure of `job` for `contract` and returns how long to wait before
 * trying again: 5 minutes, 30 minutes, 2 hours, then a day. `client` is a 4xx answer, which is about
 * this collection and gets the whole ladder; any other error is taken to be an outage and waits at
 * most 2 hours.
 */
export async function failedFor(
  sql: Sql,
  contract: string,
  job: BackoffJob,
  client = false,
): Promise<number> {
  const [row] = await sql<{ failures: number }[]>`
    insert into indexer.nft_job_failures (contract, job, failures) values (${contract}, ${job}, 1)
    on conflict (contract, job) do update set failures = indexer.nft_job_failures.failures + 1
    returning failures`
  const wait = errorBackoffMs(row!.failures)
  return client ? wait : Math.min(wait, OUTAGE_BACKOFF_MAX_MS)
}

/** An answer came back (data, or a definite "not found"): the next failure waits the shortest time. */
export async function answeredFor(sql: Sql, contract: string, job: BackoffJob): Promise<void> {
  await sql`delete from indexer.nft_job_failures where contract = ${contract} and job = ${job}`
}
