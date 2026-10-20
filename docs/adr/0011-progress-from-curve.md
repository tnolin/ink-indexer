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


## Amendment 2026-10-20: progress check against inkypump.com

InkyPump's team said V2 progress is ETH raised, not tokens sold over sale supply. A check against the site on 2026-10-20 found that its token pages show `soldBps`, so the 2026-10-10 decision stands: consumers show `soldBps` as curve progress.

- The site treats a token as V2 when it has a launch id, meaning a launch on one of the hooks this indexer reads. Its V1 tokens come from the earlier token factory, which this indexer does not read.
- On a V2 token page, the header's Funding figure is `min(sold, saleSupply) / saleSupply` from a live `getLaunchState` read. The site's code uses this formula for every V2 launch, whatever the hook. It shows the API's `funding_progress` only until that read returns.
- The home page's token cards show the API's `funding_progress`. It matches none of the quantities below, and its formula is not public.

Five unbonded V2 launches, all on the legacy Ink hook. Contract state is from block 58,930,887; `progressBpsAfter` is from each launch's last trade, which left the state as read.

| Token | Page | `soldBps` | `progressBpsAfter` | `raised` / target | `netContributions` / target | API `funding_progress` |
| - | - | - | - | - | - | - |
| SQUIJAK `0xc899…8bf7` | 58.6% | 5863 | 4131 | 4075 | 3719 | 25.1% |
| INKPOT `0xc1ad…0343` | 13.8% | 1375 | 468 | 397 | 252 | 5.4% |
| INKCAT `0x322d…bfff` | not loaded | 1708 | 696 | 696 | 604 | 7.4% |
| X402 `0xeddc…3f56` | not loaded | 1300 | 492 | 469 | 419 | 5.1% |
| INKERS `0x469a…f40d` | not loaded | 537 | 537 | 500 | 421 | 5.7% |

Basis-point columns are floored. The pages that did not load would show the same formula, per the site's code.
