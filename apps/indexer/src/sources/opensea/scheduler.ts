import type { Sql } from "@ink-indexer/db"
import type { Logger } from "../../log"
import type { Store } from "../../store"
import {
  JOBS_PER_TICK,
  KEY_REJECTED_PAUSE_MS,
  OPENSEA_MAX_WAIT_MS,
  SCHEDULER_TICK_MS,
} from "../nft/policy"
import type { OpenSeaRest, OsResult } from "./rest"
import type { Snapshots } from "./snapshot"

/**
 * What a run reports besides success: the request budget or a rate limit held it back (the scheduler
 * stops the job for this tick; the contract stays due), or the API refused the key (every job pauses).
 */
export type JobOutcome = "deferred" | "rejected" | undefined

export type Job = {
  name: string
  /** Minimum time between two looks at what is due, so a daily job need not query every tick. */
  everyMs: number
  /** Contracts due at `now`, oldest first. */
  due(sql: Sql, now: Date): Promise<string[]>
  /** Handles one contract. Throwing is reported and the contract is tried again next tick. */
  run(contract: string): Promise<JobOutcome>
}

export type SchedulerDeps = {
  sql: Sql
  log: Logger
  report: (err: unknown) => void
  now?: () => number
  tickMs?: number
}

/** What the OpenSea jobs share. */
export type OsJobDeps = {
  sql: Sql
  store: Store
  rest: OpenSeaRest
  snapshots: Snapshots
  log: Logger
  now?: () => number
}

/** How long a job waits for the request budget, in the form `OpenSeaRest.get` takes. */
export const OS_REQUEST = { maxWaitMs: OPENSEA_MAX_WAIT_MS }

/** The outcome for a failed request that every job treats the same way, or undefined for the rest. */
export function commonOutcome(
  r: Extract<OsResult<unknown>, { ok: false }>,
): JobOutcome | undefined {
  if (r.reason === "budget" || r.reason === "rate_limited") return "deferred"
  if (r.reason === "rejected") return "rejected"
  return undefined
}

/**
 * Runs jobs on ticks. `tick` handles whatever is due and resolves when done; it never throws, and a
 * tick that starts while another is running does nothing.
 */
export function createScheduler(jobs: Job[], deps: SchedulerDeps) {
  const { sql, log, report } = deps
  const now = deps.now ?? Date.now
  const lastLook = new Map<string, number>()
  let pausedUntil = 0
  let running = false
  let stopped = false

  const fail = (msg: string, job: Job, err: unknown, contract?: string) => {
    log("error", msg, {
      job: job.name,
      contract,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    })
    try {
      report(err)
    } catch {}
  }

  async function tick(): Promise<void> {
    if (running || stopped) return
    running = true
    try {
      if (now() < pausedUntil) return
      for (const job of jobs) {
        if (stopped) return
        const t = now()
        const last = lastLook.get(job.name)
        if (last !== undefined && t - last < job.everyMs) continue
        lastLook.set(job.name, t)
        let due: string[]
        try {
          due = await job.due(sql, new Date(t))
        } catch (err) {
          fail("opensea job query failed", job, err)
          continue
        }
        for (const contract of due.slice(0, JOBS_PER_TICK)) {
          if (stopped) return
          let outcome: JobOutcome
          try {
            outcome = await job.run(contract)
          } catch (err) {
            fail("opensea job failed", job, err, contract)
            continue
          }
          if (outcome === "deferred") break
          if (outcome === "rejected") {
            pausedUntil = now() + KEY_REJECTED_PAUSE_MS
            log("warn", "opensea jobs paused: key refused", {
              until: new Date(pausedUntil).toISOString(),
            })
            return
          }
        }
      }
    } finally {
      running = false
    }
  }

  return {
    tick,
    stop() {
      stopped = true
    },
  }
}

/** Ticks every 10 s until the returned function is called. */
export function startScheduler(jobs: Job[], deps: SchedulerDeps): () => void {
  const scheduler = createScheduler(jobs, deps)
  const timer = setInterval(() => void scheduler.tick(), deps.tickMs ?? SCHEDULER_TICK_MS)
  return () => {
    clearInterval(timer)
    scheduler.stop()
  }
}
