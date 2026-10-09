import type { ChainLog } from "@ink-indexer/sdk"
import type { Hex } from "viem"
import { type Logger, log } from "./log"

export type GetLogsParams = { fromBlock: bigint; toBlock: bigint; topics: Hex[] }
export type LogTransport = {
  name: string
  seed: number
  /** The transport's own eth_blockNumber. Its getLogs can only see up to here. */
  getBlockNumber(): Promise<bigint>
  getLogs(p: GetLogsParams): Promise<ChainLog[]>
}
export type Clock = { now(): number; sleep(ms: number): Promise<void> }

/** Measured eth_getLogs caps (blocks per call). The seed is also each transport's ceiling. */
export const RANGE_SEEDS: Record<string, number> = {
  "ink.drpc.org": 100,
  "rpc-qnd.inkonchain.com": 10_000,
  "ws-gel.inkonchain.com": 1_000,
  "rpc-gel.inkonchain.com": 1_000,
}
export const DEFAULT_WS_URLS = [
  "wss://ink.drpc.org",
  "wss://rpc-qnd.inkonchain.com",
  "wss://ws-gel.inkonchain.com",
]

export function seedFor(url: string): number {
  return RANGE_SEEDS[new URL(url).hostname] ?? 1_000
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}
const GROW_AFTER = 20
const BENCH_AFTER = 5
const BENCH_MS = 60_000
const MAX_WAIT_MS = 30_000
const HEAD_TTL_MS = 1_000

type TransportState = {
  t: LogTransport
  range: number
  successes: number
  failures: number
  benchedUntil: number
  head: bigint
  headAt: number
}

/**
 * Sends each eth_getLogs to the healthy transport with the largest range.
 * Any error halves that transport's range; the message is never parsed (dRPC's are unreliable).
 * The span's end is also clamped to that transport's own eth_blockNumber: a transport behind the
 * chain head can answer a query above its head with a successful but incomplete result.
 */
export class LogRouter {
  private readonly states: TransportState[]

  constructor(
    transports: LogTransport[],
    private readonly clock: Clock = realClock,
    private readonly logger: Logger = log,
  ) {
    this.states = transports.map((t) => ({
      t,
      range: t.seed,
      successes: 0,
      failures: 0,
      benchedUntil: 0,
      head: 0n,
      headAt: Number.NEGATIVE_INFINITY,
    }))
  }

  ranges() {
    const now = this.clock.now()
    return this.states.map((s) => ({
      name: s.t.name,
      range: s.range,
      healthy: s.benchedUntil <= now,
    }))
  }

  /** Fetches logs from `from` up to at most `to`. Returns the logs and the last block covered, which is clamped to the chosen transport's head. */
  async getLogs(
    from: bigint,
    to: bigint,
    topics: Hex[],
  ): Promise<{ logs: ChainLog[]; toBlock: bigint }> {
    let wait = 1_000
    for (;;) {
      const now = this.clock.now()
      let failed = false
      for (const s of this.healthyByRange(now)) {
        try {
          const head = await this.headOf(s, from, now)
          if (head < from) continue // this transport has not reached `from` yet
          const reach = from + BigInt(s.range) - 1n
          const end = [reach, to, head].reduce((a, b) => (a < b ? a : b))
          const logs = await s.t.getLogs({ fromBlock: from, toBlock: end, topics })
          s.failures = 0
          if (++s.successes >= GROW_AFTER) {
            s.successes = 0
            s.range = Math.min(s.t.seed, s.range * 2)
          }
          return { logs, toBlock: end }
        } catch (err) {
          const wasMin = s.range === 1
          s.successes = 0
          s.range = Math.max(1, Math.floor(s.range / 2))
          if (wasMin || ++s.failures >= BENCH_AFTER) {
            s.benchedUntil = now + BENCH_MS
            s.failures = 0
          }
          this.logger("warn", "getLogs failed", {
            transport: s.t.name,
            from,
            nextRange: s.range,
            error: String(err),
          })
          failed = true
          break
        }
      }
      if (failed) continue
      // Every transport is benched or behind `from`: back off, then try the same span again.
      await this.clock.sleep(wait)
      wait = Math.min(wait * 2, MAX_WAIT_MS)
    }
  }

  /** Healthy transports, largest range first; ties keep priority order. */
  private healthyByRange(now: number): TransportState[] {
    return this.states.filter((s) => s.benchedUntil <= now).sort((a, b) => b.range - a.range)
  }

  /** The transport's head, cached for a second. A cached head below `from` is refreshed. */
  private async headOf(s: TransportState, from: bigint, now: number): Promise<bigint> {
    if (s.headAt + HEAD_TTL_MS > now && s.head >= from) return s.head
    s.head = await s.t.getBlockNumber()
    s.headAt = now
    return s.head
  }
}
