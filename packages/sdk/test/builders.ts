import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hash,
  type Hex,
  pad,
  parseAbiParameters,
} from "viem"
import { hookEventsAbi, XSTOCKS_HOOK_CREATED_TOPIC } from "../src/inkypump/abi"
import type { ChainLog } from "../src/types"

export type Meta = Partial<Omit<ChainLog, "topics" | "data">>

const withMeta = (m: Meta, topics: readonly unknown[], data: Hex): ChainLog => ({
  address: m.address ?? "0x893183da2411c7df81f103bfef09e4e46c326ac4",
  blockNumber: m.blockNumber ?? 1n,
  blockHash: m.blockHash ?? (pad("0x1") as Hash),
  transactionHash: m.transactionHash ?? (pad("0xaa") as Hash),
  logIndex: m.logIndex ?? 0,
  topics: topics as Hex[],
  data,
})

export function launchCreatedLog(
  a: { launchId: bigint; creator: Address; token: Address; targetRaise: bigint },
  m: Meta = {},
): ChainLog {
  const topics = encodeEventTopics({
    abi: hookEventsAbi,
    eventName: "LaunchCreated",
    args: { launchId: a.launchId, creator: a.creator },
  })
  return withMeta(
    m,
    topics,
    encodeAbiParameters(parseAbiParameters("address, uint96"), [a.token, a.targetRaise]),
  )
}

export function launchMetadataLog(
  a: {
    launchId: bigint
    name: string
    ticker: string
    description?: string
    imageUrl?: string
    telegram?: string
    twitter?: string
    website?: string
  },
  m: Meta = {},
): ChainLog {
  const topics = encodeEventTopics({
    abi: hookEventsAbi,
    eventName: "LaunchMetadata",
    args: { launchId: a.launchId },
  })
  const data = encodeAbiParameters(
    parseAbiParameters("string, string, string, string, string, string, string"),
    [
      a.name,
      a.ticker,
      a.description ?? "",
      a.imageUrl ?? "",
      a.telegram ?? "",
      a.twitter ?? "",
      a.website ?? "",
    ],
  )
  return withMeta(m, topics, data)
}

export function tradeLog(
  a: {
    launchId: bigint
    trader: Address
    side: "buy" | "sell"
    price: bigint
    sold: bigint
    timestamp: number
    tokenAmount: bigint
    quoteAmount: bigint
    refund?: bigint
  },
  m: Meta = {},
): ChainLog {
  const topics = encodeEventTopics({
    abi: hookEventsAbi,
    eventName: "Trade",
    args: { launchId: a.launchId, trader: a.trader },
  })
  const data = encodeAbiParameters(
    parseAbiParameters("uint8, (uint256, uint128, uint40), (address, uint256, uint256), uint256"),
    [
      a.side === "buy" ? 0 : 1,
      [a.price, a.sold, a.timestamp],
      [a.trader, a.tokenAmount, a.quoteAmount],
      a.refund ?? 0n,
    ],
  )
  return withMeta(m, topics, data)
}

export function launchFinalizedLog(
  a: { launchId: bigint; poolId: Hash; liquidityQuote: bigint; liquidityTokens: bigint },
  m: Meta = {},
): ChainLog {
  const topics = encodeEventTopics({
    abi: hookEventsAbi,
    eventName: "LaunchFinalized",
    args: { launchId: a.launchId },
  })
  const data = encodeAbiParameters(parseAbiParameters("bytes32, uint256, uint256"), [
    a.poolId,
    a.liquidityQuote,
    a.liquidityTokens,
  ])
  return withMeta(m, topics, data)
}

export function xstocksHookCreatedLog(
  a: { assetId: Hash; wrapper: Address; hook: Address },
  m: Meta = {},
): ChainLog {
  const topics = [XSTOCKS_HOOK_CREATED_TOPIC, a.assetId, pad(a.wrapper), pad(a.hook)]
  return withMeta(
    { address: "0x92f303ae539052ebb7d551bb2ec1a6f1affbaf85", ...m },
    topics,
    `0x${"00".repeat(128)}`,
  )
}
