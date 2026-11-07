import { type Address, decodeEventLog, type Hash, type Hex } from "viem"
import { hookitEventsAbi } from "./abi"
import { HOOKIT_LOG_TOPICS } from "./constants"

export type HookitLog =
  | {
      kind: "masterLaunched"
      launchId: bigint
      token: Address
      creator: Address
      /** Market 0's pool. */
      poolId: Hash
      hooks: Address
      /** True when the pool uses a hook the creator supplied rather than one of Hookit's. */
      customHook: boolean
      tickLower: number
      tickUpper: number
      liquidity: bigint
    }
  | {
      kind: "market"
      launchId: bigint
      index: number
      poolId: Hash
      quote: Address
      bps: number
      tickLower: number
      tickUpper: number
      liquidity: bigint
    }
  | {
      kind: "configured"
      launchId: bigint
      bitmask: bigint
      quote: Address
      tickSpacing: number
      fee: number
    }
  | { kind: "devBuy"; launchId: bigint; buyer: Address; quoteIn: bigint; tokensOut: bigint }
  | {
      kind: "classicLaunched"
      launchId: bigint
      token: Address
      creator: Address
      quote: Address
      graduationQuote: bigint
    }
  | {
      kind: "bought"
      launchId: bigint
      buyer: Address
      quoteIn: bigint
      tokensOut: bigint
      feeQuote: bigint
    }
  | {
      kind: "sold"
      launchId: bigint
      seller: Address
      tokensIn: bigint
      quoteOut: bigint
      feeQuote: bigint
    }
  | { kind: "drop"; launchId: bigint; token: Address; quoteIn: bigint; tokensOut: bigint }
  | {
      kind: "graduated"
      launchId: bigint
      poolId: Hash
      quoteLp: bigint
      tokenLp: bigint
      liquidity: bigint
    }

const lower = (a: string) => a.toLowerCase() as Address

/**
 * Decodes one Hookit factory log. Returns null for a topic0 it doesn't know and for a log whose
 * data doesn't decode, so one malformed log never fails a span. Does not check the emitter.
 */
export function decodeHookitLog(log: { topics: readonly Hex[]; data: Hex }): HookitLog | null {
  const topic0 = log.topics[0]
  if (topic0 === undefined || !HOOKIT_LOG_TOPICS.includes(topic0)) return null
  let ev: ReturnType<typeof decodeEventLog<typeof hookitEventsAbi>>
  try {
    ev = decodeEventLog({
      abi: hookitEventsAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    })
  } catch {
    // A contract can emit the same topic0 with another layout.
    return null
  }
  switch (ev.eventName) {
    case "TokenLaunched": {
      const a = ev.args
      // The two signatures differ in their fields, so the shape tells them apart.
      if ("hooks" in a)
        return {
          kind: "masterLaunched",
          launchId: a.launchId,
          token: lower(a.token),
          creator: lower(a.creator),
          poolId: a.poolId.toLowerCase() as Hash,
          hooks: lower(a.hooks),
          customHook: a.customHook,
          tickLower: a.tickLower,
          tickUpper: a.tickUpper,
          liquidity: a.liquidity,
        }
      return {
        kind: "classicLaunched",
        launchId: a.launchId,
        token: lower(a.token),
        creator: lower(a.creator),
        quote: lower(a.quote),
        graduationQuote: a.graduationQuote,
      }
    }
    case "MarketLaunched":
      return {
        kind: "market",
        launchId: ev.args.launchId,
        index: ev.args.marketIndex,
        poolId: ev.args.poolId.toLowerCase() as Hash,
        quote: lower(ev.args.quote),
        bps: ev.args.bps,
        tickLower: ev.args.tickLower,
        tickUpper: ev.args.tickUpper,
        liquidity: ev.args.liquidity,
      }
    case "LaunchConfigured":
      return {
        kind: "configured",
        launchId: ev.args.launchId,
        bitmask: ev.args.bitmask,
        quote: lower(ev.args.quote),
        tickSpacing: ev.args.tickSpacing,
        fee: ev.args.fee,
      }
    case "DevBuyExecuted":
      return {
        kind: "devBuy",
        launchId: ev.args.launchId,
        buyer: lower(ev.args.buyer),
        quoteIn: ev.args.quoteIn,
        tokensOut: ev.args.tokensOut,
      }
    case "Bought":
      return {
        kind: "bought",
        launchId: ev.args.launchId,
        buyer: lower(ev.args.buyer),
        quoteIn: ev.args.quoteIn,
        tokensOut: ev.args.tokensOut,
        feeQuote: ev.args.feeQuote,
      }
    case "Sold":
      return {
        kind: "sold",
        launchId: ev.args.launchId,
        seller: lower(ev.args.seller),
        tokensIn: ev.args.tokensIn,
        quoteOut: ev.args.quoteOut,
        feeQuote: ev.args.feeQuote,
      }
    case "HktHolderDrop":
      return {
        kind: "drop",
        launchId: ev.args.launchId,
        token: lower(ev.args.token),
        quoteIn: ev.args.quoteIn,
        tokensOut: ev.args.tokensOut,
      }
    case "Graduated":
      return {
        kind: "graduated",
        launchId: ev.args.launchId,
        poolId: ev.args.poolId.toLowerCase() as Hash,
        quoteLp: ev.args.quoteLp,
        tokenLp: ev.args.tokenLp,
        liquidity: ev.args.liquidity,
      }
  }
}
