import type { ChainLog } from "@ink-indexer/sdk"
import type { Address, Hex } from "viem"
import type { Logger } from "../log"
import type { Reporter } from "../sentry"

const INTERVAL_MS = 10 * 60_000
// shortcut: trusted emitters are few, so this only guards the map; emitters are remembered for the life of the process, up to this many, and past it one notice replaces further warnings. Evict the quietest emitter if a long-lived process needs more.
const MAX_EMITTERS = 1_000

/**
 * Warns about logs from a trusted contract that carry one of the source's topics and still did not
 * decode, so a contract that changes an event's layout shows in the journal instead of vanishing.
 * Logs from other contracts are dropped silently: topic-only filters match look-alike events from
 * unrelated contracts, which are not the source's to report. The first undecodable log of each
 * trusted emitter is also reported. Each emitter warns at most once per interval, with the number of logs dropped since
 * its last warning. A topic the source does not handle is not a decode failure and is not reported.
 */
export function droppedLogs(deps: {
  source: string
  logger: Logger
  /** The topic0 values whose logs the source decodes. */
  topics: readonly Hex[]
  /** The emitters whose logs the source trusts; every emitter when absent. */
  trusted?: (emitter: Address) => boolean
  report?: Pick<Reporter, "warn">
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
    if (deps.trusted && !deps.trusted(log.address)) return
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
      deps.report?.warn("a trusted contract emitted a log that does not decode", {
        source,
        emitter: log.address,
        tx: log.transactionHash,
        logIndex: log.logIndex,
      })
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
