import type { ClassicLaunch } from "./state"

const WHOLE_TOKEN = 10n ** 18n

/**
 * A Classic curve is constant product over virtual reserves that start at `vQ0` quote and `vT0`
 * tokens. Selling `sold` tokens moves them to `vT = vT0 - sold` and `vQ = vQ0 * vT0 / vT`. The
 * contract rounds each trade's reserves, so the quote side computed here can differ from a read
 * by a few wei; the token side is exact.
 */
export type ClassicCurve = {
  vQ0: bigint
  vT0: bigint
  curveSupply: bigint
  graduationQuote: bigint
}

/**
 * The starting reserves of the curve a `launches(id)` read describes, whatever has been sold at the
 * block it was read: the virtual reserves differ from their starting values by exactly that.
 */
export function classicCurveOf(l: ClassicLaunch): ClassicCurve {
  return {
    vQ0: l.virtualQuote - l.realQuote,
    vT0: l.virtualToken + l.tokensSold,
    curveSupply: l.curveSupply,
    graduationQuote: l.graduationQuote,
  }
}

/** The virtual reserves and the quote raised after `sold` tokens are sold (bought minus sold back). */
export function classicState(
  c: ClassicCurve,
  sold: bigint,
): { vQ: bigint; vT: bigint; realQuote: bigint } {
  const vT = c.vT0 - sold
  if (vT <= 0n) return { vQ: 0n, vT: 0n, realQuote: 0n }
  const vQ = (c.vQ0 * c.vT0) / vT
  return { vQ, vT, realQuote: vQ - c.vQ0 }
}

/** Price of a whole token in quote base units. */
export function classicPrice(c: ClassicCurve, sold: bigint): bigint {
  const { vQ, vT } = classicState(c, sold)
  return vT <= 0n ? 0n : (vQ * WHOLE_TOKEN) / vT
}

/** `supply` base units valued at the curve price, in quote base units. */
export function classicMarketCap(c: ClassicCurve, sold: bigint, supply: bigint): bigint {
  const { vQ, vT } = classicState(c, sold)
  return vT <= 0n ? 0n : (vQ * supply) / vT
}

/**
 * Progress toward graduation in basis points (0 to 10,000): the quote raised over the graduation
 * quote, the figure Hookit's site shows. The trade that sells the last curve token graduates the
 * launch and reports 10,000, since the reserves' rounding can leave the raise a wei short.
 */
export function classicProgressBps(c: ClassicCurve, sold: bigint): number {
  if (c.graduationQuote <= 0n) return 0
  if (sold >= c.curveSupply) return 10_000
  const bps = (classicState(c, sold).realQuote * 10_000n) / c.graduationQuote
  return bps > 10_000n ? 10_000 : Number(bps)
}
