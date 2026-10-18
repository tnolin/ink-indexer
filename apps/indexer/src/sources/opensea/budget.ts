import type { Sql } from "@ink-indexer/db"

/**
 * Who is asking, which decides how far the shared bucket may be drawn down (a share of capacity
 * kept for the classes above): 0 bot, 1 ranks, 2 discovery and drops, 3 stats, 4 background.
 */
export type BudgetClass = 0 | 1 | 2 | 3 | 4

export type Budget = {
  /** Takes one request from the shared budget, waiting up to maxWaitMs for it. False when it would not come in time. */
  take(c: BudgetClass, maxWaitMs: number): Promise<boolean>
  /** Stops every process sharing the key for ms (after a 429). */
  block(ms: number): Promise<void>
}

/**
 * The client side of the budget kept in Postgres, which every process using the same OpenSea key
 * calls (see migration 0006). `take` asks for a token and, if told to wait, sleeps that long and asks
 * again until it gets one or the wait would pass `maxWaitMs`.
 */
export function createBudget(sql: Sql): Budget {
  const now = Date.now
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  return {
    async take(c, maxWaitMs) {
      const deadline = now() + maxWaitMs
      for (;;) {
        const [row] = await sql<{ wait: number }[]>`select indexer.opensea_take(${c}) as wait`
        const wait = row?.wait ?? 0
        if (wait === 0) return true
        if (now() + wait > deadline) return false
        await sleep(wait)
      }
    },
    async block(ms) {
      await sql`select indexer.opensea_block(${Math.max(0, Math.round(ms))})`
    },
  }
}
