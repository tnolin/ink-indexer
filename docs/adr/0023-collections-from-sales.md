# 0023. Collection rows from sales

Date: 2026-10-24
Status: Accepted

## Context

ADR 0017 lists a sale as one of the events that make a new NFT contract due for discovery. The chain source created `nft_collections` rows only from mints, burns, SeaDrop logs and Chimera launches, so a contract that only trades on Ink (its mint was before the history window, or on another path) never got a row. With no row it got no slug, name or OpenSea data, no stats, and no place in the Stream's tracked set, although its sales were stored and emitted. In production on 2026-10-24, 437 contracts with 28,787 stored sales had no row.

## Decision

- A sale touches its contract like a mint does: the batch's collection upsert includes it, with no standard, no first mint and no SeaDrop flag. A new row is due for discovery by the `next_discovery_at` column default, and an existing row is unchanged by the upsert.
- `collections-from-sales` (`pnpm nft:collections-from-sales`) is a one-time pass for the contracts whose sales came before this change. It inserts a row for each contract in `nft_sales` with none, logs how many, and exits. It writes no events, so it can run beside `start`.

No migration: the columns and defaults already exist.

## Consequences

- Discovery, the metadata refresh, stats and the Stream's tracked set now see collections that only trade. The verdict job judges them like any collection with no mint in the history window, as it already does for rows created by a SeaDrop log alone.
- The one-time pass makes a burst of discovery lookups (two OpenSea requests each when the contract has a collection). The shared budget (ADR 0019) paces them.
- A slug equal to the contract address is OpenSea's own slug for that collection, read from both the contract and the collection endpoints and kept by every refresh, so it is stored as it is.
