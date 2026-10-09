import { type ChainLog, INK_CHAIN_ID } from "@ink-indexer/sdk"
import {
  type Address,
  createPublicClient,
  fallback,
  type Hash,
  type Hex,
  type PublicClient,
  type RpcLog,
  SocketClosedError,
  toHex,
  type WatchBlockNumberParameters,
  WebSocketRequestError,
  webSocket,
} from "viem"
import { ink } from "viem/chains"
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
          if (isSocketError(err)) {
            // The endpoint's socket is down (viem reconnects it on its own): skip it for a while.
            s.successes = 0
            s.failures = 0
            s.benchedUntil = now + BENCH_MS
            this.logger("warn", "RPC socket error; transport benched", {
              transport: s.t.name,
              benchedMs: BENCH_MS,
              error: String(err),
            })
            failed = true
            break
          }
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

/** One WebSocket client per URL. Heads and reads use them in priority order; getLogs goes through LogRouter. */
export async function connectRpc(urls: string[], logger: Logger = log) {
  const transports = urls.map((u) =>
    webSocket(u, { reconnect: true, keepAlive: true, retryCount: 3 }),
  )
  const perUrl = transports.map((t) => createPublicClient({ chain: ink, transport: t }))
  for (const [i, c] of perUrl.entries()) {
    const id = await c.getChainId().catch((err) => {
      logger("warn", "RPC endpoint unreachable at startup", { url: urls[i], error: String(err) })
      return null
    })
    if (id !== null && id !== INK_CHAIN_ID)
      throw new Error(`${urls[i]} serves chain ${id}, expected ${INK_CHAIN_ID}`)
  }
  const client = createPublicClient({ chain: ink, transport: fallback(transports) })
  const router = new LogRouter(
    perUrl.map((c, i) => ({
      name: new URL(urls[i]!).hostname,
      seed: seedFor(urls[i]!),
      getBlockNumber: () => c.getBlockNumber({ cacheTime: 0 }),
      getLogs: async (p: GetLogsParams) => {
        const raw = await c.request({
          method: "eth_getLogs",
          params: [
            { fromBlock: toHex(p.fromBlock), toBlock: toHex(p.toBlock), topics: [[...p.topics]] },
          ],
        })
        return raw.map(toChainLog)
      },
    })),
    undefined,
    logger,
  )
  return { client, router }
}

/** Calls onHead for every new head, and on its own when no head has arrived for `stallMs`. */
export function watchHeads(
  client: Pick<PublicClient, "watchBlockNumber">,
  onHead: () => void,
  logger: Logger = log,
  stallMs = 30_000,
): () => void {
  let last = Date.now()
  // `poll: false` (WebSocket subscription) is only typed on a client with a known WebSocket transport; the fallback transport is not one.
  const unwatch = client.watchBlockNumber({
    poll: false,
    emitOnBegin: true,
    onBlockNumber: () => {
      last = Date.now()
      onHead()
    },
    onError: (error: Error) => logger("warn", "head subscription error", { error: String(error) }),
  } as unknown as WatchBlockNumberParameters)
  const timer = setInterval(() => {
    if (Date.now() - last < stallMs) return
    logger("warn", "no new head for 30 s; ticking without the subscription", {
      sinceMs: Date.now() - last,
    })
    onHead()
  }, stallMs / 3)
  return () => {
    unwatch()
    clearInterval(timer)
  }
}
