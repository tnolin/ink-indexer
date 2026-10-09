/** Immutable per-launch curve inputs: targetRaise from LaunchCreated, the rest from getLaunchState. */
export type CurveParams = { targetRaise: bigint; saleSupply: bigint; gainBps: number }

const WHOLE_TOKEN = 10n ** 18n

/**
 * Quote value of the linear curve after `sold` tokens: ∫ price from 0 to sold.
 * End price is (1 + gainBps/10000) × start price; curveValue(saleSupply) = targetRaise.
 * Equals the contract's `raised` on legacy hooks and `netContributions` on newer hooks.
 */
export function curveValue(p: CurveParams, sold: bigint): bigint {
  const g = BigInt(p.gainBps)
  return (
    (2n * p.targetRaise * sold * p.saleSupply * 10_000n + p.targetRaise * g * sold * sold) /
    (p.saleSupply * p.saleSupply * (20_000n + g))
  )
}

/** Marginal curve price at `sold`, in quote base units per whole token. */
export function curvePrice(p: CurveParams, sold: bigint): bigint {
  const g = BigInt(p.gainBps)
  return (
    (2n * p.targetRaise * (p.saleSupply * 10_000n + g * sold) * WHOLE_TOKEN) /
    (p.saleSupply * p.saleSupply * (20_000n + g))
  )
}

/** Progress toward bond in basis points (0 to 10,000). */
export function progressBps(value: bigint, target: bigint): number {
  if (value <= 0n) return 0
  const bps = (value * 10_000n) / target
  return bps > 10_000n ? 10_000 : Number(bps)
}

/** Market cap in quote base units from a per-whole-token price. */
export function marketCap(price: bigint, totalSupply: bigint): bigint {
  return (price * totalSupply) / WHOLE_TOKEN
}
