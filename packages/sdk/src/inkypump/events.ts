import {
  type BondEvent,
  type LaunchEvent,
  SCHEMA_VERSION,
  type TradeEvent,
} from "@ink-indexer/events"
import type { Address, Hash } from "viem"
import { type CurveParams, curveValue, marketCap, progressBps } from "./curve"
import type { LaunchCreated, LaunchFinalized, LaunchMetadata, Trade } from "./decode"

export type LogMeta = {
  txHash: Hash
  logIndex: number
  blockNumber: bigint
  blockTimestamp: number
}

const base = (token: Address, launchId: Hash, m: LogMeta) => ({
  v: SCHEMA_VERSION,
  chainId: 57073 as const,
  launchpad: "inkypump" as const,
  token,
  launchId,
  txHash: m.txHash,
  logIndex: m.logIndex,
  blockNumber: m.blockNumber.toString(),
  blockTimestamp: m.blockTimestamp,
})

const orNull = (s: string | undefined) => (s ? s : null)

export function launchEvent(
  created: LaunchCreated,
  metadata: LaunchMetadata | null,
  ctx: { hook: Address; quoteAsset: Address; totalSupply: bigint },
  m: LogMeta,
): LaunchEvent {
  return {
    type: "launchpad.launch",
    ...base(created.token, created.launchId, m),
    hook: ctx.hook,
    creator: created.creator,
    name: orNull(metadata?.name),
    ticker: orNull(metadata?.ticker),
    description: orNull(metadata?.description),
    imageUrl: orNull(metadata?.imageUrl),
    links: {
      telegram: orNull(metadata?.telegram),
      twitter: orNull(metadata?.twitter),
      website: orNull(metadata?.website),
    },
    quoteAsset: ctx.quoteAsset,
    targetRaise: created.targetRaise.toString(),
    totalSupply: ctx.totalSupply.toString(),
  }
}

export function tradeEvent(
  trade: Trade,
  ctx: {
    token: Address
    params: CurveParams
    totalSupply: bigint
    quoteAsset: Address
    progressBpsBefore: number
  },
  m: LogMeta,
): TradeEvent {
  const value = curveValue(ctx.params, trade.sold)
  return {
    type: "launchpad.trade",
    ...base(ctx.token, trade.launchId, m),
    side: trade.side,
    trader: trade.trader,
    tokenAmount: trade.tokenAmount.toString(),
    quoteAmount: trade.quoteAmount.toString(),
    price: trade.price.toString(),
    curveValue: value.toString(),
    target: ctx.params.targetRaise.toString(),
    progressBpsBefore: ctx.progressBpsBefore,
    progressBpsAfter: progressBps(value, ctx.params.targetRaise),
    marketCap: marketCap(trade.price, ctx.totalSupply).toString(),
    quoteAsset: ctx.quoteAsset,
  }
}

export function bondEvent(
  fin: LaunchFinalized,
  ctx: { token: Address; quoteAsset: Address },
  m: LogMeta,
): BondEvent {
  return {
    type: "launchpad.bond",
    ...base(ctx.token, fin.launchId, m),
    poolId: fin.poolId,
    liquidityQuote: fin.liquidityQuote.toString(),
    liquidityTokens: fin.liquidityTokens.toString(),
    quoteAsset: ctx.quoteAsset,
  }
}
