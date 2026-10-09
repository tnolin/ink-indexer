import type { Logger } from "./log"

/** How long the cursor may stay put, without being at a fresh head, before the process exits. */
export const STALL_MS = 5 * 60_000
const CHECK_EVERY_MS = 30_000

/**
 * Detects an indexer that is alive but making no progress. It trips when the cursor has not moved
 * for `stallMs` and either the cursor is behind the last head the loop observed, or no head fetch
 * has succeeded for `stallMs` (including never, since the watchdog started). A cursor at a head that
 * keeps being refreshed is an idle chain and never trips it. Without `getHeadFetches` the head is
 * assumed fresh, and nothing trips before a head is known.
 */
export function createStallWatchdog(deps: {
  /** The cursor block, or null when nothing is stored yet. Must not wait on I/O. */
  getCursor: () => Promise<bigint | null> | bigint | null
  /** The last head the loop observed (undefined until the first tick). */
  getHead: () => bigint | undefined
  /** A counter of successful head fetches, to tell a fresh head from a stale one. */
  getHeadFetches?: () => number
  /** Monotonic: it must not advance while the machine sleeps. */
  now: () => number
  stallMs?: number
  logger: Logger
  onStall: () => void
}) {
  const { getCursor, getHead, getHeadFetches, now, stallMs = STALL_MS, logger, onStall } = deps
  let last: bigint | null | undefined
  let movedAt = now()
  let fetches = getHeadFetches?.() ?? 0
  let fetchedAt = movedAt
  let fired = false
  return {
    async check() {
      const cursor = await getCursor()
      const head = getHead()
      const t = now()
      if (getHeadFetches) {
        const n = getHeadFetches()
        if (n !== fetches) {
          fetches = n
          fetchedAt = t
        }
      }
      const headKnown = head !== undefined
      const stale = getHeadFetches !== undefined && t - fetchedAt >= stallMs
      const behind = headKnown && (cursor === null || cursor < head)
      const idle = headKnown ? !behind && !stale : getHeadFetches === undefined
      if (cursor !== last) {
        last = cursor
        movedAt = t
        return
      }
      if (idle) {
        // Idle at head counts as progress up to the moment that head was observed.
        movedAt = getHeadFetches ? Math.max(movedAt, fetchedAt) : t
        return
      }
      if (fired || t - movedAt < stallMs) return
      fired = true
      const secs = Math.round((t - movedAt) / 1000)
      logger(
        "error",
        behind
          ? `indexer stalled: cursor ${cursor ?? "none"} behind head ${head} for ${secs} s`
          : `indexer stalled: cursor ${cursor ?? "none"} not moving and no chain head fetched for ${secs} s`,
      )
      onStall()
    },
  }
}

/** Runs the watchdog on a timer for `start`: a stall aborts the process through `shutdown` (exit 1). */
export function startStallWatch(deps: {
  indexer: {
    cursorBlock: bigint | null | undefined
    lastHead: bigint | undefined
    headFetches: number
  }
  shutdown: { abort(reason: string): Promise<void> }
  logger: Logger
  now?: () => number
  intervalMs?: number
}): ReturnType<typeof setInterval> {
  const {
    indexer,
    shutdown,
    logger,
    now = () => performance.now(),
    intervalMs = CHECK_EVERY_MS,
  } = deps
  const watchdog = createStallWatchdog({
    getCursor: () => indexer.cursorBlock ?? null,
    getHead: () => indexer.lastHead,
    getHeadFetches: () => indexer.headFetches,
    now,
    logger,
    onStall: () =>
      void shutdown.abort("indexer exiting after stall; a supervisor should restart it"),
  })
  const timer = setInterval(() => {
    watchdog.check().catch((err) => logger("warn", "stall check failed", { error: String(err) }))
  }, intervalMs)
  timer.unref()
  return timer
}
