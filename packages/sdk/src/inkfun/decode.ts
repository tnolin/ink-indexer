import { type Address, decodeEventLog, type Hash, type Hex } from "viem"
import { inkfunEventsAbi } from "./abi"
import { INKFUN_LOG_TOPICS } from "./constants"

export type InkfunLaunchCreated = {
  kind: "launchCreated"
  token: Address
  curve: Address
  creator: Address
  name: string
  symbol: string
}
export type InkfunBought = {
  kind: "bought"
  payer: Address
  beneficiary: Address
  /** Quote paid into the curve, net of the fee. */
  quoteIn: bigint
  fee: bigint
  tokensOut: bigint
  refund: bigint
  /** Cumulative tokens sold on the curve after the trade. */
  tokensSold: bigint
}
export type InkfunSold = {
  kind: "sold"
  seller: Address
  tokensIn: bigint
  /** Quote paid out, net of the fee. */
  quoteOut: bigint
  fee: bigint
  /** Cumulative tokens sold on the curve after the trade. */
  tokensSold: bigint
}
export type InkfunMigrated = {
  kind: "migrated"
  poolId: Hash
  token: Address
  tokenAmount: bigint
  quoteAmount: bigint
  tokenId: bigint
  sqrtPriceX96: bigint
}
export type InkfunLog = InkfunLaunchCreated | InkfunBought | InkfunSold | InkfunMigrated

const lower = (a: string) => a.toLowerCase() as Address

/** Decodes one ink.fun log. Returns null for a topic0 it doesn't know. Does not check the emitter. */
export function decodeInkfunLog(log: { topics: readonly Hex[]; data: Hex }): InkfunLog | null {
  const topic0 = log.topics[0]
  if (topic0 === undefined || !INKFUN_LOG_TOPICS.includes(topic0)) return null
  const ev = decodeEventLog({
    abi: inkfunEventsAbi,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  })
  switch (ev.eventName) {
    case "LaunchCreated":
      return {
        kind: "launchCreated",
        token: lower(ev.args.token),
        curve: lower(ev.args.curve),
        creator: lower(ev.args.creator),
        name: ev.args.name,
        symbol: ev.args.symbol,
      }
    case "Bought":
      return {
        kind: "bought",
        payer: lower(ev.args.payer),
        beneficiary: lower(ev.args.beneficiary),
        quoteIn: ev.args.quoteIn,
        fee: ev.args.fee,
        tokensOut: ev.args.tokensOut,
        refund: ev.args.refund,
        tokensSold: ev.args.tokensSold,
      }
    case "Sold":
      return {
        kind: "sold",
        seller: lower(ev.args.seller),
        tokensIn: ev.args.tokensIn,
        quoteOut: ev.args.quoteOut,
        fee: ev.args.fee,
        tokensSold: ev.args.tokensSold,
      }
    case "Migrated":
      return {
        kind: "migrated",
        poolId: ev.args.poolId,
        token: lower(ev.args.launchToken),
        tokenAmount: ev.args.tokenAmount,
        quoteAmount: ev.args.quoteAmount,
        tokenId: ev.args.tokenId,
        sqrtPriceX96: ev.args.sqrtPriceX96,
      }
  }
}
