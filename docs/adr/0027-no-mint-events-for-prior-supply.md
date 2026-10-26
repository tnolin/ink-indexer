# 0027. No stage start or progress events for a contract that minted before its history

Date: 2026-10-26
Status: Accepted

Amends ADR 0016.

## Context

When a contract that minted out before the indexer's NFT history mints again, its first stored mint is not its first mint. The indexer took that mint for the start of a stage and wrote a `stage_start` event, then every `progress` mark the supply had already passed, all at once. Those events describe a mint that started long ago, and a reader had to recognise and drop them.

## Decision

- A contract has prior mints when `nft_collections.prior_minted` is true or `nft_collections.prior_supply` is above zero. Both come from the contract's `totalSupply()` the block before its first stored mint (ADR 0016).
- For such a contract the SeaDrop milestones write no `stage_start` and no `progress` events. Its stages and marks are not recorded either, so they are announced if a backfill later shows that nothing was minted before the first mint. `sold_out` events, mints, sales and `nft.collection` snapshots are unchanged.
- The prior supply is not stored when a contract's first mint arrives, so the milestone step reads `totalSupply()` at the block before the first mint of the batch when the collection has no decision yet. A contract that does not answer is treated as new. A decision stored for an earlier first mint is not trusted when a backfill brings an earlier one: the supply is read again.
- A contract with a manual kind mark skips the question, as it does when the verdict job decides the kind.
- The scheduled stage starts (ADR 0017) follow the same rule for a collection whose stored decision says it had prior mints.

## Consequences

- A contract that mints again after a long gap produces no mint milestone events except `sold_out`.
- A contract with prior mints costs one `totalSupply()` read per batch that holds its SeaDrop mints, until the verdict job stores its decision.
- A contract that does not answer `totalSupply()` keeps writing the events as before.
