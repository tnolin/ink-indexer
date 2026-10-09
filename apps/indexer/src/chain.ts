import type { ChainLog, LaunchKey, LaunchState } from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"

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
