import type { Address, Hex } from "viem"

/**
 * The launch factories that create a token already trading in a Uniswap v4 pool. The first three
 * are the original generation, then Factory C, then the DN404 factory. All emit the same events.
 */
export const HOOKIT_MASTER_FACTORIES: ReadonlySet<Address> = new Set([
  "0xab6eae3092ae574bef0a16505fdf137072dcafdd",
  "0x2851cb70a6784ae69b45e6b7065908a00176322f",
  "0x99c6f8921858660881186296c39a07d1b30dc039",
  "0x145c3f3560c23fda93ea79f2efeb7f33d8a9ff3e",
  "0x670415f86826912e1dd167a41650da1a02aae7d6",
])

/** The bonding-curve factory: tokens trade on a curve and graduate into a GraduatedFeeHook pool. */
export const HOOKIT_BONDING_FACTORY: Address = "0x34bd9dec982167036a12ddf6ed2e7d71d5113dd6"

/** Block the first factory was deployed in. */
export const HOOKIT_START_BLOCK = 56_517_962n

/** The hook of every pool a Master factory creates, and the hook a graduated curve token trades under. */
export const HOOKIT_HOOKS = {
  master: [
    { address: "0xbd7e7815c640a67cabd9a93a15d1f250aaeeaac8", block: 56_517_960n },
    { address: "0x7c629422e9ac982ce72323d48ead94fcc092aac8", block: 56_618_517n },
    { address: "0x33200d9521ed99afbda8575f05348a583c7aaac8", block: 56_759_989n },
    { address: "0x4b533c432516fc1be4b0baefe6bff0942ad87fff", block: 57_556_983n },
    { address: "0x8a29b2c508007707bbff1814386aa968bbecbfff", block: 58_683_272n },
    { address: "0x1eee7628d070280da1b676c04d358d68b36f3fff", block: 59_883_877n },
  ],
  graduatedFee: { address: "0xaac738f140d529bc0662bddd812964d843362088", block: 56_517_988n },
} as const satisfies {
  master: { address: Address; block: bigint }[]
  graduatedFee: { address: Address; block: bigint }
}

/** The graduated-fee hook that holds every graduated curve token's pool. */
export const HOOKIT_GRADUATED_FEE_HOOK: Address = HOOKIT_HOOKS.graduatedFee.address

/** The protocol's buyback contract. Its pool swaps are trades of its own, never a token creator's. */
export const HOOKIT_BUYBACK: Address = "0x141038d294e8752f3eaff3c789bb824d56e87230"

/** Auto-Burn destroys tokens with `_burn`: a `Transfer` to the zero address that lowers `totalSupply`. */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000"

/** Event signatures, one per topic0 the source reads. */
export const HOOKIT_EVENTS = {
  masterLaunched:
    "event TokenLaunched(uint256 indexed launchId, address indexed token, address indexed creator, bytes32 poolId, address hooks, bool customHook, int24 tickLower, int24 tickUpper, uint128 liquidity)",
  market:
    "event MarketLaunched(uint256 indexed launchId, uint8 indexed marketIndex, bytes32 poolId, address quote, uint16 bps, int24 tickLower, int24 tickUpper, uint128 liquidity)",
  configured:
    "event LaunchConfigured(uint256 indexed launchId, uint256 bitmask, address quote, int24 tickSpacing, uint24 fee)",
  devBuy:
    "event DevBuyExecuted(uint256 indexed launchId, address indexed buyer, uint256 quoteIn, uint256 tokensOut)",
  classicLaunched:
    "event TokenLaunched(uint256 indexed launchId, address indexed token, address indexed creator, address quote, uint256 graduationQuote)",
  bought:
    "event Bought(uint256 indexed launchId, address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 feeQuote)",
  sold: "event Sold(uint256 indexed launchId, address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 feeQuote)",
  drop: "event HktHolderDrop(uint256 indexed launchId, address indexed token, uint256 quoteIn, uint256 tokensOut)",
  graduated:
    "event Graduated(uint256 indexed launchId, bytes32 indexed poolId, uint256 quoteLp, uint256 tokenLp, uint128 liquidity)",
} as const

export const HOOKIT_TOPICS = {
  masterLaunched: "0x8f24f35f942374b51fbf3f59c02f60582a39d7754248887424b770d0113ce716",
  market: "0x0cefb7835182a7eaf1328fb82c84cdd609a9e43b211617b3ccc966ec8c3f9cad",
  configured: "0x5e86adb37017289972087aafc311d17aa5d949a52576823103f4b391c085801d",
  devBuy: "0x202ca96c2fa7f845b0e19bfcbfc79b38108e9b42136a4e6e8fa2b199013d68d4",
  classicLaunched: "0x97594ef5a8d12cb83cb0eac6982834dbb6247609abd0efbb557b5545ccc03310",
  bought: "0xaf6c8baebc55f540953b129965caf1e3f48010ed731c2cea5ed61e71ebc57153",
  sold: "0x47c2f180f415c943169b11c4bd61c71dbd5f15ed83b496b3a65a47a3a21d63b4",
  drop: "0x7a9c57016d2be5ff13054a17a80ea3b3feb962b8926beeb8a47a9ea8a1017b3e",
  graduated: "0xf9484756d6ba7813b42c469578b978794bd590882fff73780235943811c429a2",
} as const

/** topic0 filter for one eth_getLogs call covering every Hookit event we read. */
export const HOOKIT_LOG_TOPICS: Hex[] = Object.values(HOOKIT_TOPICS)
