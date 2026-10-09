# 0010. getLogs routing by learned range

Date: 2026-10-08
Status: Accepted

## Context

ADR 0003 orders the RPC providers dRPC, then Ink's public QuickNode and Gelato endpoints. Their `eth_getLogs` block-range caps differ widely. Measured on 2026-10-08: dRPC's free plan about 100 blocks, QuickNode 10,000, Gelato 1,000. dRPC's error messages misreport its limit and include transient internal errors.

## Decision

- Every `eth_getLogs` goes to the healthy transport with the largest current range. Ties go to ADR 0003's order. All other calls keep that order.
- Each transport's range starts at its measured cap (by hostname, 1,000 for unknown hosts), and that cap is also its ceiling.
- Any `getLogs` error halves that transport's range, without parsing the message. After 20 consecutive successes the range doubles, up to the ceiling.
- Each span's end is clamped to the chosen transport's own `eth_blockNumber`, cached for one second per transport. A node that is behind the chain head can return a successful but incomplete result for blocks above its own head, so the router returns the clamped `toBlock` and the cursor never moves past blocks that transport had not seen. A transport whose head is below the start block is skipped. If every transport is benched or behind, the call backs off from 1 to 30 seconds and retries the same span.
- A transport that fails at range 1, or 5 times in a row, is benched for 60 seconds.
- A WebSocket-level failure benches the transport at once instead of halving its range; see ADR 0013.

## Consequences

- Backfill runs at the widest range any provider allows, and live indexing keeps dRPC first for everything else.
- A provider upgrade means updating its seed.
- The cursor only advances over spans that were fetched successfully.
