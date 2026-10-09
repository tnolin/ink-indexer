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
import type { LogRouter } from "./rpc"

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

export function viemChain(client: StateReader & BlockReader, router: LogRouter): Chain {
  return {
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getBlock(n) {
      try {
        const b = await client.getBlock({ blockNumber: n })
        return b.hash ? { hash: b.hash.toLowerCase() as Hash, timestamp: b.timestamp } : null
      } catch (err) {
        if (err instanceof BlockNotFoundError) return null
        throw err
      }
    },
    getLogs: (from, to) => router.getLogs(from, to, LOG_TOPICS),
    readLaunchStates: (keys, block) => readLaunchStates(client, keys, block),
    readTotalSupplies: (tokens, block) => readTotalSupplies(client, tokens, block),
    readErc20Meta: (token) => readErc20Meta(client, token),
  }
}
