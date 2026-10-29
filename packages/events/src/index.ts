export const SCHEMA_VERSION = 2 as const

/** Lowercase 0x-prefixed hex. */
export type Address = `0x${string}`
/** Lowercase 0x-prefixed 32-byte hex. */
export type Hash = `0x${string}`

export type LaunchpadKey = "inkypump" | "inkfun" | "tsunami" | "hookit" | "chimera"

export type LaunchpadBase = {
  v: typeof SCHEMA_VERSION
  chainId: 57073
  launchpad: LaunchpadKey
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
export type LaunchEvent = LaunchpadBase & {
  type: "launchpad.launch"
  hook: Address
  creator: Address
  name: string | null
  ticker: string | null
  description: string | null
  imageUrl: string | null
  links: { telegram: string | null; twitter: string | null; website: string | null }
  quoteAsset: Address
  /** Null for a token that starts in a pool and has no bonding curve. */
  targetRaise: string | null
  totalSupply: string
  /** True when the token trades in a pool from its first block. */
  startsInPool: boolean
  poolId: Hash | null
  poolManager: Address | null
  /** Whether the pool uses a hook written for the launchpad. Null where it does not apply. */
  customHook: boolean | null
  hookModules: string[] | null
}

export type TradeEvent = LaunchpadBase & {
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
  /** Tokens sold over the sale supply in basis points, floored and capped at 10,000. */
  soldBps: number
  marketCap: string
  /** The highest market cap the token has reached, on the curve or in its pool, in quote base units. */
  athMarketCap: string
  quoteAsset: Address
}

export type BondEvent = LaunchpadBase & {
  type: "launchpad.bond"
  poolId: Hash
  poolManager: Address
  liquidityQuote: string
  liquidityTokens: string
  quoteAsset: Address
}

/** A swap in a Uniswap v4 pool of a tracked token. Amounts are decimal strings in base units. */
export type SwapEvent = LaunchpadBase & {
  type: "launchpad.swap"
  poolId: Hash
  poolManager: Address
  side: "buy" | "sell"
  /** The transaction's sender. */
  trader: Address
  /** The address that called the pool manager. */
  router: Address
  tokenAmount: string
  /** Quote paid on a buy, quote received on a sell. */
  quoteAmount: string
  quoteAsset: Address
  /** Quote base units per 1e18 token base units after the swap. */
  price: string
  /** Price times the circulating supply, in quote base units. */
  marketCap: string
  /** The highest market cap the token has reached, on the curve or in its pool. */
  athMarketCap: string
  /** The pool's quote side after the swap, in quote base units. */
  quoteLiquidity: string
  /** Total supply minus the dead address's balance, in token base units. */
  supply: string
}

export type LaunchpadEvent = LaunchEvent | TradeEvent | BondEvent | SwapEvent

/** Launch row as written before schema version 2. */
export type LaunchEventV1 = Omit<
  LaunchEvent,
  | "v"
  | "launchpad"
  | "targetRaise"
  | "startsInPool"
  | "poolId"
  | "poolManager"
  | "customHook"
  | "hookModules"
> & { v: 1; launchpad: "inkypump"; targetRaise: string }

/** Trade row as written before schema version 2. */
export type TradeEventV1 = Omit<TradeEvent, "v" | "launchpad" | "athMarketCap"> & {
  v: 1
  launchpad: "inkypump"
}

/** Bond row as written before schema version 2. */
export type BondEventV1 = Omit<BondEvent, "v" | "launchpad" | "poolManager"> & {
  v: 1
  launchpad: "inkypump"
}

export type NftBase = {
  v: 1 | 2
  chainId: 57073
  /** Collection contract, lowercase. Also the row's `entity`. */
  contract: Address
  source: "chain" | "opensea"
  /** A real transaction hash for chain events, a synthetic id for OpenSea events. */
  txHash: string
  logIndex: number
  /** Decimal string. */
  blockNumber: string
  /** Unix seconds: block time for chain events, receipt time for OpenSea events. */
  blockTimestamp: number
}

export type GateState = "pass" | "fail" | "pending"

export type NftGates = {
  page: GateState
  structure: GateState | "n/a"
  traits: GateState
  farm: GateState | "n/a"
  /** Share of the collection's distinct minters that are farm wallets, in basis points. */
  farmShareBps: number | null
}

export type NftCollectionEvent = NftBase & {
  type: "nft.collection"
  slug: string | null
  name: string | null
  imageUrl: string | null
  links: { twitter: string | null; website: string | null; discord: string | null }
  standard: "erc721" | "erc1155"
  kind: "drop" | "continuous" | "legacy"
  verdict: "real" | "pending" | "filtered"
  gates: NftGates
  /** True when the verdict was set by hand. */
  manual: boolean
  safelist: string | null
  /** Decimal string. */
  maxSupply: string | null
  seadrop: boolean
  openseaUrl: string | null
  /** Unix seconds, from the collection's rarity data. Null when absent. */
  rarityCalculatedAt: number | null
  maxRank: number | null
  launchpad: "chimera" | null
  /** The Chimera token of a collection launched there. */
  launchToken: Address | null
  /**
   * Who made the collection: the launch creator for a Chimera collection, else the owner OpenSea
   * names, with the OpenSea account's username and verified flag. Null while none is known.
   * Absent (undefined) on snapshots written before this field existed, so test with `== null`.
   */
  creator: { address: Address; username: string | null; verified: boolean } | null
}

export type NftDropStage = {
  type: string
  label: string
  /** Decimal string. */
  priceWei: string
  /** Unix seconds. */
  startTime: number
  /** Unix seconds. Null when the stage has no end. */
  endTime: number | null
  /** Null when the stage has no per-wallet cap. */
  maxPerWallet: number | null
  /** Null for stages without an allowlist, such as the public sale. */
  allowlistCount: number | null
}

export type NftDropEvent = NftBase & {
  type: "nft.drop"
  slug: string | null
  /** Decimal string. */
  maxSupply: string | null
  /** Ordered by start. */
  stages: NftDropStage[]
}

export type NftMintEvent = NftBase & {
  type: "nft.mint"
  kind: "stage_start" | "progress" | "sold_out"
  stageIndex: number
  stageLabel: string
  /** Decimal string. */
  stagePriceWei: string
  /** 2500, 5000 or 7500 for `progress`, null otherwise. */
  markBps: 2500 | 5000 | 7500 | null
  /** Decimal string. */
  minted: string
  /** Decimal string. */
  maxSupply: string
  /** Unix seconds. */
  mintStartTs: number
  /** Unix seconds. */
  stageStartTs: number
  /** Distinct recipients in the indexer's mint history, at most 8 days. */
  minters: number
  /** Only on `sold_out`: mints per stage. */
  stageCounts?: { stageIndex: number; label: string; minted: string }[]
}

export type NftCurrency = "ETH" | "WETH"

export type NftListingEvent = NftBase & {
  type: "nft.listing"
  tokenId: string
  /** Decimal string. */
  priceWei: string
  currency: NftCurrency
  maker: Address
  /** Unix seconds. */
  expiresAt: number
  orderHash: Hash
  itemName: string | null
  imageUrl: string | null
  /** Decimal string. */
  floorWei: string | null
  /** Unix seconds. */
  floorAt: number | null
  rank: number | null
  maxRank: number | null
}

export type NftSaleEvent = NftBase & {
  type: "nft.sale"
  tokenId: string
  /** Decimal string. */
  priceWei: string
  currency: NftCurrency
  buyer: Address
  seller: Address
  orderHash: Hash
  itemName: string | null
  imageUrl: string | null
  rank: number | null
  maxRank: number | null
  /** The latest known floor, decimal string. */
  floorWei: string | null
}

export type NftStatsEvent = NftBase & {
  type: "nft.stats"
  /** Decimal string. */
  floorWei: string | null
  /** From the indexer's own stats history, null under 24 hours of history. */
  floor24hAgoWei: string | null
  owners: number
  /** Decimal string. */
  volume24hWei: string
  sales24h: number
  /** Decimal string. Null when the supply is not known. */
  totalSupply: string | null
  /** Decimal string. The supply cap, where the collection has one; null when it is not known. */
  maxSupply: string | null
  /** Active listings counted, null when not counted. */
  listedCount: number | null
  /** True when `listedCount` stopped at the counting limit and the real number is higher. */
  listedCapped: boolean
}

/** A Chimera campaign was created: the launch of a collection and its token. */
export type NftLaunchEvent = NftBase & {
  type: "nft.launch"
  launchpad: "chimera"
  /** Decimal string. */
  campaignId: string
  token: Address
  /** The token's `symbol()` at launch; null when the call reverts. */
  tokenSymbol: string | null
  /** The token's `name()` at launch; null when the call reverts. */
  tokenName: string | null
  creator: Address
  poolId: Hash
}

export type NftEvent =
  | NftCollectionEvent
  | NftDropEvent
  | NftMintEvent
  | NftListingEvent
  | NftSaleEvent
  | NftStatsEvent
  | NftLaunchEvent

export type IndexerEvent = LaunchpadEvent | NftEvent
export type IndexerEventType = IndexerEvent["type"]

/** Any payload that can be in `indexer.events`: current shapes and the rows written before version 2. */
export type StoredEvent = IndexerEvent | LaunchEventV1 | TradeEventV1 | BondEventV1
