import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hash,
  type Hex,
  pad,
  parseAbiParameters,
} from "viem"
import { inkfunEventsAbi } from "../src/inkfun/abi"
import { INKFUN_FACTORY, INKFUN_MIGRATION } from "../src/inkfun/constants"
import { hookEventsAbi, XSTOCKS_HOOK_CREATED_TOPIC } from "../src/inkypump/abi"
import type { ChainLog } from "../src/types"
import { SWAP_TOPIC, TRANSFER_TOPIC } from "../src/v4/constants"

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

const SWAP_ABI = parseAbiParameters("int128, int128, uint160, uint128, int24, uint24")

/** A Uniswap v4 PoolManager `Swap`. */
export function swapLog(
  a: {
    poolId: Hash
    sender: Address
    amount0: bigint
    amount1: bigint
    sqrtPriceX96: bigint
    liquidity: bigint
    tick?: number
    fee?: number
  },
  m: Meta = {},
): ChainLog {
  const data = encodeAbiParameters(SWAP_ABI, [
    a.amount0,
    a.amount1,
    a.sqrtPriceX96,
    a.liquidity,
    a.tick ?? 0,
    a.fee ?? 0,
  ])
  return withMeta(
    { address: "0x360e68faccca8ca495c1b759fd9eee466db9fb32", ...m },
    [SWAP_TOPIC, a.poolId, pad(a.sender)],
    data,
  )
}

/** An ERC-20 `Transfer` emitted by `m.address`. */
export function transferLog(
  a: { from: Address; to: Address; value: bigint },
  m: Meta = {},
): ChainLog {
  return withMeta(
    m,
    [TRANSFER_TOPIC, pad(a.from), pad(a.to)],
    encodeAbiParameters(parseAbiParameters("uint256"), [a.value]),
  )
}

/** ink.fun `LaunchCreated`, emitted by the factory unless `m.address` says otherwise. */
export function inkfunLaunchCreatedLog(
  a: { token: Address; curve: Address; creator: Address; name: string; symbol: string },
  m: Meta = {},
): ChainLog {
  const { topics, data } = encodeInkfun("LaunchCreated", a)
  return withMeta({ address: INKFUN_FACTORY, ...m }, topics, data)
}

/** ink.fun `Bought`; `m.address` is the curve. */
export function inkfunBoughtLog(
  a: {
    payer: Address
    beneficiary: Address
    quoteIn: bigint
    fee: bigint
    tokensOut: bigint
    refund?: bigint
    tokensSold: bigint
  },
  m: Meta = {},
): ChainLog {
  const { topics, data } = encodeInkfun("Bought", { refund: 0n, ...a })
  return withMeta(m, topics, data)
}

/** ink.fun `Sold`; `m.address` is the curve. */
export function inkfunSoldLog(
  a: { seller: Address; tokensIn: bigint; quoteOut: bigint; fee: bigint; tokensSold: bigint },
  m: Meta = {},
): ChainLog {
  const { topics, data } = encodeInkfun("Sold", a)
  return withMeta(m, topics, data)
}

/** ink.fun `Migrated`, emitted by the migration module unless `m.address` says otherwise. */
export function inkfunMigratedLog(
  a: {
    poolId: Hash
    launchToken: Address
    tokenAmount: bigint
    quoteAmount: bigint
    tokenId?: bigint
    sqrtPriceX96?: bigint
  },
  m: Meta = {},
): ChainLog {
  const { topics, data } = encodeInkfun("Migrated", {
    tokenId: 1n,
    sqrtPriceX96: 1n << 96n,
    ...a,
  })
  return withMeta({ address: INKFUN_MIGRATION, ...m }, topics, data)
}

const INKFUN_DATA = {
  LaunchCreated: parseAbiParameters("string name, string symbol"),
  Bought: parseAbiParameters(
    "uint256 quoteIn, uint256 fee, uint256 tokensOut, uint256 refund, uint256 tokensSold",
  ),
  Sold: parseAbiParameters("uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tokensSold"),
  Migrated: parseAbiParameters(
    "uint256 tokenAmount, uint256 quoteAmount, uint256 tokenId, uint160 sqrtPriceX96",
  ),
} as const

function encodeInkfun(eventName: keyof typeof INKFUN_DATA, a: Record<string, unknown>) {
  const topics = encodeEventTopics({
    abi: inkfunEventsAbi,
    eventName,
    args: a as never,
  })
  const params = INKFUN_DATA[eventName]
  const data = encodeAbiParameters(params, params.map((p) => a[p.name as string]) as never)
  return { topics, data }
}
