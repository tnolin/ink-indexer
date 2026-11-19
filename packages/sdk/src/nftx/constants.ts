import type { Address, Hex } from "viem"

/** NFTX v4 Locker: holds a collection's NFTs and mints its floor token. */
export const NFTX_LOCKER: Address = "0xb4c5b5235b98114e9dc227b54e088c11680b2385"
/** The Uniswap v4 hook every NFTX pool uses. */
export const NFTX_HOOK: Address = "0xaa49adadd33c5e953b645567afb10cbbba63afc4"
/** Listings contract: floor-multiple listings of items held by the Locker. */
export const NFTX_LISTINGS: Address = "0x11f09e7eed242fad875d3565b3d9ca8aade445ae"
/** The two Zaps deployed by NFTX; both buy and sell through the Locker, Listings and pool. */
export const NFTX_ZAPS: readonly Address[] = [
  "0x000000144106c1bfc69fbbd04d56220e1a0a9a3c",
  "0xdf288b66a77f25197544877eaf4626d7e64cb5a8",
]
/** Sells NFTs to the pool through the Zap and takes a royalty. */
export const NFTX_ROYALTY_GATE: Address = "0xb1c4e21393b3f9a3f75f3a7c7abc18cd07fbba4f"
/** Wrapped ETH of the pools: 1 flETH is 1 ETH on Ink. */
export const NFTX_FLETH: Address = "0x000000000dd39073cfc60e7102288ccbd7bf23fe"
/** Uniswap's continuous clearing auction factory (v2.1.0). */
export const CCA_FACTORY: Address = "0x000000001f26a0044baa66024e7b6599c61963f8"
/**
 * NFTX's launchpad, whose collections are created into the Locker. Null until it is deployed on
 * Ink; while null, no collection is treated as created by it.
 */
export const NFTX_LAUNCHPAD: Address | null = null

/** Block the auction factory was deployed in, the earliest block any NFTX source reads. */
export const NFTX_START_BLOCK = 52_372_123n

/** Event signatures, one per topic0 the NFTX source reads. */
export const NFTX_EVENTS = {
  CollectionCreated:
    "event CollectionCreated(address indexed _collection, address _collectionToken, string _name, string _symbol, address _creator)",
  CollectionInitialized:
    "event CollectionInitialized(address indexed _collection, bytes _poolKey, uint256[] _tokenIds, uint256 _sqrtPriceX96, address _sender)",
  TokenDeposit:
    "event TokenDeposit(address indexed _collection, uint256[] _tokenIds, address _sender, address _recipient)",
  TokenWithdrawal:
    "event TokenWithdrawal(address indexed _collection, uint256 _tokenId, address _sender, address _recipient)",
  CollectionSunset:
    "event CollectionSunset(address indexed _collection, address _collectionToken, address _sender)",
  NFTBoughtWithETH:
    "event NFTBoughtWithETH(address indexed collection, uint256 nftCount, uint256 ethSpent, address indexed buyer)",
  FloorRedeemedWithETH:
    "event FloorRedeemedWithETH(address indexed collection, uint256[] tokenIds, uint256 ethSpent, address indexed redeemer)",
  NFTSoldForETH:
    "event NFTSoldForETH(address indexed collection, uint256[] tokenIds, uint256 ethReceived, address indexed seller)",
  GatedSale:
    "event GatedSale(address indexed _collection, uint256[] _tokenIds, address indexed _seller, uint256 _ethReceived, uint256 _royalty)",
  ListingsCreated:
    "event ListingsCreated(address indexed _collection, uint256[] _tokenIds, Listing _listing, uint8 _listingType, uint256 _tokensRequired, uint256 _taxRequired, address _sender)",
  ListingRelisted:
    "event ListingRelisted(address indexed _collection, uint256 _tokenId, Listing _listing)",
  ListingFloorMultipleUpdated:
    "event ListingFloorMultipleUpdated(address indexed _collection, uint256 _tokenId, uint32 _oldFloorMultiple, uint32 _newFloorMultiple)",
  ListingsFilled:
    "event ListingsFilled(address indexed _collection, uint256[][] _tokenIds, address _recipient)",
  ListingsCancelled: "event ListingsCancelled(address indexed _collection, uint256[] _tokenIds)",
  ListingClosedAsStale:
    "event ListingClosedAsStale(address indexed _collection, uint256 _tokenId, address _owner, uint256 _feesCaptured, uint256 _refunded)",
  PoolStateUpdated:
    "event PoolStateUpdated(address indexed _collection, uint160 _sqrtPriceX96, int24 _tick, uint24 _protocolFee, uint24 _swapFee, uint128 _liquidity)",
} as const satisfies Record<string, string>

/** Event signatures of the auction factory and of each auction it creates. */
export const CCA_EVENTS = {
  AuctionCreated:
    "event AuctionCreated(address indexed auction, address indexed token, uint256 amount, bytes configData)",
  TokensReceived: "event TokensReceived(uint128 totalSupply)",
  BidSubmitted:
    "event BidSubmitted(uint256 indexed id, address indexed owner, uint256 priceQ96, uint128 amount)",
  ClearingPriceUpdated: "event ClearingPriceUpdated(uint256 blockNumber, uint256 clearingPriceQ96)",
  BidExited:
    "event BidExited(uint256 indexed bidId, address indexed owner, uint256 tokensFilled, uint256 currencyRefunded)",
  TokensClaimed:
    "event TokensClaimed(uint256 indexed bidId, address indexed owner, uint256 tokensFilled)",
} as const satisfies Record<string, string>

/** topic0 of each NFTX event, the keccak of its signature. */
export const NFTX_TOPICS = {
  CollectionCreated: "0xe721ab2f9f866ad70d72eddc396ac2c039b896b857829e61033b7a3e93ff8445",
  CollectionInitialized: "0x1fe1afb21e15dc445b6c2b68a3f112c0f08134dabb337fee679509181d6172bc",
  TokenDeposit: "0x2a0292910cfeebf41d27d707aee2c6fcae2c9b2a538927a3204e5782346c021d",
  TokenWithdrawal: "0x6bfad0e48c8e154d9407db2826f60a46a17cbe110183eddfb0b7a2551d19dd24",
  CollectionSunset: "0x7576233f6fb38f5fc2017b6e90e002abdc9b7887168493ff3dedb6791276392f",
  NFTBoughtWithETH: "0xf4eb2c5d56f1fb65a491d1883b173c9a576b48d5d2bda99ee22f68ce1268b589",
  FloorRedeemedWithETH: "0x234d2a31986967eb33e16ead698a5baded816f6249e58b32ab26e9b69ab0250e",
  NFTSoldForETH: "0xd53ea687e8d13cb85c6166d300bd59f310922d4dba8679bfd45f22b9ab1b2299",
  GatedSale: "0x69c6978af96a13bdbeae7cd03b9dc43d1efd4de21dbc69a3eeb0dec2817c3a63",
  ListingsCreated: "0x250be97066f80e5aa32477ae7841be4172ebee2599baf46697d1dbe44dbfb67e",
  ListingRelisted: "0x8f22536c79fc92f544ab79094caf72933bd3870bd22452827df8c9cb672f80f5",
  ListingFloorMultipleUpdated: "0xea7ff847f064f945ddbfdbebfb07ec06ddc9bec6771ed411c926e273ed140423",
  ListingsFilled: "0x758eadefab78f302aea6155f01699ed8a007298219ebeda621f76f9f1ef0d24f",
  ListingsCancelled: "0xa47018c42c61057e7a37594e25de41c075fe406812220210810f603c051a8fa6",
  ListingClosedAsStale: "0xe35714800fb0f70eea10b0a51c958a2d60fa2611ed849843937f751f71681da8",
  PoolStateUpdated: "0xf135dfa5b5fa680fa48985844390b91a75201b7f725abe87a4b421537db3e466",
} as const satisfies Record<keyof typeof NFTX_EVENTS, Hex>

/** topic0 of each auction event. `AuctionCreated` comes from the factory, the rest from each auction. */
export const CCA_TOPICS = {
  AuctionCreated: "0x7ede475fad18ccf0039f2b956c4d43a8b4ed0853de4daaa8ae25299f331ae3b9",
  TokensReceived: "0x468160b6769cb8abc9324bc14fe70ee0ce87f1e92087186c6ae22a964a04c572",
  BidSubmitted: "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540",
  ClearingPriceUpdated: "0x30adbe996d7a69a21fdebcc1f8a46270bf6c22d505a7d872c1ab4767aa707609",
  BidExited: "0x054fe6469466a0b4d2a6ae4b100e5f9c494c958f04b4000f44d470088dd97930",
  TokensClaimed: "0x880f2ef2613b092f1a0a819f294155c98667eb294b7e6bf7a3810278142c1a1c",
} as const satisfies Record<keyof typeof CCA_EVENTS, Hex>

/** The topic0s emitted by an auction contract, not the factory. */
export const CCA_AUCTION_TOPICS: readonly Hex[] = [
  CCA_TOPICS.TokensReceived,
  CCA_TOPICS.BidSubmitted,
  CCA_TOPICS.ClearingPriceUpdated,
  CCA_TOPICS.BidExited,
  CCA_TOPICS.TokensClaimed,
]

/** Every topic0 the Locker, Zaps, RoyaltyGate, Listings and hook emit that the source reads. */
export const NFTX_LOG_TOPICS: readonly Hex[] = Object.values(NFTX_TOPICS)
