import { parseAbi } from "viem"

export const inkfunEventsAbi = parseAbi([
  "event LaunchCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol)",
  "event Bought(address indexed payer, address indexed beneficiary, uint256 quoteIn, uint256 fee, uint256 tokensOut, uint256 refund, uint256 tokensSold)",
  "event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tokensSold)",
  "event Migrated(bytes32 indexed poolId, address indexed launchToken, uint256 tokenAmount, uint256 quoteAmount, uint256 tokenId, uint160 sqrtPriceX96)",
])

export const inkfunCurveAbi = parseAbi([
  "function virtualQuote() view returns (uint256)",
  "function virtualTokens() view returns (uint256)",
  "function curveSupply() view returns (uint256)",
  "function lpSupply() view returns (uint256)",
  "function graduationTarget() view returns (uint256)",
  "function tokensSold() view returns (uint256)",
])

export const inkfunTokenAbi = parseAbi([
  "function metadataURI() view returns (string)",
  "function totalSupply() view returns (uint256)",
])
