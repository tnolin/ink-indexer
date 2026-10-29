# 0034. Events schema version 2

Date: 2026-10-29
Status: Accepted

## Context

Uniswap v4 swaps (ADR 0033) need a new event type, and launchpads other than InkyPump need to be named in the existing ones. Existing readers must keep working, and rows already written cannot be rewritten without moving ids that readers have saved.

## Decision

`SCHEMA_VERSION` is `2`. Version 2 adds:

- `launchpad.swap`, a swap in a tracked Uniswap v4 pool, with the trader, side, amounts, price, market cap, `athMarketCap`, `quoteLiquidity` and `supply`.
- `athMarketCap` on `launchpad.trade`.
- `poolManager` on `launchpad.bond`.
- On `launchpad.launch`: `startsInPool`, `poolId`, `poolManager`, `customHook` and `hookModules`; `targetRaise` is `null` for a token with no bonding curve.
- `launchpad` accepts `inkypump`, `inkfun`, `tsunami`, `hookit` and `chimera`.

Rows written before the change keep `v: 1` and their shape. The package exports `LaunchEventV1`, `TradeEventV1` and `BondEventV1` for them, and a reader that handles both branches on `v`. NFT events keep their shape; their `v` is `1` or `2`, which type-checks as `1 | 2`.

The git tag is `events-v3`, because `events-v2` was the additive NFT release and tags are not reused.

## Consequences

- A reader written for version 1 ignores `launchpad.swap`, because it ignores types it does not know, and still reads `v: 2` launch, trade and bond rows as long as it reads the fields it already used. It does not see the new fields.
- A reader that checks `v === 1` rejects new rows and must be updated.
