import type { Address, Hex } from "viem"

/** Uniswap v4 PoolManager on Ink. */
export const UNISWAP_V4_POOL_MANAGER: Address = "0x360e68faccca8ca495c1b759fd9eee466db9fb32"

/** Tokens sent here are out of circulation. */
export const DEAD_ADDRESS: Address = "0x000000000000000000000000000000000000dead"

/** `Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)` */
export const SWAP_TOPIC: Hex = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"

/** ERC-20 `Transfer(address,address,uint256)`. */
export const TRANSFER_TOPIC: Hex =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
