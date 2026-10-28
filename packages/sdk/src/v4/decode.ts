import { type Address, decodeEventLog, type Hash, type Hex, parseAbi } from "viem"
import { SWAP_TOPIC, TRANSFER_TOPIC } from "./constants"

const swapAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
])
const transferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
])

/**
 * A PoolManager `Swap`. `amount0` and `amount1` are the swapper's balance change: the currency it
 * pays is negative, the currency it receives is positive. `sender` is the contract that called the
 * PoolManager, usually a router, not the transaction's sender.
 */
export type V4Swap = {
  poolId: Hash
  sender: Address
  amount0: bigint
  amount1: bigint
  sqrtPriceX96: bigint
  liquidity: bigint
  tick: number
  fee: number
}

const lower = (a: string) => a.toLowerCase() as Address

/** Decodes a PoolManager `Swap` log. Null for any other topic0. Does not check the emitter. */
export function decodeSwap(log: { topics: readonly Hex[]; data: Hex }): V4Swap | null {
  if (log.topics[0] !== SWAP_TOPIC) return null
  const { args } = decodeEventLog({
    abi: swapAbi,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  })
  return {
    poolId: args.id.toLowerCase() as Hash,
    sender: lower(args.sender),
    amount0: args.amount0,
    amount1: args.amount1,
    sqrtPriceX96: args.sqrtPriceX96,
    liquidity: args.liquidity,
    tick: args.tick,
    fee: args.fee,
  }
}

/**
 * Decodes an ERC-20 `Transfer` log. Null for any other topic0, and for an ERC-721 `Transfer`,
 * which shares the topic0 but indexes the token id as a fourth topic.
 */
export function decodeTransfer(log: {
  topics: readonly Hex[]
  data: Hex
}): { from: Address; to: Address; value: bigint } | null {
  if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) return null
  const { args } = decodeEventLog({
    abi: transferAbi,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  })
  return { from: lower(args.from), to: lower(args.to), value: args.value }
}
