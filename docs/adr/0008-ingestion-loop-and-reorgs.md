# 0008. Ingestion loop: new heads trigger range catch-up

Date: 2026-10-08
Status: Accepted

## Context

ADR 0002 chose a custom viem ingester with WebSocket subscriptions, backfill from the last processed block and confirmation tracking. Log subscriptions can drop logs around reconnects, and a separate backfill path needs a handoff between the two.

## Decision

- A `newHeads` subscription only triggers a tick. Each tick reads logs with `eth_getLogs` from the saved cursor to the head, so backfill, live indexing and reconnects share one path. A watchdog ticks after 30 seconds without a head. Ticks never overlap.
- Each span is written in one transaction together with the cursor and the span-end block hash. Inserts are idempotent.
- Events are written with `confirmed = false` and marked confirmed once at or below head − 1.
- Every tick compares the cursor's block hash with the chain. On a mismatch it walks the last 128 stored block hashes down to the highest one that still matches (the fork block). It then deletes rows above the fork block, re-reads curve state at the fork block and re-ingests. If no stored hash matches, it stops.

## Consequences

- A dropped socket costs nothing beyond the next tick.
- Reorg handling is a few queries, tested against a fake chain.
- A reorg deeper than the stored hashes stops the indexer for an operator to look at.
