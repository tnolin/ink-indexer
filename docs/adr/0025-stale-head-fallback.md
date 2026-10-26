# 0025. A tick with no new blocks checks every endpoint's head

Date: 2026-10-26
Status: Accepted

## Context

The live tick takes its head from one `eth_blockNumber` call through viem's fallback transport, which ranks endpoints by the latency of that same call (ADR 0014). An endpoint can keep answering `eth_blockNumber` with an old block while its other methods serve the chain. It answers fast, so it is ranked first, and every tick then reads a head below the cursor, finds nothing to read and counts as a success. Ingestion stops and nothing is logged.

## Decision

When the head a tick gets is not above the cursor, the tick reads `eth_blockNumber` from every configured endpoint and uses the highest answer as its head.

- The reads are `LogRouter`'s per-endpoint head reads, so they share its one-second cache (ADR 0010). A cached head below the first block to read is read again.
- An endpoint that is benched, or that fails to answer, is left out. If none answers, the tick keeps the head it had.
- A head above the cursor is used as it is, with no further calls.
- When the highest answer is above the head the tick first got, the indexer logs one warning, `stale head from <host>`, naming the endpoint with the lowest head and giving `staleHead` and `highestHead`. It does not log again until the head source has recovered.
- The first tick afterwards whose head needs no replacing (it is above the cursor, or no endpoint is higher) logs one info line, `head source recovered`.

## Consequences

- A stale endpoint that is ranked first no longer holds ingestion back. The cursor follows the highest head any endpoint reports, and `eth_getLogs` is still clamped to the head of the endpoint that serves it (ADR 0010).
- The cost is extra `eth_blockNumber` calls, one per configured endpoint, only on ticks that see no new blocks, such as one started by the stall timer or by a second trigger for a block already read. A tick that finds new blocks makes none.
- The warning is raised even when the indexer is caught up, so a frozen endpoint is reported before it causes a stall.
