import {
  type ChainLog,
  type LaunchKey,
  type LaunchState,
  LOG_TOPICS,
  readErc20Meta,
  readLaunchStates,
  readTotalSupplies,
  type StateReader,
} from "@ink-indexer/sdk"
import { type Address, BlockNotFoundError, type Hash } from "viem"
import { type Logger, log } from "./log"
import { isTransportError, type LogRouter } from "./rpc"

/** Everything the indexer needs from Ink. viemChain is the real one; tests use FakeChain. */
export type Chain = {
  getBlockNumber(): Promise<bigint>
  /** null when the block does not exist (for example above head after a reorg). */
  getBlock(n: bigint): Promise<{ hash: Hash; timestamp: bigint } | null>
  /** Logs for every InkyPump topic from `from` up to at most `to`, and the last block covered. The log transport may be behind head, so this can stop short of `to`. */
  getLogs(from: bigint, to: bigint): Promise<{ logs: ChainLog[]; toBlock: bigint }>
  readLaunchStates(keys: LaunchKey[], block: bigint): Promise<LaunchState[]>
  readTotalSupplies(tokens: Address[], block: bigint): Promise<bigint[]>
  readErc20Meta(token: Address): Promise<{ decimals: number; symbol: string }>
}

/** The slice of a PublicClient that viemChain reads blocks with. Structural, so chain-specific block shapes (Ink's deposit transactions) still fit. */
export type BlockReader = {
  getBlockNumber(args: { cacheTime: number }): Promise<bigint>
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hash | null; timestamp: bigint }>
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Consecutive failures of one call after which each further failure is logged as an error. */
export const ERROR_AFTER_FAILURES = 5

/** The url of the endpoint named in the error or its causes. */
function errorUrl(err: unknown): string | undefined {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    const url = (e as { url?: unknown }).url
    if (typeof url === "string") return url
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Reads go through viem's HTTP fallback over every endpoint, each request with a hard timeout, so a
 * transport error (socket, HTTP or timeout) only surfaces here when every endpoint failed. That is
 * an outage, not a data error: wait and ask again, unless shutdown has begun. Every other error
 * (revert, RPC error response, decode) is rethrown at once. From the 5th consecutive failure of a
 * call each retry is logged as an error; it keeps trying, and the stall watchdog decides when to exit.
 */
async function retryOnTransportError<T>(
  call: string,
  fn: () => Promise<T>,
  logger: Logger,
  sleep: (ms: number) => Promise<void>,
  isStopping: () => boolean,
): Promise<T> {
  for (let failures = 1, wait = 1_000; ; failures++, wait = Math.min(wait * 2, 30_000)) {
    try {
      return await fn()
    } catch (err) {
      if (!isTransportError(err) || isStopping()) throw err
      const fields = { call, failures, url: errorUrl(err), retryInMs: wait, error: String(err) }
      if (failures >= ERROR_AFTER_FAILURES)
        logger("error", "RPC read failing repeatedly; still retrying", fields)
      else logger("warn", "RPC read failed on the socket; retrying", fields)
      await sleep(wait)
    }
  }
}

export function viemChain(
  client: StateReader & BlockReader,
  router: LogRouter,
  opts: {
    logger?: Logger
    sleep?: (ms: number) => Promise<void>
    isStopping?: () => boolean
  } = {},
): Chain {
  const { logger = log, sleep = sleepMs, isStopping = () => false } = opts
  const retry = <T>(call: string, fn: () => Promise<T>) =>
    retryOnTransportError(call, fn, logger, sleep, isStopping)
  return {
    getBlockNumber: () => retry("getBlockNumber", () => client.getBlockNumber({ cacheTime: 0 })),
    async getBlock(n) {
      try {
        const b = await retry("getBlock", () => client.getBlock({ blockNumber: n }))
        return b.hash ? { hash: b.hash.toLowerCase() as Hash, timestamp: b.timestamp } : null
      } catch (err) {
        if (err instanceof BlockNotFoundError) return null
        throw err
      }
    },
    getLogs: (from, to) => router.getLogs(from, to, LOG_TOPICS),
    readLaunchStates: (keys, block) =>
      retry("readLaunchStates", () => readLaunchStates(client, keys, block)),
    readTotalSupplies: (tokens, block) =>
      retry("readTotalSupplies", () => readTotalSupplies(client, tokens, block)),
    readErc20Meta: (token) => retry("readErc20Meta", () => readErc20Meta(client, token)),
  }
}
