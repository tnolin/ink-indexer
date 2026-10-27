# 0031. A getLogs refused at the tip is not a range error

Date: 2026-10-28
Status: Accepted

## Context

The router halves a transport's range on any `eth_getLogs` error (ADR 0010) and logs a warning. Since new heads are read from several endpoints, Gelato often refuses a request at the chain tip with InvalidParams, "block range extends beyond current head block", although the span ends at or below the head that same endpoint reported. Its `eth_blockNumber` and `eth_getLogs` can be answered by nodes a block or two apart. The refusal says nothing about the range, yet it dropped Gelato's range from 1000 to 125 and logged about three warnings a minute.

## Decision

A failed `eth_getLogs` is treated as "not there yet" when both hold:

- the error is not a transport failure (`isTransportError`: a dead connection, a timeout, an HTTP error status or a rate limit), and
- the span's first block is less than 5 blocks below the transport's own reported head, so the whole span lies at its tip.

Such a failure changes no state: the range is not halved, the failure counters and benching are untouched, and it is logged at debug. The router tries the next transport for the same span. If none serves it, the router waits (the existing 1 s to 30 s backoff) and asks again from the same block. It never returns a span it did not read, so the cursor cannot pass those blocks.

Every other error behaves as before: halve, warn, bench.

The case is recognised by position, not by the error text. The router already avoids parsing messages because dRPC's are unreliable, and Gelato's wording is not a contract. Position is what the failure has in common whatever an endpoint says. The test uses the span's first block rather than its end so that a large span that ends at the head and is refused for its size is still halved. Excluding transport failures keeps rate limits and timeouts at the tip on the bench path.

## Consequences

- A refusal at the tip no longer shrinks the range or logs a warning.
- A transport that refuses the tip on every call is tried first each time and costs one extra request, then another transport serves the span; ingestion does not stall.
- A real range error on a span of fewer than 5 blocks is no longer halved, but a span that short cannot be halved usefully and other transports still serve it. Spans that start further below the head are unaffected.
