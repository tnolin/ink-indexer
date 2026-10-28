import type { V4Swap } from "./decode"

const Q96 = 1n << 96n
const Q192 = Q96 * Q96
const ONE = 10n ** 18n

// v4 orders a pool's currencies by address, and sqrtPriceX96² / 2^192 is currency1 per currency0.
// Every function here returns 0 for an uninitialized pool (sqrtPriceX96 of 0).

/** Pool price in quote base units per 1e18 token base units. */
export function poolPrice(sqrtPriceX96: bigint, tokenIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 <= 0n) return 0n
  const p2 = sqrtPriceX96 * sqrtPriceX96
  return tokenIsCurrency0 ? (ONE * p2) / Q192 : (ONE * Q192) / p2
}

/** `supply` tokens valued at the pool price, in quote base units. */
export function poolMarketCap(
  sqrtPriceX96: bigint,
  tokenIsCurrency0: boolean,
  supply: bigint,
): bigint {
  if (sqrtPriceX96 <= 0n) return 0n
  const p2 = sqrtPriceX96 * sqrtPriceX96
  return tokenIsCurrency0 ? (supply * p2) / Q192 : (supply * Q192) / p2
}

/**
 * The quote side of the pool's in-range liquidity at the current price: `L·2⁹⁶/√P` when the quote
 * is currency0, `L·√P/2⁹⁶` when it is currency1. For a full-range position this is the quote the
 * pool holds for it.
 */
export function quoteReserve(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tokenIsCurrency0: boolean,
): bigint {
  if (sqrtPriceX96 <= 0n) return 0n
  return tokenIsCurrency0 ? (liquidity * sqrtPriceX96) / Q96 : (liquidity * Q96) / sqrtPriceX96
}

const abs = (x: bigint) => (x < 0n ? -x : x)

/** Side and absolute amounts of a swap. The swapper buys when it receives the token. */
export function swapLegs(
  s: V4Swap,
  tokenIsCurrency0: boolean,
): { side: "buy" | "sell"; tokenAmount: bigint; quoteAmount: bigint } {
  const [token, quote] = tokenIsCurrency0 ? [s.amount0, s.amount1] : [s.amount1, s.amount0]
  return { side: token > 0n ? "buy" : "sell", tokenAmount: abs(token), quoteAmount: abs(quote) }
}
