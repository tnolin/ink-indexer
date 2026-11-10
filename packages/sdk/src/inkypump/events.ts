import {
  type BondEvent,
  type LaunchEvent,
  type LaunchpadKey,
  SCHEMA_VERSION,
  type SwapEvent,
  type TradeEvent,
} from "@ink-indexer/events"
import type { Address, Hash } from "viem"
import { cleanText, MAX_DESCRIPTION, MAX_LINK, MAX_TOKEN_TEXT } from "../metadata"
import { UNISWAP_V4_POOL_MANAGER } from "../v4/constants"
import type { V4Swap } from "../v4/decode"
import { poolMarketCap, poolPrice, quoteReserve, reservesInRange, swapLegs } from "../v4/math"
import { type CurveParams, curveValue, marketCap, progressBps, soldBps } from "./curve"
import type { LaunchCreated, LaunchFinalized, LaunchMetadata, Trade } from "./decode"

export type LogMeta = {
  txHash: Hash
  logIndex: number
  blockNumber: bigint
  blockTimestamp: number
}

const base = (launchpad: LaunchpadKey, token: Address, launchId: Hash, m: LogMeta) => ({
  v: SCHEMA_VERSION,
  chainId: 57073 as const,
  launchpad,
  token,
  launchId,
  txHash: m.txHash,
  logIndex: m.logIndex,
  blockNumber: m.blockNumber.toString(),
  blockTimestamp: m.blockTimestamp,
})

/** Launch text from the hook is creator-controlled: strip what Postgres refuses and bound the length. */
const orNull = (s: string | undefined, max: number) =>
  s ? cleanText(cleanText(s).slice(0, max)) || null : null

export function launchEvent(
  created: LaunchCreated,
  metadata: LaunchMetadata | null,
  ctx: { hook: Address; quoteAsset: Address; totalSupply: bigint },
  m: LogMeta,
): LaunchEvent {
  return {
    type: "launchpad.launch",
    ...base("inkypump", created.token, created.launchId, m),
    hook: ctx.hook,
    creator: created.creator,
    name: orNull(metadata?.name, MAX_TOKEN_TEXT),
    ticker: orNull(metadata?.ticker, MAX_TOKEN_TEXT),
    description: orNull(metadata?.description, MAX_DESCRIPTION),
    imageUrl: orNull(metadata?.imageUrl, MAX_LINK),
    links: {
      telegram: orNull(metadata?.telegram, MAX_LINK),
      twitter: orNull(metadata?.twitter, MAX_LINK),
      website: orNull(metadata?.website, MAX_LINK),
    },
    quoteAsset: ctx.quoteAsset,
    targetRaise: created.targetRaise.toString(),
    totalSupply: ctx.totalSupply.toString(),
    startsInPool: false,
    poolId: null,
    poolManager: null,
    customHook: null,
    hookModules: null,
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
    athMarketCap: bigint
  },
  m: LogMeta,
): TradeEvent {
  const value = curveValue(ctx.params, trade.sold)
  return {
    type: "launchpad.trade",
    ...base("inkypump", ctx.token, trade.launchId, m),
    side: trade.side,
    trader: trade.trader,
    tokenAmount: trade.tokenAmount.toString(),
    quoteAmount: trade.quoteAmount.toString(),
    price: trade.price.toString(),
    curveValue: value.toString(),
    target: ctx.params.targetRaise.toString(),
    progressBpsBefore: ctx.progressBpsBefore,
    progressBpsAfter: progressBps(value, ctx.params.targetRaise),
    soldBps: soldBps(trade.sold, ctx.params.saleSupply),
    marketCap: marketCap(trade.price, ctx.totalSupply).toString(),
    athMarketCap: ctx.athMarketCap.toString(),
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
    ...base("inkypump", ctx.token, fin.launchId, m),
    poolId: fin.poolId,
    poolManager: UNISWAP_V4_POOL_MANAGER,
    liquidityQuote: fin.liquidityQuote.toString(),
    liquidityTokens: fin.liquidityTokens.toString(),
    quoteAsset: ctx.quoteAsset,
  }
}

/** A swap in a v4 pool, valued at the pool price after the swap. */
export function swapEvent(
  swap: V4Swap,
  ctx: {
    launchpad: LaunchpadKey
    token: Address
    launchId: Hash
    poolManager: Address
    tokenIsCurrency0: boolean
    quoteAsset: Address
    /** The transaction's sender. */
    trader: Address
    /** Total supply minus the dead address's balance. */
    supply: bigint
    athMarketCap: bigint
    /**
     * The tick range the pool's liquidity was added in. With either edge given, liquidity is valued
     * in that range and the event carries both sides; without, the pool is full range and only the
     * quote side is reported.
     */
    tickLower?: number
    tickUpper?: number
  },
  m: LogMeta,
): SwapEvent {
  const legs = swapLegs(swap, ctx.tokenIsCurrency0)
  const ranged = ctx.tickLower !== undefined || ctx.tickUpper !== undefined
  const held = ranged
    ? reservesInRange(
        swap.sqrtPriceX96,
        swap.liquidity,
        ctx.tickLower ?? null,
        ctx.tickUpper ?? null,
      )
    : null
  const [quoteSide, tokenSide] = held
    ? ctx.tokenIsCurrency0
      ? [held.amount1, held.amount0]
      : [held.amount0, held.amount1]
    : [quoteReserve(swap.liquidity, swap.sqrtPriceX96, ctx.tokenIsCurrency0), null]
  return {
    type: "launchpad.swap",
    ...base(ctx.launchpad, ctx.token, ctx.launchId, m),
    poolId: swap.poolId,
    poolManager: ctx.poolManager,
    side: legs.side,
    trader: ctx.trader,
    router: swap.sender,
    tokenAmount: legs.tokenAmount.toString(),
    quoteAmount: legs.quoteAmount.toString(),
    quoteAsset: ctx.quoteAsset,
    price: poolPrice(swap.sqrtPriceX96, ctx.tokenIsCurrency0).toString(),
    marketCap: poolMarketCap(swap.sqrtPriceX96, ctx.tokenIsCurrency0, ctx.supply).toString(),
    athMarketCap: ctx.athMarketCap.toString(),
    quoteLiquidity: quoteSide.toString(),
    ...(tokenSide !== null && { tokenLiquidity: tokenSide.toString() }),
    supply: ctx.supply.toString(),
  }
}
