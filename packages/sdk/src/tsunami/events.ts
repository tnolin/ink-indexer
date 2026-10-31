import type { BondEvent, LaunchEvent, TradeEvent } from "@ink-indexer/events"
import { SCHEMA_VERSION } from "@ink-indexer/events"
import { type Address, type Hash, pad } from "viem"
import { orNull } from "../inkfun/events"
import type { LaunchMetadataFields } from "../inkfun/metadata"
import type { LogMeta } from "../inkypump/events"
import { CALAMARI_POOL_MANAGER } from "./constants"
import { tsunamiMarketCap, tsunamiPrice, tsunamiProgressBps } from "./curve"
import { poolIdOf, type TsunamiLog } from "./decode"

type Of<K extends TsunamiLog["kind"]> = Extract<TsunamiLog, { kind: K }>

const MAX_NAME = 100
const MAX_TICKER = 32

/** A launch is identified by its curve address, left-padded to 32 bytes. */
export function tsunamiLaunchId(curve: Address): Hash {
  return pad(curve, { size: 32 })
}

const base = (token: Address, launchId: Hash, m: LogMeta) => ({
  v: SCHEMA_VERSION,
  chainId: 57073 as const,
  launchpad: "tsunami" as const,
  token,
  launchId,
  txHash: m.txHash,
  logIndex: m.logIndex,
  blockNumber: m.blockNumber.toString(),
  blockTimestamp: m.blockTimestamp,
})

export function tsunamiLaunchEvent(
  d: Of<"launched">,
  ctx: { hook: Address; supply: bigint; metadata: LaunchMetadataFields | null },
  m: LogMeta,
): LaunchEvent {
  return {
    type: "launchpad.launch",
    ...base(d.token, tsunamiLaunchId(d.curve), m),
    hook: ctx.hook,
    creator: d.creator,
    name: orNull(d.name, MAX_NAME),
    ticker: orNull(d.symbol, MAX_TICKER),
    description: ctx.metadata?.description ?? null,
    imageUrl: ctx.metadata?.imageUrl ?? null,
    links: {
      telegram: ctx.metadata?.links.telegram ?? null,
      twitter: ctx.metadata?.links.twitter ?? null,
      website: ctx.metadata?.links.website ?? null,
    },
    quoteAsset: d.quote,
    targetRaise: d.targetRaise.toString(),
    totalSupply: ctx.supply.toString(),
    startsInPool: false,
    poolId: null,
    poolManager: null,
    customHook: null,
    hookModules: null,
  }
}

export function tsunamiTradeEvent(
  d: Of<"bought" | "sold">,
  ctx: {
    token: Address
    launchId: Hash
    quote: Address
    targetRaise: bigint
    supply: bigint
    trader: Address
    progressBpsBefore: number
    athMarketCap: bigint
  },
  m: LogMeta,
): TradeEvent {
  const buy = d.kind === "bought"
  const progress = tsunamiProgressBps(d.state, ctx.targetRaise)
  return {
    type: "launchpad.trade",
    ...base(ctx.token, ctx.launchId, m),
    side: buy ? "buy" : "sell",
    trader: ctx.trader,
    tokenAmount: (buy ? d.amountOut : d.amount).toString(),
    quoteAmount: (buy ? d.amount : d.amountOut).toString(),
    price: tsunamiPrice(d.state).toString(),
    curveValue: d.state.realQuote.toString(),
    target: ctx.targetRaise.toString(),
    progressBpsBefore: ctx.progressBpsBefore,
    progressBpsAfter: progress,
    soldBps: progress,
    marketCap: tsunamiMarketCap(d.state, ctx.supply).toString(),
    athMarketCap: ctx.athMarketCap.toString(),
    quoteAsset: ctx.quote,
  }
}

export function tsunamiBondEvent(
  d: Of<"migrated">,
  ctx: { launchId: Hash; quote: Address },
  m: LogMeta,
): BondEvent {
  return {
    type: "launchpad.bond",
    ...base(d.token, ctx.launchId, m),
    poolId: poolIdOf(d.key),
    poolManager: CALAMARI_POOL_MANAGER,
    liquidityQuote: d.quoteRaised.toString(),
    liquidityTokens: d.baseForPool.toString(),
    quoteAsset: ctx.quote,
  }
}
