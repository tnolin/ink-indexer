import { type Address, decodeAbiParameters, decodeEventLog, type Hex } from "viem"
import { ccaConfigParameter, ccaEventsAbi, nftxEventsAbi } from "./abi"
import { CCA_TOPICS, NFTX_LOG_TOPICS } from "./constants"

export type NftxListing = {
  owner: Address
  /** Unix seconds. */
  created: number
  /** Seconds. */
  duration: number
  /** 100 is 1.00x. */
  floorMultiple: number
}

export type NftxLog =
  | {
      kind: "created"
      collection: Address
      token: Address
      name: string
      symbol: string
      creator: Address
    }
  | {
      kind: "initialized"
      collection: Address
      poolKey: Hex
      tokenIds: bigint[]
      sqrtPriceX96: bigint
      sender: Address
    }
  | {
      kind: "deposit"
      collection: Address
      tokenIds: bigint[]
      sender: Address
      recipient: Address
    }
  | {
      kind: "withdrawal"
      collection: Address
      tokenId: bigint
      sender: Address
      recipient: Address
    }
  | { kind: "sunset"; collection: Address; token: Address; sender: Address }
  | {
      kind: "zapBought"
      collection: Address
      nftCount: bigint
      ethSpent: bigint
      buyer: Address
    }
  | {
      kind: "zapRedeemed"
      collection: Address
      tokenIds: bigint[]
      ethSpent: bigint
      redeemer: Address
    }
  | {
      kind: "zapSold"
      collection: Address
      tokenIds: bigint[]
      ethReceived: bigint
      seller: Address
    }
  | {
      kind: "gatedSale"
      collection: Address
      tokenIds: bigint[]
      seller: Address
      ethReceived: bigint
      royalty: bigint
    }
  | {
      kind: "listingsCreated"
      collection: Address
      tokenIds: bigint[]
      listing: NftxListing
      listingType: "liquid" | "dutch" | null
      tokensRequired: bigint
      taxRequired: bigint
      sender: Address
    }
  | { kind: "relisted"; collection: Address; tokenId: bigint; listing: NftxListing }
  | {
      kind: "multipleUpdated"
      collection: Address
      tokenId: bigint
      oldMultiple: number
      newMultiple: number
    }
  | {
      kind: "filled"
      collection: Address
      /** The groups of the event's `uint256[][]`, flattened in order. */
      tokenIds: bigint[]
      /** Carries `msg.sender` of the fill: the Zap for a Zap buy, else the buyer. */
      sender: Address
    }
  | { kind: "cancelled"; collection: Address; tokenIds: bigint[] }
  | {
      kind: "stale"
      collection: Address
      tokenId: bigint
      owner: Address
      feesCaptured: bigint
      refunded: bigint
    }
  | {
      kind: "poolState"
      collection: Address
      sqrtPriceX96: bigint
      tick: number
      protocolFee: number
      swapFee: number
      liquidity: bigint
    }
  | {
      kind: "launchCreated"
      launchId: bigint
      collection: Address
      creator: Address
      /** The floor token the Locker mints for the collection. */
      floorToken: Address
      /** The ERC-20 the launch's auction sells; each whole token claims one NFT after settlement. */
      claimToken: Address
      auction: Address
    }

const lower = (a: string) => a.toLowerCase() as Address
const listingOf = (l: {
  owner: Address
  created: number
  duration: number
  floorMultiple: number
}): NftxListing => ({
  owner: lower(l.owner),
  created: Number(l.created),
  duration: Number(l.duration),
  floorMultiple: Number(l.floorMultiple),
})
const listingType = (t: number): "liquid" | "dutch" | null =>
  t === 0 ? "dutch" : t === 1 ? "liquid" : null

/**
 * Decodes one NFTX log. Null for a topic0 it does not read and for data that does not decode, so
 * one malformed log never fails a span. It does not check the emitter.
 */
export function decodeNftxLog(log: { topics: readonly Hex[]; data: Hex }): NftxLog | null {
  const topic0 = log.topics[0]
  if (topic0 === undefined || !NFTX_LOG_TOPICS.includes(topic0)) return null
  let ev: ReturnType<typeof decodeEventLog<typeof nftxEventsAbi>>
  try {
    ev = decodeEventLog({
      abi: nftxEventsAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    })
  } catch {
    return null
  }
  switch (ev.eventName) {
    case "CollectionCreated":
      return {
        kind: "created",
        collection: lower(ev.args._collection),
        token: lower(ev.args._collectionToken),
        name: ev.args._name,
        symbol: ev.args._symbol,
        creator: lower(ev.args._creator),
      }
    case "CollectionInitialized":
      return {
        kind: "initialized",
        collection: lower(ev.args._collection),
        poolKey: ev.args._poolKey,
        tokenIds: [...ev.args._tokenIds],
        sqrtPriceX96: ev.args._sqrtPriceX96,
        sender: lower(ev.args._sender),
      }
    case "TokenDeposit":
      return {
        kind: "deposit",
        collection: lower(ev.args._collection),
        tokenIds: [...ev.args._tokenIds],
        sender: lower(ev.args._sender),
        recipient: lower(ev.args._recipient),
      }
    case "TokenWithdrawal":
      return {
        kind: "withdrawal",
        collection: lower(ev.args._collection),
        tokenId: ev.args._tokenId,
        sender: lower(ev.args._sender),
        recipient: lower(ev.args._recipient),
      }
    case "CollectionSunset":
      return {
        kind: "sunset",
        collection: lower(ev.args._collection),
        token: lower(ev.args._collectionToken),
        sender: lower(ev.args._sender),
      }
    case "NFTBoughtWithETH":
      return {
        kind: "zapBought",
        collection: lower(ev.args.collection),
        nftCount: ev.args.nftCount,
        ethSpent: ev.args.ethSpent,
        buyer: lower(ev.args.buyer),
      }
    case "FloorRedeemedWithETH":
      return {
        kind: "zapRedeemed",
        collection: lower(ev.args.collection),
        tokenIds: [...ev.args.tokenIds],
        ethSpent: ev.args.ethSpent,
        redeemer: lower(ev.args.redeemer),
      }
    case "NFTSoldForETH":
      return {
        kind: "zapSold",
        collection: lower(ev.args.collection),
        tokenIds: [...ev.args.tokenIds],
        ethReceived: ev.args.ethReceived,
        seller: lower(ev.args.seller),
      }
    case "GatedSale":
      return {
        kind: "gatedSale",
        collection: lower(ev.args._collection),
        tokenIds: [...ev.args._tokenIds],
        seller: lower(ev.args._seller),
        ethReceived: ev.args._ethReceived,
        royalty: ev.args._royalty,
      }
    case "ListingsCreated":
      return {
        kind: "listingsCreated",
        collection: lower(ev.args._collection),
        tokenIds: [...ev.args._tokenIds],
        listing: listingOf(ev.args._listing),
        listingType: listingType(ev.args._listingType),
        tokensRequired: ev.args._tokensRequired,
        taxRequired: ev.args._taxRequired,
        sender: lower(ev.args._sender),
      }
    case "ListingRelisted":
      return {
        kind: "relisted",
        collection: lower(ev.args._collection),
        tokenId: ev.args._tokenId,
        listing: listingOf(ev.args._listing),
      }
    case "ListingFloorMultipleUpdated":
      return {
        kind: "multipleUpdated",
        collection: lower(ev.args._collection),
        tokenId: ev.args._tokenId,
        oldMultiple: Number(ev.args._oldFloorMultiple),
        newMultiple: Number(ev.args._newFloorMultiple),
      }
    case "ListingsFilled":
      return {
        kind: "filled",
        collection: lower(ev.args._collection),
        tokenIds: ev.args._tokenIds.flatMap((group) => [...group]),
        sender: lower(ev.args._recipient),
      }
    case "ListingsCancelled":
      return {
        kind: "cancelled",
        collection: lower(ev.args._collection),
        tokenIds: [...ev.args._tokenIds],
      }
    case "ListingClosedAsStale":
      return {
        kind: "stale",
        collection: lower(ev.args._collection),
        tokenId: ev.args._tokenId,
        owner: lower(ev.args._owner),
        feesCaptured: ev.args._feesCaptured,
        refunded: ev.args._refunded,
      }
    case "PoolStateUpdated":
      return {
        kind: "poolState",
        collection: lower(ev.args._collection),
        sqrtPriceX96: ev.args._sqrtPriceX96,
        tick: Number(ev.args._tick),
        protocolFee: Number(ev.args._protocolFee),
        swapFee: Number(ev.args._swapFee),
        liquidity: ev.args._liquidity,
      }
    case "LaunchCreated":
      return {
        kind: "launchCreated",
        launchId: ev.args._launchId,
        collection: lower(ev.args._collection),
        creator: lower(ev.args._creator),
        floorToken: lower(ev.args._vToken),
        claimToken: lower(ev.args._claimToken),
        auction: lower(ev.args._auction),
      }
  }
}

export type AuctionConfig = {
  currency: Address
  tokensRecipient: Address
  fundsRecipient: Address
  startBlock: bigint
  endBlock: bigint
  claimBlock: bigint
  tickSpacing: bigint
  validationHook: Address
  /** Q96 price of one token unit. */
  floorPrice: bigint
  requiredCurrencyRaised: bigint
}

export type CcaLog =
  | {
      kind: "auctionCreated"
      auction: Address
      token: Address
      amount: bigint
      config: AuctionConfig
    }
  | { kind: "tokensReceived"; totalSupply: bigint }
  | { kind: "bid"; id: bigint; owner: Address; priceQ96: bigint; amount: bigint }
  | { kind: "clearingPrice"; checkpointBlock: bigint; priceQ96: bigint }
  | {
      kind: "exited"
      bidId: bigint
      owner: Address
      tokensFilled: bigint
      currencyRefunded: bigint
    }
  | { kind: "claimed"; bidId: bigint; owner: Address; tokensFilled: bigint }

const CCA_LOG_TOPICS: readonly Hex[] = Object.values(CCA_TOPICS)

/**
 * Decodes one auction or factory log. Null for another topic0, for data that does not decode and
 * for an `AuctionCreated` whose `configData` does not. It does not check the emitter.
 */
export function decodeCcaLog(log: { topics: readonly Hex[]; data: Hex }): CcaLog | null {
  const topic0 = log.topics[0]
  if (topic0 === undefined || !CCA_LOG_TOPICS.includes(topic0)) return null
  let ev: ReturnType<typeof decodeEventLog<typeof ccaEventsAbi>>
  try {
    ev = decodeEventLog({
      abi: ccaEventsAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    })
  } catch {
    return null
  }
  switch (ev.eventName) {
    case "AuctionCreated": {
      let c: {
        currency: Address
        tokensRecipient: Address
        fundsRecipient: Address
        startBlock: bigint
        endBlock: bigint
        claimBlock: bigint
        tickSpacing: bigint
        validationHook: Address
        floorPrice: bigint
        requiredCurrencyRaised: bigint
      }
      try {
        c = decodeAbiParameters([ccaConfigParameter], ev.args.configData)[0]
      } catch {
        return null
      }
      return {
        kind: "auctionCreated",
        auction: lower(ev.args.auction),
        token: lower(ev.args.token),
        amount: ev.args.amount,
        config: {
          currency: lower(c.currency),
          tokensRecipient: lower(c.tokensRecipient),
          fundsRecipient: lower(c.fundsRecipient),
          startBlock: BigInt(c.startBlock),
          endBlock: BigInt(c.endBlock),
          claimBlock: BigInt(c.claimBlock),
          tickSpacing: c.tickSpacing,
          validationHook: lower(c.validationHook),
          floorPrice: c.floorPrice,
          requiredCurrencyRaised: BigInt(c.requiredCurrencyRaised),
        },
      }
    }
    case "TokensReceived":
      return { kind: "tokensReceived", totalSupply: BigInt(ev.args.totalSupply) }
    case "BidSubmitted":
      return {
        kind: "bid",
        id: ev.args.id,
        owner: lower(ev.args.owner),
        priceQ96: ev.args.priceQ96,
        amount: BigInt(ev.args.amount),
      }
    case "ClearingPriceUpdated":
      return {
        kind: "clearingPrice",
        checkpointBlock: ev.args.blockNumber,
        priceQ96: ev.args.clearingPriceQ96,
      }
    case "BidExited":
      return {
        kind: "exited",
        bidId: ev.args.bidId,
        owner: lower(ev.args.owner),
        tokensFilled: ev.args.tokensFilled,
        currencyRefunded: ev.args.currencyRefunded,
      }
    case "TokensClaimed":
      return {
        kind: "claimed",
        bidId: ev.args.bidId,
        owner: lower(ev.args.owner),
        tokensFilled: ev.args.tokensFilled,
      }
  }
}
