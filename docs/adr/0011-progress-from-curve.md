# 0011. Curve progress from the curve formula

Date: 2026-10-08
Status: Accepted

## Context

Alerts need each launch's progress toward bonding on every trade. `getLaunchState` exposes `raised`, `netContributions` and `sold`, but reading it at every trade block is costly. The `Trade` event carries `sold` after the trade.

On the legacy Ink hook, `raised` equals the curve integral of `sold` except after a sell whose curve value exceeds `netContributions`, which leaves `raised` higher for good. On the current native and xStocks hooks, `raised` counts buys gross of fees, while `netContributions` equals the curve integral. Every observed bond fired when `sold` reached `saleSupply`, where the curve integral equals `targetRaise`.

The `Trade` event's `price` is the cost of the next whole token, `curveValue(sold + 1e18) - curveValue(sold)`, not the derivative of the curve at `sold`. The two differ by a per-launch constant of about `T·G·1e36 / (S²·(20000+G))`. Against mainnet fixtures from all three hook families, the forward difference matches `Trade.price` within 1 wei.

## Decision

- Progress is `curveValue(sold) / targetRaise` in basis points, with `curveValue(x) = (2·T·x·S·10000 + T·G·x²) / (S²·(20000 + G))` for target `T`, sale supply `S` and gain `G` in basis points.
- `curvePrice(sold)` is `curveValue(sold + 1e18) - curveValue(sold)` for every hook family.
- `getLaunchState` is read only in a launch's creation block (for the immutable `saleSupply` and `gainBps`) and in its bond block. The bond read logs a warning when `sold != saleSupply`.
- Trade events carry `curveValue`, not the contract's `raised`.

## Consequences

- No state reads on ordinary trades.
- Progress means the same thing on every hook family and reaches 10,000 exactly at bond.
- `curveValue` differs from the contract's `raised` on newer hooks and after capped legacy sells. The events README documents this.
- The same price formula and a 1 wei test tolerance apply to all families.

## Amendment 2026-10-10: soldBps

`TradeEvent` v1 gains `soldBps`: tokens sold over the sale supply in basis points, floored and capped at 10,000, and 0 when the sale supply is 0. It sits beside `progressBpsBefore` and `progressBpsAfter`, which are unchanged.

- Why: on curve tokens the launchpad's own site shows sold over sale supply, so `soldBps` matches the number users see. `progressBpsAfter` measures value raised on the curve, a different quantity.
- Both reach 10,000 at bond, because bonding happens when `sold` reaches `saleSupply`.
- `sold` is already in the `Trade` event and `saleSupply` is a stored launch parameter, so this adds no state reads.
- It is added to v1 before any consumer depends on the schema, so the schema version stays 1 and there is no migration. Events written before this change lack the field and need re-indexing.

