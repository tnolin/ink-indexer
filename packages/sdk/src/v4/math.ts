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

const Q96_BITS = 96n

// Uniswap's TickMath: sqrt(1.0001^tick) in Q64.96, from one multiplication per set bit of |tick|.
const TICK_FACTORS: readonly (readonly [bigint, bigint])[] = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
]

/** `sqrt(1.0001^tick)` as a Q64.96 price, as the PoolManager computes it. */
export function sqrtRatioAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick))
  let ratio = (abs & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n
  for (const [mask, factor] of TICK_FACTORS)
    if ((abs & mask) !== 0n) ratio = (ratio * factor) >> 128n
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio
  return (ratio >> 32n) + ((ratio & 0xffffffffn) === 0n ? 0n : 1n)
}

/**
 * The amounts of currency0 and currency1 that `liquidity` holds in the tick range `[tickLower,
 * tickUpper]` at the current price. The price is clamped to the range, so a price at or beyond an
 * edge leaves one side at zero and neither amount is ever negative. A null tick leaves that side
 * of the range open, so two nulls give the full-range amounts `quoteReserve` returns.
 */
export function reservesInRange(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  tickLower: number | null,
  tickUpper: number | null,
): { amount0: bigint; amount1: bigint } {
  if (sqrtPriceX96 <= 0n) return { amount0: 0n, amount1: 0n }
  const lower = tickLower === null ? null : sqrtRatioAtTick(tickLower)
  const upper = tickUpper === null ? null : sqrtRatioAtTick(tickUpper)
  let p = sqrtPriceX96
  if (lower !== null && p < lower) p = lower
  if (upper !== null && p > upper) p = upper
  // currency0 sits above the price: L (1/sqrtP - 1/sqrtUpper); with no upper edge, L / sqrtP.
  const amount0 =
    upper === null ? (liquidity << Q96_BITS) / p : (liquidity * (upper - p) * Q96) / (upper * p)
  // currency1 sits below the price: L (sqrtP - sqrtLower); with no lower edge, L * sqrtP.
  const amount1 = (liquidity * (lower === null ? p : p - lower)) / Q96
  return { amount0, amount1 }
}
