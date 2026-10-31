const WHOLE_TOKEN = 10n ** 18n

/**
 * Immutable curve inputs, read from the curve contract. The curve is constant product over virtual
 * reserves: it prices `sold` tokens as if the pool held `virtualQuote` quote and `virtualTokens` tokens.
 */
export type InkfunCurve = {
  virtualQuote: bigint
  virtualTokens: bigint
  curveSupply: bigint
  graduationTarget: bigint
}

/** Net quote the curve holds after `sold` tokens: `virtualQuote × virtualTokens / (virtualTokens − sold) − virtualQuote`. */
export function inkfunCurveValue(c: InkfunCurve, sold: bigint): bigint {
  if (sold <= 0n || sold >= c.virtualTokens) return 0n
  return (c.virtualQuote * c.virtualTokens) / (c.virtualTokens - sold) - c.virtualQuote
}

/** Price of the next whole token at `sold`, in quote base units per whole token. */
export function inkfunPrice(c: InkfunCurve, sold: bigint): bigint {
  const left = c.virtualTokens - sold
  if (left <= 0n) return 0n
  return (c.virtualQuote * c.virtualTokens * WHOLE_TOKEN) / (left * left)
}

/**
 * The `tokensSold` at which the net quote raised reaches the graduation target, where the curve
 * closes. The contract rounds token amounts down, so this is usually one base unit under `curveSupply`.
 */
export function inkfunClosingSold(c: InkfunCurve): bigint {
  const denominator = c.virtualQuote + c.graduationTarget
  const product = c.virtualQuote * c.virtualTokens
  return c.virtualTokens - (product + denominator - 1n) / denominator
}

/**
 * Progress toward graduation in basis points (0 to 10,000): the net quote raised over the
 * graduation target. A curve that has sold up to its closing point is 10,000 whatever the
 * rounding of the reserves leaves.
 */
export function inkfunProgressBps(c: InkfunCurve, sold: bigint): number {
  if (c.graduationTarget <= 0n) return 0
  if (sold >= c.curveSupply || sold >= inkfunClosingSold(c)) return 10_000
  const bps = (inkfunCurveValue(c, sold) * 10_000n) / c.graduationTarget
  return bps > 10_000n ? 10_000 : Number(bps)
}
