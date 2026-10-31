import {
  type Address,
  decodeEventLog,
  encodeAbiParameters,
  type Hash,
  type Hex,
  keccak256,
} from "viem"
import { cleanText } from "../inkfun/metadata"
import { tsunamiEventsAbi } from "./abi"
import { TSUNAMI_LOG_TOPICS } from "./constants"

/** The four reserves every curve event carries, after the trade the event reports. */
export type TsunamiCurveState = {
  realBase: bigint
  realQuote: bigint
  virtualBase: bigint
  virtualQuote: bigint
}

/** A Uniswap v4 pool key. */
export type PoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export type TsunamiLog =
  | {
      kind: "launched"
      /** True for the first `TokenLaunched` signature, which has no fee share. */
      legacy: boolean
      name: string
      uri: string
      symbol: string
      curve: Address
      token: Address
      targetRaise: bigint
      quote: Address
      creator: Address
      state: TsunamiCurveState
      feeShare: Address | null
    }
  | {
      kind: "bought" | "sold"
      /** A buy: the gross quote spent. A sell: the tokens sold. */
      amount: bigint
      /** The caller of the curve: a router or the factory, not the trader. */
      buyer: Address
      /** A buy: the tokens received. A sell: the net quote paid out. */
      amountOut: bigint
      timestamp: number
      state: TsunamiCurveState
    }
  | {
      kind: "migrated"
      token: Address
      hook: Address
      key: PoolKey
      quoteRaised: bigint
      baseForPool: bigint
      timestamp: number
      state: TsunamiCurveState
    }
  | { kind: "poolMoved"; source: Hash; destination: Hash }
  | { kind: "initialize"; poolId: Hash; currency0: Address; currency1: Address; hooks: Address }

const MAX_NAME = 100
const MAX_SYMBOL = 32

const lower = (a: string) => a.toLowerCase() as Address
const bounded = (s: string, max: number) => cleanText(cleanText(s).slice(0, max))
const stateOf = (c: {
  realBaseReserves: bigint
  realQuoteReserves: bigint
  virtualBaseReserves: bigint
  virtualQuoteReserves: bigint
}): TsunamiCurveState => ({
  realBase: c.realBaseReserves,
  realQuote: c.realQuoteReserves,
  virtualBase: c.virtualBaseReserves,
  virtualQuote: c.virtualQuoteReserves,
})

/** The id Uniswap v4 gives a pool: the hash of its ABI-encoded key. */
export function poolIdOf(key: PoolKey): Hash {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  )
}

/**
 * Decodes one Tsunami log. Returns null for a topic0 it doesn't know and for a log whose data
 * doesn't decode, so one malformed log never fails a span. Does not check the emitter.
 */
export function decodeTsunamiLog(log: { topics: readonly Hex[]; data: Hex }): TsunamiLog | null {
  const topic0 = log.topics[0]
  if (topic0 === undefined || !TSUNAMI_LOG_TOPICS.includes(topic0)) return null
  let ev: ReturnType<typeof decodeEventLog<typeof tsunamiEventsAbi>>
  try {
    ev = decodeEventLog({
      abi: tsunamiEventsAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    })
  } catch {
    // A contract can emit the same topic0 with another layout.
    return null
  }
  switch (ev.eventName) {
    case "TokenLaunched": {
      const a = ev.args as typeof ev.args & { feeShare?: Address }
      return {
        kind: "launched",
        legacy: a.feeShare === undefined,
        name: bounded(a.name, MAX_NAME),
        uri: a.uri,
        symbol: bounded(a.symbol, MAX_SYMBOL),
        curve: lower(a.curve),
        token: lower(a.token),
        targetRaise: a.targetRaise,
        quote: lower(a.quoteToken),
        creator: lower(a.creator),
        state: stateOf(a.curveState),
        feeShare: a.feeShare === undefined ? null : lower(a.feeShare),
      }
    }
    case "TokenBought":
    case "TokenSold":
      return {
        kind: ev.eventName === "TokenBought" ? "bought" : "sold",
        amount: ev.args.amount,
        buyer: lower(ev.args.buyer),
        amountOut: ev.args.amountOut,
        timestamp: Number(ev.args.timestamp),
        state: stateOf(ev.args.curve),
      }
    case "TokenMigrated":
      return {
        kind: "migrated",
        token: lower(ev.args.token),
        hook: lower(ev.args.hook),
        key: {
          currency0: lower(ev.args.poolKey.currency0),
          currency1: lower(ev.args.poolKey.currency1),
          fee: ev.args.poolKey.fee,
          tickSpacing: ev.args.poolKey.tickSpacing,
          hooks: lower(ev.args.poolKey.hooks),
        },
        quoteRaised: ev.args.quoteRaised,
        baseForPool: ev.args.baseForPool,
        timestamp: Number(ev.args.timestamp),
        state: stateOf(ev.args.curve),
      }
    case "CreatorPoolMigrated":
      return {
        kind: "poolMoved",
        source: ev.args.sourcePoolId.toLowerCase() as Hash,
        destination: ev.args.destinationPoolId.toLowerCase() as Hash,
      }
    case "Initialize":
      return {
        kind: "initialize",
        poolId: ev.args.id.toLowerCase() as Hash,
        currency0: lower(ev.args.currency0),
        currency1: lower(ev.args.currency1),
        hooks: lower(ev.args.hooks),
      }
  }
}
