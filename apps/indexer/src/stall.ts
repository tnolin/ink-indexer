import type { Logger } from "./log"

/** How long the cursor may stay put while behind head before the process exits. */
export const STALL_MS = 5 * 60_000

/**
 * Detects an indexer that is alive but making no progress. The cursor must move, or reach head,
 * within `stallMs`; `getHead` is the last head the loop observed (undefined until the first tick),
 * so an idle chain with the cursor at head never counts as stalled.
 */
export function createStallWatchdog(deps: {
  /** The stored cursor block, or null when nothing is stored yet. */
  getCursor: () => Promise<bigint | null>
  getHead: () => bigint | undefined
  now: () => number
  stallMs?: number
  logger: Logger
  onStall: () => void
}) {
  const { getCursor, getHead, now, stallMs = STALL_MS, logger, onStall } = deps
  let last: bigint | null | undefined
  let movedAt = now()
  let fired = false
  return {
    async check() {
      const cursor = await getCursor()
      const head = getHead()
      const t = now()
      if (head === undefined || (cursor !== null && cursor >= head) || cursor !== last) {
        last = cursor
        movedAt = t
        return
      }
      if (fired || t - movedAt < stallMs) return
      fired = true
      logger(
        "error",
        `indexer stalled: cursor ${cursor ?? "none"} behind head ${head} for ${Math.round((t - movedAt) / 1000)} s`,
      )
      onStall()
    },
  }
}
