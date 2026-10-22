import type { Transport } from "viem"
import { type Logger, log } from "./log"

export type TransportCounts = {
  getLogs: number
  blockNumber: number
  getBlock: number
  other: number
  /** Requests that failed with a rate-limit error (see `isRateLimit`). */
  rateLimited: number
}

/** Window between two summary lines. */
export const STATS_EVERY_MS = 600_000

const KEY: Record<string, keyof TransportCounts | undefined> = {
  eth_getLogs: "getLogs",
  eth_blockNumber: "blockNumber",
  eth_getBlockByNumber: "getBlock",
}
const fresh = (): TransportCounts => ({
  getLogs: 0,
  blockNumber: 0,
  getBlock: 0,
  other: 0,
  rateLimited: 0,
})

const MESSAGE = /429|rate.?limit|request limit|too many requests/i

/**
 * True for a rate-limit failure of an RPC endpoint: HTTP status 429, JSON-RPC error code -32005
 * (limit exceeded) or -32003 (daily limit), or a message matching "429", "rate limit", "request
 * limit" or "too many requests", on the error or anywhere in its cause chain.
 */
export function isRateLimit(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    const { status, code, message, shortMessage, details } = e as Record<string, unknown>
    if (status === 429 || code === -32005 || code === -32003) return true
    for (const m of [message, shortMessage, details])
      if (typeof m === "string" && MESSAGE.test(m)) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/**
 * Counts RPC requests per transport and method, and the rate-limited ones, and logs one summary
 * line per window. Transports are named by hostname, as everywhere else in the logs.
 */
export class RpcStats {
  private counts = new Map<string, TransportCounts>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly names: string[],
    private readonly logger: Logger = log,
    private readonly everyMs = STATS_EVERY_MS,
  ) {
    this.reset()
  }

  private of(transport: string): TransportCounts {
    const known = this.counts.get(transport)
    if (known) return known
    const c = fresh()
    this.counts.set(transport, c)
    return c
  }

  count(transport: string, method: string) {
    this.of(transport)[KEY[method] ?? "other"]++
  }

  rateLimited(transport: string) {
    this.of(transport).rateLimited++
  }

  snapshot(): Record<string, TransportCounts> {
    return Object.fromEntries([...this.counts].map(([k, v]) => [k, { ...v }]))
  }

  private reset() {
    this.counts = new Map(this.names.map((n) => [n, fresh()]))
  }

  /** Logs the window's counts and starts the next window from zero. */
  emit() {
    this.logger("info", "rpc calls", {
      windowS: this.everyMs / 1000,
      transports: this.snapshot(),
    })
    this.reset()
  }

  start() {
    this.timer ??= setInterval(() => this.emit(), this.everyMs)
    this.timer.unref?.()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** The transport counted under `name`: every request through it, and a failure that is a rate limit. */
  wrap(name: string, transport: Transport): Transport {
    return (opts) => {
      const t = transport(opts)
      return {
        ...t,
        request: (async (args: { method: string }, options: unknown) => {
          this.count(name, args.method)
          try {
            return await (t.request as (a: unknown, o: unknown) => Promise<unknown>)(args, options)
          } catch (err) {
            if (isRateLimit(err)) this.rateLimited(name)
            throw err
          }
        }) as typeof t.request,
      }
    }
  }
}
