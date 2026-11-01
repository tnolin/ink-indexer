import type { TsunamiCurveState } from "./decode"

const WHOLE_TOKEN = 10n ** 18n

/** Price of a whole token in quote base units: the curve's virtual quote over its virtual base. */
export function tsunamiPrice(s: TsunamiCurveState): bigint {
  return s.virtualBase <= 0n ? 0n : (s.virtualQuote * WHOLE_TOKEN) / s.virtualBase
}

/** `supply` base units valued at the curve price, in quote base units. */
export function tsunamiMarketCap(s: TsunamiCurveState, supply: bigint): bigint {
  return s.virtualBase <= 0n ? 0n : (s.virtualQuote * supply) / s.virtualBase
}

/**
 * Progress toward graduation in basis points (0 to 10,000): the net quote raised over the raise
 * target, the figure Tsunami's site shows. The closing trade leaves no base tokens to sell and
 * is 10,000 whether the raised quote lands a few wei over or under the target.
 */
export function tsunamiProgressBps(s: TsunamiCurveState, targetRaise: bigint): number {
  if (targetRaise <= 0n) return 0
  if (s.realBase === 0n) return 10_000
  const bps = (s.realQuote * 10_000n) / targetRaise
  return bps > 10_000n ? 10_000 : Number(bps)
}
