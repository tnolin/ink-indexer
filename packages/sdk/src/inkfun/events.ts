import type { BondEvent, LaunchEvent, TradeEvent } from "@ink-indexer/events"
import { SCHEMA_VERSION } from "@ink-indexer/events"
import { type Address, type Hash, pad } from "viem"
import { NATIVE_QUOTE_ASSET } from "../inkypump/deployments"
import type { LogMeta } from "../inkypump/events"
import { UNISWAP_V4_POOL_MANAGER } from "../v4/constants"
import { INKFUN_HOOK } from "./constants"
import { type InkfunCurve, inkfunCurveValue, inkfunPrice, inkfunProgressBps } from "./curve"
import type { InkfunBought, InkfunLaunchCreated, InkfunMigrated, InkfunSold } from "./decode"
import type { LaunchMetadataFields } from "./metadata"

const WHOLE_TOKEN = 10n ** 18n

/** ink.fun has no launch number: a launch is identified by its curve address, left-padded to 32 bytes. */
export function inkfunLaunchId(curve: Address): Hash {
  return pad(curve, { size: 32 })
}

const base = (token: Address, launchId: Hash, m: LogMeta) => ({
  v: SCHEMA_VERSION,
  chainId: 57073 as const,
  launchpad: "inkfun" as const,
  token,
  launchId,
  txHash: m.txHash,
  logIndex: m.logIndex,
  blockNumber: m.blockNumber.toString(),
  blockTimestamp: m.blockTimestamp,
})

const orNull = (s: string | undefined) => (s ? s : null)

export function inkfunLaunchEvent(
  created: InkfunLaunchCreated,
  ctx: {
    totalSupply: bigint
    graduationTarget: bigint
    metadata: LaunchMetadataFields | null
  },
  m: LogMeta,
): LaunchEvent {
  return {
    type: "launchpad.launch",
    ...base(created.token, inkfunLaunchId(created.curve), m),
    hook: INKFUN_HOOK,
    creator: created.creator,
    name: orNull(created.name),
    ticker: orNull(created.symbol),
    description: ctx.metadata?.description ?? null,
    imageUrl: ctx.metadata?.imageUrl ?? null,
    links: {
      telegram: ctx.metadata?.links.telegram ?? null,
      twitter: ctx.metadata?.links.twitter ?? null,
      website: ctx.metadata?.links.website ?? null,
    },
    quoteAsset: NATIVE_QUOTE_ASSET,
    targetRaise: ctx.graduationTarget.toString(),
    totalSupply: ctx.totalSupply.toString(),
    startsInPool: false,
    poolId: null,
    poolManager: null,
    customHook: null,
    hookModules: null,
  }
}

export function inkfunTradeEvent(
  d: InkfunBought | InkfunSold,
  ctx: {
    token: Address
    launchId: Hash
    curve: InkfunCurve
    totalSupply: bigint
    progressBpsBefore: number
    athMarketCap: bigint
  },
  m: LogMeta,
): TradeEvent {
  const price = inkfunPrice(ctx.curve, d.tokensSold)
  const progress = inkfunProgressBps(ctx.curve, d.tokensSold)
  const buy = d.kind === "bought"
  return {
    type: "launchpad.trade",
    ...base(ctx.token, ctx.launchId, m),
    side: buy ? "buy" : "sell",
    trader: buy ? d.beneficiary : d.seller,
    tokenAmount: (buy ? d.tokensOut : d.tokensIn).toString(),
    quoteAmount: (buy ? d.quoteIn + d.fee : d.quoteOut).toString(),
    price: price.toString(),
    curveValue: inkfunCurveValue(ctx.curve, d.tokensSold).toString(),
    target: ctx.curve.graduationTarget.toString(),
    progressBpsBefore: ctx.progressBpsBefore,
    progressBpsAfter: progress,
    soldBps: progress,
    marketCap: ((price * ctx.totalSupply) / WHOLE_TOKEN).toString(),
    athMarketCap: ctx.athMarketCap.toString(),
    quoteAsset: NATIVE_QUOTE_ASSET,
  }
}

export function inkfunBondEvent(d: InkfunMigrated, ctx: { launchId: Hash }, m: LogMeta): BondEvent {
  return {
    type: "launchpad.bond",
    ...base(d.token, ctx.launchId, m),
    poolId: d.poolId,
    poolManager: UNISWAP_V4_POOL_MANAGER,
    liquidityQuote: d.quoteAmount.toString(),
    liquidityTokens: d.tokenAmount.toString(),
    quoteAsset: NATIVE_QUOTE_ASSET,
  }
}
