import type { Address, Hex } from "viem"
import { XSTOCKS_HOOK_CREATED_TOPIC } from "./abi"

export const INK_CHAIN_ID = 57073

/** Block of the first InkyPump V2 hook on Ink. */
export const INKYPUMP_START_BLOCK = 45_252_770n

/** Native launches are quoted in ETH, which V4 pools address as the zero currency. */
export const NATIVE_QUOTE_ASSET: Address = "0x0000000000000000000000000000000000000000"

export type AbiFamily = "ink-legacy" | "robinhood-corrected" | "xstocks"

/** Native hooks have no on-chain registry; add new ones here (see AGENTS.md). */
export const NATIVE_HOOKS: { address: Address; abiFamily: AbiFamily; startBlock: bigint }[] = [
  {
    address: "0x4cc8f6d5b7ce150ccc0a9b7664532b1283b96ac4",
    abiFamily: "ink-legacy",
    startBlock: 45_252_770n,
  },
  {
    address: "0x893183da2411c7df81f103bfef09e4e46c326ac4",
    abiFamily: "robinhood-corrected",
    startBlock: 56_073_670n,
  },
]

/** xStocks hooks are discovered from these factories' hook-created events. */
export const XSTOCKS_FACTORIES: { address: Address; startBlock: bigint }[] = [
  { address: "0x81c95e12d40c0eacb61609b0bb0d8100d92a5fc4", startBlock: 54_113_937n },
  { address: "0x92f303ae539052ebb7d551bb2ec1a6f1affbaf85", startBlock: 55_932_590n },
]

export const TOPICS = {
  launchCreated: "0x9d3b921bcb0eb03c555acd3968d3b3424efbad89ba35d7ad446cf59deb21d5f7",
  launchMetadata: "0xb8d0bebe0e358eae23ed5f98164441fbcebf8633fe5443703bde57afd23f69cd",
  trade: "0xe2d4c4d950c33268021bcd67d1421807db799277a75376d17d5e2787849180a4",
  launchFinalized: "0x40e86f43c64a7ad3634ed32d4aa688b0843106625abeaf8251b09088380e9736",
  xstocksHookCreated: XSTOCKS_HOOK_CREATED_TOPIC,
} as const

/** topic0 filter for one eth_getLogs call covering every InkyPump V2 event we index. */
export const LOG_TOPICS: Hex[] = Object.values(TOPICS)
