import type { Logger } from "./log"

/**
 * Exit-code policy for the long-running process. A failure while running exits 1. After a
 * SIGINT/SIGTERM the process is on its way out with code 0, so later failures (for example a tick
 * cut short by the closing socket) are logged and ignored, and a second signal does nothing.
 */
export function createShutdown(deps: {
  /** Stops new work: head subscription and timers. */
  stop: () => void
  /** The tick running now, if any. */
  inFlight: () => Promise<unknown> | undefined
  /** Closes the database. */
  end: () => Promise<unknown>
  exit: (code: number) => void
  logger: Logger
  /** How long to wait for the in-flight tick before closing anyway. */
  waitMs?: number
}) {
  const { stop, inFlight, end, exit, logger, waitMs = 10_000 } = deps
  let stopping = false
  return {
    isStopping: () => stopping,
    fail(err: unknown) {
      if (stopping) {
        logger("info", "ignored error during shutdown", { error: String(err) })
        return
      }
      logger("error", "indexer stopped", { error: err instanceof Error ? err.stack : String(err) })
      exit(1)
    },
    async signal() {
      if (stopping) return
      stopping = true
      logger("info", "shutting down")
      try {
        stop()
        const tick = inFlight()
        if (tick) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            tick.catch(() => {}),
            new Promise((r) => {
              timer = setTimeout(r, waitMs)
            }),
          ]).finally(() => clearTimeout(timer))
        }
        await end()
      } catch (err) {
        logger("error", "shutdown failed", { error: String(err) })
        exit(1)
        return
      }
      exit(0)
    },
  }
}
