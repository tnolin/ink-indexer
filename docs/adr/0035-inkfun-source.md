# 0035. ink.fun source

Date: 2026-10-31
Status: Accepted

## Context

ink.fun launches tokens on a bonding curve of their own (one contract per launch) and graduates them into a Uniswap v4 pool. The indexer needs its launches, trades and graduations as the same `launchpad.*` events InkyPump produces, with the token's image, description and links, which ink.fun keeps in IPFS metadata rather than in events.

## Decision

- **One filter.** The source reads a single topic-only filter for `LaunchCreated`, `Bought`, `Sold` and `Migrated`. It has the same shape as InkyPump's, so the log planner merges the two into one `eth_getLogs` request and a tick makes no extra request.
- **Trust by emitter.** Every launch has its own curve, an EIP-1167 clone of one implementation. `LaunchCreated` is accepted only from the factory, `Bought` and `Sold` only from a curve the source has seen created, and `Migrated` only from the migration module and for a known token. Anything else is dropped with one warning per emitter address.
- **Curve math from `tokensSold`.** Price, curve value and progress come from the curve's virtual reserves and the `tokensSold` that every trade reports. Progress is the net quote raised over the graduation target, which is what ink.fun's site shows. The contract rounds token amounts down and closes at the target, so a full curve ends one base unit under `curveSupply`; progress is 10,000 from the closing `tokensSold`.
- **Metadata inside the span.** At launch the source reads the curve's parameters, the token's `metadataURI()` and `totalSupply()` in one multicall, then fetches the IPFS JSON through the gateway in `IPFS_GATEWAY` before it builds the `launchpad.launch` event. Readers take image, description and links only from that event, so a later fetch would need a new event type to reach them. Each fetch has a bounded budget (three attempts of three seconds, in parallel across the span's launches) and only `ipfs://` URIs are fetched. A launch whose metadata is not fetched is written without image, description and links.
- **Bond at `Migrated`.** The bond is written when `Migrated` appears, in whichever transaction that is. Graduation burns tokens, so the supply is read at the migration block, stored on the token and given to the pool registry. The v4 source then indexes the pool's swaps with that supply, and it survives a restart because the registry loads it from `tokens.total_supply`. Rolling back past a migration reads the supply at the fork.
- **Rollback.** Curve state of tokens whose state changed above the fork is restored from `tokensSold()` at the fork. InkyPump's rollback handles token, trade, pool, bond and ath rows for every launchpad, and is scoped to its own tokens when it reads launch state.

## Consequences

- Enabling `inkfun` also enables `v4-swaps`, so its pools are indexed without `inkypump`.
- A launch that enters recovery reopens sells at a pro-rata price. Those sells are still emitted as curve trades priced from `tokensSold`. `RecoveryOpened` is not read yet.
- Holders can burn ink.fun tokens to the zero address. Only transfers to the dead address lower the supply used for market cap, so such burns are not counted yet.
- The first graduation on Ink has not happened at the time of writing; the `Migrated` decoding follows the verified contract source and is tested with a synthetic log.
