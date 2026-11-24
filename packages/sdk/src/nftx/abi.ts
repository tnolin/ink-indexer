import { parseAbi } from "viem"
import { CCA_EVENTS, NFTX_EVENTS } from "./constants"

const LISTING_STRUCT =
  "struct Listing { address owner; uint40 created; uint32 duration; uint16 floorMultiple; }"

export const nftxEventsAbi = parseAbi([
  LISTING_STRUCT,
  NFTX_EVENTS.CollectionCreated,
  NFTX_EVENTS.CollectionInitialized,
  NFTX_EVENTS.TokenDeposit,
  NFTX_EVENTS.TokenWithdrawal,
  NFTX_EVENTS.CollectionSunset,
  NFTX_EVENTS.NFTBoughtWithETH,
  NFTX_EVENTS.FloorRedeemedWithETH,
  NFTX_EVENTS.NFTSoldForETH,
  NFTX_EVENTS.GatedSale,
  NFTX_EVENTS.ListingsCreated,
  NFTX_EVENTS.ListingRelisted,
  NFTX_EVENTS.ListingFloorMultipleUpdated,
  NFTX_EVENTS.ListingsFilled,
  NFTX_EVENTS.ListingsCancelled,
  NFTX_EVENTS.ListingClosedAsStale,
  NFTX_EVENTS.PoolStateUpdated,
  NFTX_EVENTS.LaunchCreated,
])

export const ccaEventsAbi = parseAbi([
  CCA_EVENTS.AuctionCreated,
  CCA_EVENTS.TokensReceived,
  CCA_EVENTS.BidSubmitted,
  CCA_EVENTS.ClearingPriceUpdated,
  CCA_EVENTS.BidExited,
  CCA_EVENTS.TokensClaimed,
])

/** Reads on the Listings contract. `getListingType` takes the listing struct it read. */
export const nftxListingsAbi = parseAbi([
  LISTING_STRUCT,
  "function listings(address collection, uint256 tokenId) view returns (Listing)",
  "function getListingPrice(address collection, uint256 tokenId) view returns (bool isAvailable, uint256 price)",
  "function getListingType(address collection, Listing listing) view returns (uint8)",
  "function listingCount(address collection) view returns (uint256)",
])

export const nftxCollectionAbi = parseAbi([
  "function owner() view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
])

/** The auction's functions the source reads at a block. */
export const ccaAuctionAbi = parseAbi([
  // Writes the auction's pending state; only the calls after it in one multicall see the effect.
  "function checkpoint()",
  "function currencyRaised() view returns (uint256)",
  "function totalCleared() view returns (uint256)",
  "function isGraduated() view returns (bool)",
  "function clearingPrice() view returns (uint256)",
])

/**
 * `AuctionCreated.configData`: the auction's parameters as one ABI-encoded tuple. The factory
 * encodes the struct whole, so it is decoded as a single tuple parameter.
 */
export const ccaConfigParameter = {
  type: "tuple",
  components: [
    { name: "currency", type: "address" },
    { name: "tokensRecipient", type: "address" },
    { name: "fundsRecipient", type: "address" },
    { name: "startBlock", type: "uint64" },
    { name: "endBlock", type: "uint64" },
    { name: "claimBlock", type: "uint64" },
    { name: "tickSpacing", type: "uint256" },
    { name: "validationHook", type: "address" },
    { name: "floorPrice", type: "uint256" },
    { name: "requiredCurrencyRaised", type: "uint128" },
    { name: "auctionStepsData", type: "bytes" },
  ],
} as const

/** `CollectionInitialized._poolKey`: the Uniswap v4 pool key, five static words. */
export const nftxPoolKeyParameters = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const
