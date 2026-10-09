export const SCHEMA_VERSION = 1 as const

/** Lowercase 0x-prefixed hex. */
export type Address = `0x${string}`
/** Lowercase 0x-prefixed 32-byte hex. */
export type Hash = `0x${string}`

type Base = {
  v: typeof SCHEMA_VERSION
  chainId: 57073
  launchpad: "inkypump"
  token: Address
  launchId: Hash
  txHash: Hash
  logIndex: number
  /** Decimal string. */
  blockNumber: string
  /** Unix seconds. */
  blockTimestamp: number
}

/** All amounts are decimal strings in base units. */
export type LaunchEvent = Base & {
  type: "launchpad.launch"
  hook: Address
  creator: Address
  name: string | null
  ticker: string | null
  description: string | null
  imageUrl: string | null
  links: { telegram: string | null; twitter: string | null; website: string | null }
  quoteAsset: Address
  targetRaise: string
  totalSupply: string
}

export type TradeEvent = Base & {
  type: "launchpad.trade"
  side: "buy" | "sell"
  trader: Address
  tokenAmount: string
  /** Gross quote paid on a buy, net quote paid out on a sell. */
  quoteAmount: string
  /** Quote base units per whole token after the trade. */
  price: string
  /** The curve's own value at the new `sold`. Bonding happens when it reaches `target`. */
  curveValue: string
  target: string
  progressBpsBefore: number
  progressBpsAfter: number
  marketCap: string
  quoteAsset: Address
}

export type BondEvent = Base & {
  type: "launchpad.bond"
  poolId: Hash
  liquidityQuote: string
  liquidityTokens: string
  quoteAsset: Address
}

export type IndexerEvent = LaunchEvent | TradeEvent | BondEvent
export type IndexerEventType = IndexerEvent["type"]
