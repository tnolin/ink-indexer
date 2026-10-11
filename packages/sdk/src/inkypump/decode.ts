import {
  AbiEventSignatureNotFoundError,
  type Address,
  decodeEventLog,
  type Hash,
  type Hex,
  toHex,
} from "viem"
import { hookEventsAbi, XSTOCKS_HOOK_CREATED_TOPIC } from "./abi"

export type LaunchCreated = {
  kind: "launchCreated"
  launchId: Hash
  creator: Address
  token: Address
  targetRaise: bigint
}
export type LaunchMetadata = {
  kind: "launchMetadata"
  launchId: Hash
  name: string
  ticker: string
  description: string
  imageUrl: string
  telegram: string
  twitter: string
  website: string
}
export type Trade = {
  kind: "trade"
  launchId: Hash
  trader: Address
  side: "buy" | "sell"
  /** Quote base units per whole token after the trade. */
  price: bigint
  /** Cumulative tokens sold on the curve after the trade. */
  sold: bigint
  /** Block timestamp, unix seconds. */
  timestamp: number
  tokenAmount: bigint
  /** `ethAmount`: gross paid on a buy, net payout on a sell, in quote base units. */
  quoteAmount: bigint
  refund: bigint
}
export type LaunchFinalized = {
  kind: "launchFinalized"
  launchId: Hash
  poolId: Hash
  liquidityQuote: bigint
  liquidityTokens: bigint
}
export type XStocksHookCreated = {
  kind: "xstocksHookCreated"
  assetId: Hash
  wrapper: Address
  hook: Address
}
export type DecodedLog =
  | LaunchCreated
  | LaunchMetadata
  | Trade
  | LaunchFinalized
  | XStocksHookCreated

const lower = (a: string) => a.toLowerCase() as Address
const id = (n: bigint) => toHex(n, { size: 32 })

function topicAddress(topic: Hex | undefined): Address {
  if (!topic) throw new Error("xStocks hook-created log is missing a topic")
  return lower(`0x${topic.slice(26)}`)
}

function decodeHookEvent(log: { topics: readonly Hex[]; data: Hex }) {
  try {
    return decodeEventLog({
      abi: hookEventsAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    })
  } catch (err) {
    if (err instanceof AbiEventSignatureNotFoundError) return null
    throw err
  }
}

/** Decodes one InkyPump V2 log. Returns null for a topic0 it doesn't know. Does not check the emitter. */
export function decodeLog(log: { topics: readonly Hex[]; data: Hex }): DecodedLog | null {
  const [topic0, t1, t2, t3] = log.topics
  if (topic0 === undefined) return null
  if (topic0 === XSTOCKS_HOOK_CREATED_TOPIC) {
    if (!t1) throw new Error("xStocks hook-created log is missing assetId")
    return {
      kind: "xstocksHookCreated",
      assetId: t1,
      wrapper: topicAddress(t2),
      hook: topicAddress(t3),
    }
  }
  const ev = decodeHookEvent(log)
  if (!ev) return null
  switch (ev.eventName) {
    case "LaunchCreated":
      return {
        kind: "launchCreated",
        launchId: id(ev.args.launchId),
        creator: lower(ev.args.creator),
        token: lower(ev.args.token),
        targetRaise: ev.args.targetRaise,
      }
    case "LaunchMetadata": {
      const a = ev.args
      return {
        kind: "launchMetadata",
        launchId: id(a.launchId),
        name: a.name,
        ticker: a.ticker,
        description: a.description,
        imageUrl: a.imageUrl,
        telegram: a.telegram,
        twitter: a.twitter,
        website: a.website,
      }
    }
    case "Trade": {
      const a = ev.args
      if (a.tradeType !== 0 && a.tradeType !== 1)
        throw new Error(`unknown tradeType ${a.tradeType}`)
      return {
        kind: "trade",
        launchId: id(a.launchId),
        trader: lower(a.trader),
        side: a.tradeType === 0 ? "buy" : "sell",
        price: a.priceData.price,
        sold: a.priceData.sold,
        timestamp: a.priceData.timestamp,
        tokenAmount: a.tradeData.tokenAmount,
        quoteAmount: a.tradeData.ethAmount,
        refund: a.refund,
      }
    }
    case "LaunchFinalized":
      return {
        kind: "launchFinalized",
        launchId: id(ev.args.launchId),
        poolId: ev.args.poolId,
        liquidityQuote: ev.args.liquidityEth,
        liquidityTokens: ev.args.liquidityTokens,
      }
  }
}
