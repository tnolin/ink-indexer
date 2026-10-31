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
 * Progress toward graduation in basis points (0 to 10,000): the net quote raised over the
 * graduation target. A fully sold curve is 10,000 whatever the rounding of the reserves leaves.
 */
export function inkfunProgressBps(c: InkfunCurve, sold: bigint): number {
  if (c.graduationTarget <= 0n) return 0
  if (sold >= c.curveSupply) return 10_000
  const bps = (inkfunCurveValue(c, sold) * 10_000n) / c.graduationTarget
  return bps > 10_000n ? 10_000 : Number(bps)
}
