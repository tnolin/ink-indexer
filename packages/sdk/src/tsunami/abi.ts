import { parseAbi } from "viem"

const CURVE =
  "(uint256 realBaseReserves, uint256 realQuoteReserves, uint256 virtualBaseReserves, uint256 virtualQuoteReserves)"

/** Event signatures, one per topic0 the source reads. */
export const TSUNAMI_EVENTS = {
  launchedLegacy: `event TokenLaunched(string name, string uri, string symbol, address indexed curve, address indexed token, uint256 targetRaise, address quoteToken, address creator, ${CURVE} curveState)`,
  launched: `event TokenLaunched(string name, string uri, string symbol, address indexed curve, address indexed token, uint256 targetRaise, address quoteToken, address creator, ${CURVE} curveState, address indexed feeShare)`,
  bought: `event TokenBought(uint256 indexed amount, address indexed buyer, uint256 amountOut, uint256 timestamp, ${CURVE} curve)`,
  sold: `event TokenSold(uint256 indexed amount, address indexed buyer, uint256 amountOut, uint256 timestamp, ${CURVE} curve)`,
  migrated: `event TokenMigrated(address indexed token, address indexed hook, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 quoteRaised, uint256 baseForPool, uint256 timestamp, ${CURVE} curve)`,
  poolMoved:
    "event CreatorPoolMigrated(bytes32 indexed sourcePoolId, bytes32 indexed destinationPoolId, uint128 oldLiquidity, uint128 newLiquidity, uint256 principal0, uint256 principal1, uint256 historicalFees0, uint256 historicalFees1, uint256 residual0, uint256 residual1)",
  initialize:
    "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
} as const

export const tsunamiEventsAbi = parseAbi([
  TSUNAMI_EVENTS.launchedLegacy,
  TSUNAMI_EVENTS.launched,
  TSUNAMI_EVENTS.bought,
  TSUNAMI_EVENTS.sold,
  TSUNAMI_EVENTS.migrated,
  TSUNAMI_EVENTS.poolMoved,
  TSUNAMI_EVENTS.initialize,
])

export const tsunamiCurveAbi = parseAbi([
  `function curve() view returns ${CURVE}`,
  "function token() view returns (address)",
])
