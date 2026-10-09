import { parseAbi } from "viem"

export const hookEventsAbi = parseAbi([
  "struct PriceData { uint256 price; uint128 sold; uint40 timestamp; }",
  "struct TradeData { address trader; uint256 tokenAmount; uint256 ethAmount; }",
  "event LaunchCreated(uint256 indexed launchId, address indexed creator, address token, uint96 targetRaise)",
  "event LaunchMetadata(uint256 indexed launchId, string name, string ticker, string description, string imageUrl, string telegram, string twitter, string website)",
  "event Trade(uint256 indexed launchId, address indexed trader, uint8 tradeType, PriceData priceData, TradeData tradeData, uint256 refund)",
  "event LaunchFinalized(uint256 indexed launchId, bytes32 poolId, uint256 liquidityEth, uint256 liquidityTokens)",
])

export const launchStateAbi = parseAbi([
  "struct LaunchConfig { address token; uint64 launchTimestamp; uint32 antiSnipeDuration; address creator; uint16 salePortionBps; uint16 creatorFeeSplitBps; uint32 gainBps; bool finalized; uint128 saleSupply; uint128 liquiditySupply; uint128 sold; uint128 raised; uint128 netContributions; uint96 targetRaise; uint160 sqrtPriceX96; }",
  "function getLaunchState(uint256 launchId) view returns (LaunchConfig)",
])

/** Emitted by both xStocks factories; indexed topics are (bytes32 assetId, address wrapper, address hook). The contracts are unverified, so only the topics are read. */
export const XSTOCKS_HOOK_CREATED_TOPIC =
  "0xceaa948d871a8cc1f4dd59421695ca558fb265be27089509cbcaa1049dc551a6" as const
