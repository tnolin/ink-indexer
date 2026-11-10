# 0040. Bounded log filter lists

Date: 2026-11-10
Status: Accepted

Supersedes the part of [ADR 0033](0033-uniswap-v4-swaps-and-pool-registry.md) that sends every tracked pool id and token in one request.

## Context

The `v4-swaps` source reads swaps with a PoolManager filter on `[Swap, poolIds]` and burns with a `Transfer` filter on the token addresses. ADR 0033 sent each list whole and noted that it grows with the number of bonded tokens. It grows faster than that: every launch registers its pools at once, with no bonding step, and the registry never drops a pool. Providers cap the number of topics, addresses and bytes in one `eth_getLogs` request, and a refused request fails at every block range. The log router answered every failure by halving the range and asking again from the same block, so a list over a provider's cap never returned.

## Decision

**The router splits long lists.** `LogRouter.getLogs` sends a filter whose address or topic list has more than 50 entries as several requests over the same blocks, one per chunk, and merges the logs in block and log order. If the chunks are served to different heights, the span is the lowest. Callers see one request and one result, so every source and the backfill benefit.

**A size refusal shrinks the chunks.** A failure whose message names the number of topics or addresses, or the size of the request, halves the router's list limit and splits the filter again, instead of halving the block range; the limit grows back toward 50 after a run of successful requests. A failure at the smallest block range with no recognisable message, on a list longer than one entry, also halves the limit, and that limit stays down until restart. Rate-limit answers never shorten the lists. Repeated entries are sent once.

**The v4 filters stay whole in the source.** `v4Source.filters` still returns one filter for swaps and one for burns; the router decides how to send them.

## Consequences

- A span makes one request per 50 pool ids or tokens instead of one request. With a few hundred pools that is a handful of requests per span.
- A provider with a smaller cap costs more requests, never a stall.
- The list limit is per router, not per transport, so a transport with a smaller cap lowers it for all of them until it grows back.
