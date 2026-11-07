import { parseAbi } from "viem"
import { HOOKIT_EVENTS } from "./constants"

export const hookitEventsAbi = parseAbi([
  HOOKIT_EVENTS.masterLaunched,
  HOOKIT_EVENTS.market,
  HOOKIT_EVENTS.configured,
  HOOKIT_EVENTS.devBuy,
  HOOKIT_EVENTS.classicLaunched,
  HOOKIT_EVENTS.bought,
  HOOKIT_EVENTS.sold,
  HOOKIT_EVENTS.drop,
  HOOKIT_EVENTS.graduated,
])

/** The bonding factory's per-launch record. */
export const hookitBondingAbi = parseAbi([
  "function launches(uint256 id) view returns (address token, address creator, address quote, uint8 phase, uint16 creatorTaxBps, uint256 totalSupply, uint256 curveSupply, uint256 tokensSold, uint256 realQuote, uint256 virtualQuote, uint256 virtualToken, uint256 graduationQuote, bytes32 poolId, uint64 launchedAt, uint64 graduatedAt)",
])

/** Every Hookit token exposes its metadata URI. */
export const hookitTokenAbi = parseAbi(["function metadataURI() view returns (string)"])
