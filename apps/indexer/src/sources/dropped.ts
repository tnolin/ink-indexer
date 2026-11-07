import type { ChainLog } from "@ink-indexer/sdk"
import type { Hex } from "viem"
import type { Logger } from "../log"

const INTERVAL_MS = 10 * 60_000
// shortcut: emitters are remembered for the life of the process, up to this many; a flood of distinct emitters past it gets one notice and no further warnings. Evict the quietest emitter if a long-lived process needs more.
const MAX_EMITTERS = 1_000

/**
 * Warns about logs that matched a source's filter, carry one of its topics and still did not
 * decode, so a contract that emits a known event with another layout shows in the journal instead
 * of vanishing. Each emitter warns at most once per interval, with the number of logs dropped since
 * its last warning. A topic the source does not handle is not a decode failure and is not reported.
 */
export function droppedLogs(deps: {
  source: string
  logger: Logger
  /** The topic0 values whose logs the source decodes. */
  topics: readonly Hex[]
  now?: () => number
  intervalMs?: number
  maxEmitters?: number
}): (log: ChainLog) => void {
  const { source, logger, topics } = deps
  const now = deps.now ?? Date.now
  const interval = deps.intervalMs ?? INTERVAL_MS
  const max = deps.maxEmitters ?? MAX_EMITTERS
  const known = new Set<Hex>(topics)
  const emitters = new Map<string, { last: number; dropped: number }>()
  let noticed = false
  return (log) => {
    const topic0 = log.topics[0]
    if (topic0 === undefined || !known.has(topic0)) return
    const at = now()
    const seen = emitters.get(log.address)
    if (seen === undefined) {
      if (emitters.size >= max) {
        if (!noticed) {
          noticed = true
          logger("warn", "more emitters with logs that do not decode; not reporting them", {
            source,
            limit: max,
          })
        }
        return
      }
      emitters.set(log.address, { last: at, dropped: 0 })
    } else if (at - seen.last < interval) {
      seen.dropped += 1
      return
    }
    const state = emitters.get(log.address)!
    logger("warn", "dropped a log that does not decode", {
      source,
      emitter: log.address,
      tx: log.transactionHash,
      logIndex: log.logIndex,
      dropped: state.dropped + 1,
    })
    state.last = at
    state.dropped = 0
  }
}
