import { type ChainLog, INK_CHAIN_ID } from "@ink-indexer/sdk"
import {
  type Address,
  createPublicClient,
  fallback,
  type Hash,
  type Hex,
  HttpRequestError,
  http,
  type PublicClient,
  type RpcLog,
  SocketClosedError,
  TimeoutError,
  toHex,
  type WatchBlockNumberParameters,
  WebSocketRequestError,
  webSocket,
} from "viem"
import { ink } from "viem/chains"
import { type Logger, log } from "./log"
import { RpcStats } from "./rpc-stats"

/**
 * An eth_getLogs filter. `topics` is positional: each entry is one topic position, where null matches
 * anything and an array matches any of its topics. The InkyPump filter is `{ topics: [LOG_TOPICS] }`.
 */
export type LogFilter = { address?: Address | Address[]; topics: (Hex | Hex[] | null)[] }
export type GetLogsParams = { fromBlock: bigint; toBlock: bigint } & LogFilter
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

/**
 * True for a failure of the WebSocket itself: viem's WebSocketRequestError (also what its keepalive
 * ping raises on a dead socket), SocketClosedError, or the raw socket ErrorEvent. These say nothing
 * about the data. Request timeouts and JSON-RPC errors are not included.
 */
export function isSocketError(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    if (e instanceof WebSocketRequestError || e instanceof SocketClosedError) return true
    if ((e as { type?: unknown }).type === "error" && "defaultPrevented" in e) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/**
 * A failure to reach the endpoint at all: a socket error, or an HTTP request that failed before any
 * response (network down, DNS, reset, aborted). An HTTP response with a status (429, 5xx) is not
 * one: that endpoint answered, so it keeps the range-halving path.
 */
export function isConnectionError(err: unknown): boolean {
  if (isSocketError(err)) return true
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    if (e instanceof HttpRequestError && e.status === undefined) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/** True when viem's TimeoutError is the error or anywhere in its cause chain. */
export function isTimeoutError(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    if (e instanceof TimeoutError) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
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
/**
 * A request whose first block is fewer than this many blocks below the transport's own head lies
 * entirely at its tip. An endpoint's eth_blockNumber and eth_getLogs can be answered by nodes several
 * blocks apart, so a request at the tip can be refused as beyond the head although the head it reported
 * covers it. A span this short is far below any endpoint's range limit, so a size refusal cannot hide here.
 */
const TIP_BLOCKS = 32n

type TransportState = {
  t: LogTransport
  range: number
  successes: number
  failures: number
  /** Failures in a row, not reset by benching; drives the error-level log. */
  consecutive: number
  benchedUntil: number
  head: bigint
  headAt: number
}

/**
 * Sends each eth_getLogs to the healthy transport with the largest range.
 * Any error halves that transport's range; the message is never parsed (dRPC's are unreliable).
 * The one exception is position: a refusal (see isTipRefusal) on a span that lies within TIP_BLOCKS of
 * that transport's own head means the blocks are not there yet. Such a refusal does not count toward
 * the repeated-failure error either.
 * It changes no state and logs only at debug; the next transport is tried, and when none serves the
 * span, the router waits and asks again from the same block.
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
      consecutive: 0,
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
    filter: LogFilter,
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
          const logs = await s.t.getLogs({ ...filter, fromBlock: from, toBlock: end })
          s.failures = 0
          s.consecutive = 0
          if (++s.successes >= GROW_AFTER) {
            s.successes = 0
            s.range = Math.min(s.t.seed, s.range * 2)
          }
          return { logs, toBlock: end }
        } catch (err) {
          if (isTipRefusal(err) && s.head - from < TIP_BLOCKS) {
            this.logger("debug", "getLogs at the tip not served yet", {
              transport: s.t.name,
              from,
              head: s.head,
              error: String(err),
            })
            continue
          }
          const consecutive = ++s.consecutive
          if (isConnectionError(err)) {
            // The connection to the endpoint is down: skip it for a while. The range says nothing about this.
            s.successes = 0
            s.failures = 0
            s.benchedUntil = now + BENCH_MS
            this.logger("warn", "RPC connection error; transport benched", {
              transport: s.t.name,
              benchedMs: BENCH_MS,
              error: String(err),
            })
          } else {
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
          }
          if (consecutive >= BENCH_AFTER)
            this.logger("error", "getLogs failed repeatedly", {
              transport: s.t.name,
              failures: consecutive,
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

  /**
   * Each healthy transport's own eth_blockNumber, from the same cache `getLogs` uses (a cached head
   * below `from` is read again). A transport that is benched or fails to answer is left out.
   */
  async heads(from: bigint): Promise<{ name: string; head: bigint }[]> {
    const now = this.clock.now()
    const read = await Promise.all(
      this.states
        .filter((s) => s.benchedUntil <= now)
        .map((s) =>
          this.headOf(s, from, now).then(
            (head) => ({ name: s.t.name, head }),
            () => null,
          ),
        ),
    )
    return read.filter((h) => h !== null)
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

export function toChainLog(l: RpcLog): ChainLog {
  if (
    l.blockNumber === null ||
    l.blockHash === null ||
    l.transactionHash === null ||
    l.logIndex === null
  ) {
    throw new Error("eth_getLogs returned a pending log")
  }
  return {
    address: l.address.toLowerCase() as Address,
    topics: [...l.topics] as Hex[],
    data: l.data,
    blockNumber: BigInt(l.blockNumber),
    blockHash: l.blockHash.toLowerCase() as Hash,
    transactionHash: l.transactionHash.toLowerCase() as Hash,
    logIndex: Number(l.logIndex),
  }
}

/** Hard limit for every RPC request. */
export const RPC_TIMEOUT_MS = 15_000
/** Ink's websocket-only Gelato host serves its HTTP RPC on another host. */
const HTTP_HOSTS: Record<string, string> = { "ws-gel.inkonchain.com": "rpc-gel.inkonchain.com" }

/**
 * The HTTP RPC URL for a configured endpoint: `wss` becomes `https` and `ws` becomes `http`, with
 * host, port, path and query kept. An `https://` or `http://` entry is used as given.
 */
export function httpUrlFor(url: string): string {
  const u = new URL(url)
  const protocol = { "wss:": "https:", "ws:": "http:", "https:": "https:", "http:": "http:" }[
    u.protocol
  ]
  if (!protocol) throw new Error(`unsupported RPC URL scheme: ${url}`)
  u.protocol = protocol
  u.hostname = HTTP_HOSTS[u.hostname] ?? u.hostname
  return u.toString()
}

/** JSON-RPC codes that mean "slow down" rather than "your request is wrong": -32005 (limit exceeded), 429 and QuickNode's -32007. */
const RATE_LIMIT_CODES = new Set([-32005, 429, -32007])

/**
 * A failure of the endpoint rather than of the request's data: a connection failure, a timeout, an
 * HTTP error status, or a rate-limit RPC error. Retrying later can succeed. Reverts and other RPC
 * error responses are data errors and are not included.
 */
export function isTransportError(err: unknown): boolean {
  if (isSocketError(err) || isTimeoutError(err)) return true
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    if (e instanceof HttpRequestError) return true
    if (RATE_LIMIT_CODES.has((e as { code?: unknown }).code as number)) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/**
 * An error an endpoint can give for a span at its tip that its head already covers: an RPC error
 * response that is not a transport failure, or an HTTP 5xx response (dRPC answers 500 with no useful
 * message). Connection failures, timeouts and rate limits (including HTTP 429) are not included.
 */
export function isTipRefusal(err: unknown): boolean {
  if (!isTransportError(err)) return true
  if (isSocketError(err) || isTimeoutError(err)) return false
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    if (e instanceof HttpRequestError) return e.status !== undefined && e.status >= 500
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/**
 * Reads and getLogs go over HTTP: every request has a hard timeout and viem's fallback moves to the
 * next endpoint, demoting one that stops answering. The WebSocket clients are used only for the
 * newHeads subscription, whose failures are logged by watchHeads and are not fatal.
 * viem's WebSocket transport awaits a (re)connect with no timeout, so a half-open socket can hang a
 * request forever; HTTP has no such state.
 */
export async function connectRpc(
  urls: string[],
  logger: Logger = log,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number; rank?: boolean } = {},
) {
  const { timeoutMs = RPC_TIMEOUT_MS, rank = true } = opts
  const baseFetch = opts.fetchFn ?? fetch
  // viem's own timer stops once the response headers arrive; this bounds the body read too.
  const fetchFn: typeof fetch = async (input, init) => {
    const res = await baseFetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    })
    if (res.status !== 429 && res.status < 500) return res
    // viem returns a JSON-RPC error body from a non-2xx response as data and drops the status. Hand
    // it a body that is not JSON-RPC so it raises an HttpRequestError that keeps the 429 or 5xx status.
    return new Response(`HTTP ${res.status}: ${await res.text()}`, {
      status: res.status,
      statusText: res.statusText,
      headers: { "content-type": "text/plain" },
    })
  }
  // Counts every request of every client built on these transports, under the transport's hostname.
  const stats = new RpcStats(
    urls.map((u) => new URL(u).hostname),
    logger,
  )
  const httpTransports = urls.map((u) =>
    stats.wrap(
      new URL(u).hostname,
      http(httpUrlFor(u), { timeout: timeoutMs, retryCount: 0, fetchFn }),
    ),
  )
  const perUrl = httpTransports.map((t) => createPublicClient({ chain: ink, transport: t }))
  for (const [i, c] of perUrl.entries()) {
    const id = await c.getChainId().catch((err) => {
      logger("warn", "RPC endpoint unreachable at startup", { url: urls[i], error: String(err) })
      return null
    })
    if (id !== null && id !== INK_CHAIN_ID)
      throw new Error(`${urls[i]} serves chain ${id}, expected ${INK_CHAIN_ID}`)
  }
  const client = createPublicClient({
    chain: ink,
    transport: fallback(httpTransports, {
      retryCount: 0,
      rank: rank && {
        interval: 10_000,
        sampleCount: 5,
        timeout: timeoutMs,
        ping: ({ transport }) => transport.request({ method: "eth_blockNumber" }),
      },
    }),
  })
  // New-head notifications need a WebSocket. With only http(s) entries, poll the HTTP client instead.
  const wsUrls = urls.filter((u) => /^wss?:/i.test(u))
  const pollHeads = wsUrls.length === 0
  if (pollHeads)
    logger("warn", "no ws:// or wss:// URL configured; polling for new heads every 1 s")
  const heads = pollHeads
    ? client
    : createPublicClient({
        chain: ink,
        transport: fallback(
          wsUrls.map((u) => webSocket(u, { reconnect: true, keepAlive: true, retryCount: 3 })),
        ),
      })
  const router = new LogRouter(
    perUrl.map((c, i) => ({
      name: new URL(urls[i]!).hostname,
      seed: seedFor(urls[i]!),
      getBlockNumber: () => c.getBlockNumber({ cacheTime: 0 }),
      getLogs: async (p: GetLogsParams) => {
        const raw = await c.request({
          method: "eth_getLogs",
          params: [
            {
              fromBlock: toHex(p.fromBlock),
              toBlock: toHex(p.toBlock),
              ...(p.address !== undefined && { address: p.address }),
              topics: p.topics,
            },
          ],
        })
        return raw.map(toChainLog)
      },
    })),
    undefined,
    logger,
  )
  return { client, heads, pollHeads, router, stats }
}

/** First and longest wait before subscribing to new heads again after an error or a silent stall. */
const RESUBSCRIBE_MIN_MS = 5_000
const RESUBSCRIBE_MAX_MS = 5 * 60_000

/**
 * Calls onHead for every new head, and on its own every `stallMs / 3` while no head has arrived for
 * `stallMs`. viem's WebSocket transport reconnects the socket and restores its subscriptions, but forgets
 * them when its reconnect attempts run out. So the subscription is created again only after `stallMs`
 * without a head, backing off to RESUBSCRIBE_MAX_MS while the outage lasts.
 * Each outage logs one warning when it starts (a subscription error or a stall) and one info line when a
 * new head arrives again.
 */
export function watchHeads(
  client: Pick<PublicClient, "watchBlockNumber">,
  onHead: () => void,
  logger: Logger = log,
  stallMs = 30_000,
  poll = false,
): () => void {
  let last = Date.now()
  let down = false
  let stopped = false
  let wait = RESUBSCRIBE_MIN_MS
  let retry: ReturnType<typeof setTimeout> | undefined
  let unwatch = () => {}
  const subscribe = (first: boolean) => {
    unwatch()
    // `poll: false` (WebSocket subscription) is only typed on a client with a known WebSocket transport; the fallback transport is not one.
    unwatch = client.watchBlockNumber({
      poll,
      // Only the first subscription reports the current head; a resubscription's first head must be a new one.
      emitOnBegin: first,
      onBlockNumber: () => {
        if (down) logger("info", "head subscription recovered", { downMs: Date.now() - last })
        down = false
        last = Date.now()
        wait = RESUBSCRIBE_MIN_MS
        onHead()
      },
      onError: (error: unknown) => {
        // An error starts an outage just as a stall does, so a socket that keeps failing logs once.
        if (!down)
          logger("warn", "head subscription error", {
            error: error instanceof Error ? String(error) : JSON.stringify(error),
          })
        down = true
        // No resubscribe here: viem reconnects and restores its subscriptions itself. Subscribing again on
        // every error leaves the old subscription behind (its unsubscribe holds a stale id), so each drop
        // added one more and every later drop reported an error for all of them.
      },
    } as unknown as WatchBlockNumberParameters)
  }
  const resubscribeLater = () => {
    if (stopped || retry) return
    retry = setTimeout(() => {
      retry = undefined
      if (!stopped) subscribe(false)
    }, wait)
    wait = Math.min(wait * 2, RESUBSCRIBE_MAX_MS)
  }
  subscribe(true)
  const timer = setInterval(() => {
    if (Date.now() - last < stallMs) return
    if (!down) {
      down = true
      logger("warn", "no new head for 30 s; ticking without the subscription until it recovers", {
        sinceMs: Date.now() - last,
      })
    }
    resubscribeLater()
    onHead()
  }, stallMs / 3)
  return () => {
    stopped = true
    unwatch()
    clearInterval(timer)
    clearTimeout(retry)
  }
}
