import type { BondEvent, LaunchEvent, TradeEvent } from "@ink-indexer/events"
import { SCHEMA_VERSION } from "@ink-indexer/events"
import { type Address, type Hash, pad } from "viem"
import type { LaunchMetadataFields } from "../inkfun/metadata"
import type { LogMeta } from "../inkypump/events"
import { cleanText } from "../metadata"
import { UNISWAP_V4_POOL_MANAGER } from "../v4/constants"
import { hookModules } from "./bitmask"
import { HOOKIT_GRADUATED_FEE_HOOK } from "./constants"
import {
  type ClassicCurve,
  classicMarketCap,
  classicPrice,
  classicProgressBps,
  classicState,
} from "./curve"
import type { HookitLog } from "./decode"

type Of<K extends HookitLog["kind"]> = Extract<HookitLog, { kind: K }>

/** Numeric launch ids repeat across Hookit's factories, so a launch is identified by its token. */
export function hookitLaunchId(token: Address): Hash {
  return pad(token, { size: 32 })
}

const base = (token: Address, m: LogMeta) => ({
  v: SCHEMA_VERSION,
  chainId: 57073 as const,
  launchpad: "hookit" as const,
  token,
  launchId: hookitLaunchId(token),
  txHash: m.txHash,
  logIndex: m.logIndex,
  blockNumber: m.blockNumber.toString(),
  blockTimestamp: m.blockTimestamp,
})

const MAX_NAME = 100
const MAX_TICKER = 32

/** Cleaned text cut to `max` characters; null when nothing is left. */
const orNull = (s: string | null, max: number) =>
  s === null ? null : cleanText(cleanText(s).slice(0, max)) || null

const fieldsOf = (metadata: LaunchMetadataFields | null) => ({
  description: metadata?.description ?? null,
  imageUrl: metadata?.imageUrl ?? null,
  links: {
    telegram: metadata?.links.telegram ?? null,
    twitter: metadata?.links.twitter ?? null,
    website: metadata?.links.website ?? null,
  },
})

/**
 * A Master launch: the token trades in its pool from the first block. `markets` holds the
 * `MarketLaunched` logs of the transaction in market order; with more than one, the event lists
 * every pair, and market 0 supplies the quote and the pool.
 */
export function hookitMasterLaunchEvent(
  d: Of<"masterLaunched">,
  ctx: {
    configured: Of<"configured">
    markets: Of<"market">[]
    supply: bigint
    name: string | null
    ticker: string | null
    metadata: LaunchMetadataFields | null
  },
  m: LogMeta,
): LaunchEvent {
  const event: LaunchEvent = {
    type: "launchpad.launch",
    ...base(d.token, m),
    hook: d.hooks,
    creator: d.creator,
    name: orNull(ctx.name, MAX_NAME),
    ticker: orNull(ctx.ticker, MAX_TICKER),
    ...fieldsOf(ctx.metadata),
    quoteAsset: ctx.configured.quote,
    targetRaise: null,
    totalSupply: ctx.supply.toString(),
    startsInPool: true,
    poolId: d.poolId,
    poolManager: UNISWAP_V4_POOL_MANAGER,
    customHook: d.customHook,
    hookModules: hookModules(ctx.configured.bitmask),
  }
  if (ctx.markets.length > 1)
    event.markets = ctx.markets.map((k) => ({ quoteAsset: k.quote, poolId: k.poolId }))
  return event
}

/** A Classic launch: the token starts on a bonding curve and graduates into a pool. */
export function hookitClassicLaunchEvent(
  d: Of<"classicLaunched">,
  ctx: {
    supply: bigint
    name: string | null
    ticker: string | null
    metadata: LaunchMetadataFields | null
  },
  m: LogMeta,
): LaunchEvent {
  return {
    type: "launchpad.launch",
    ...base(d.token, m),
    hook: HOOKIT_GRADUATED_FEE_HOOK,
    creator: d.creator,
    name: orNull(ctx.name, MAX_NAME),
    ticker: orNull(ctx.ticker, MAX_TICKER),
    ...fieldsOf(ctx.metadata),
    quoteAsset: d.quote,
    targetRaise: d.graduationQuote.toString(),
    totalSupply: ctx.supply.toString(),
    startsInPool: false,
    poolId: null,
    poolManager: null,
    customHook: false,
    hookModules: null,
  }
}

/** A curve trade. `sold` is the net tokens sold after it, which fixes the curve's state. */
export function hookitTradeEvent(
  d: Of<"bought" | "sold">,
  ctx: {
    token: Address
    quote: Address
    curve: ClassicCurve
    sold: bigint
    supply: bigint
    trader: Address
    progressBpsBefore: number
    athMarketCap: bigint
  },
  m: LogMeta,
): TradeEvent {
  const buy = d.kind === "bought"
  const progress = classicProgressBps(ctx.curve, ctx.sold)
  return {
    type: "launchpad.trade",
    ...base(ctx.token, m),
    side: buy ? "buy" : "sell",
    trader: ctx.trader,
    tokenAmount: (buy ? d.tokensOut : d.tokensIn).toString(),
    quoteAmount: (buy ? d.quoteIn : d.quoteOut).toString(),
    price: classicPrice(ctx.curve, ctx.sold).toString(),
    curveValue: classicState(ctx.curve, ctx.sold).realQuote.toString(),
    target: ctx.curve.graduationQuote.toString(),
    progressBpsBefore: ctx.progressBpsBefore,
    progressBpsAfter: progress,
    soldBps: progress,
    marketCap: classicMarketCap(ctx.curve, ctx.sold, ctx.supply).toString(),
    athMarketCap: ctx.athMarketCap.toString(),
    quoteAsset: ctx.quote,
  }
}

export function hookitBondEvent(
  d: Of<"graduated">,
  ctx: { token: Address; quote: Address },
  m: LogMeta,
): BondEvent {
  return {
    type: "launchpad.bond",
    ...base(ctx.token, m),
    poolId: d.poolId,
    poolManager: UNISWAP_V4_POOL_MANAGER,
    liquidityQuote: d.quoteLp.toString(),
    liquidityTokens: d.tokenLp.toString(),
    quoteAsset: ctx.quote,
  }
}
