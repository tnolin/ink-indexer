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
import { isSocketError, isTimeoutError, type LogRouter } from "./rpc"

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

/**
 * Reads go through viem's fallback over every endpoint, so a socket error or request timeout only
 * surfaces here when all of them are down or stalled (for example after the host slept). That is an
 * outage, not a data error: wait and ask again, unless shutdown has begun. Every other error is
 * rethrown at once.
 */
async function retryOnSocketError<T>(
  fn: () => Promise<T>,
  logger: Logger,
  sleep: (ms: number) => Promise<void>,
  isStopping: () => boolean,
): Promise<T> {
  for (let wait = 1_000; ; wait = Math.min(wait * 2, 30_000)) {
    try {
      return await fn()
    } catch (err) {
      if (!(isSocketError(err) || isTimeoutError(err)) || isStopping()) throw err
      logger("warn", "RPC read failed on the socket; retrying", {
        retryInMs: wait,
        error: String(err),
      })
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
  const retry = <T>(fn: () => Promise<T>) => retryOnSocketError(fn, logger, sleep, isStopping)
  return {
    getBlockNumber: () => retry(() => client.getBlockNumber({ cacheTime: 0 })),
    async getBlock(n) {
      try {
        const b = await retry(() => client.getBlock({ blockNumber: n }))
        return b.hash ? { hash: b.hash.toLowerCase() as Hash, timestamp: b.timestamp } : null
      } catch (err) {
        if (err instanceof BlockNotFoundError) return null
        throw err
      }
    },
    getLogs: (from, to) => router.getLogs(from, to, LOG_TOPICS),
    readLaunchStates: (keys, block) => retry(() => readLaunchStates(client, keys, block)),
    readTotalSupplies: (tokens, block) => retry(() => readTotalSupplies(client, tokens, block)),
    readErc20Meta: (token) => retry(() => readErc20Meta(client, token)),
  }
}
