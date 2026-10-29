# 0021. Merged log requests and a call summary

Date: 2026-10-23
Status: Accepted. Request counts amended by ADR 0033.

## Context

Each source declares its log filters (`Source.filters`), and the loop made one `eth_getLogs` request per filter: eight per tick with every group on (one InkyPump filter and seven NFT filters). At about 1,440 ticks an hour that is about 11,500 requests an hour, enough to use up a public endpoint's daily request limit (HTTP 429, JSON-RPC code -32003). The logs said nothing about how many requests went to which endpoint, or how many were refused.

## Decision

**Merged requests.** `apps/indexer/src/log-plan.ts` turns the enabled logical filters into the fewest requests, and splits each response back by matching every log against each member filter's address and topics. A source still gets one log array per declared filter, in block then log-index order, and a log that two filters match goes to both. `Source.filters(only)` is unchanged, including null for a filter that is off. Two merges are used:

- Filters with the same address and the same topics after position 0 share one request with their topic0 values ORed. The response is exactly the union of the filters' logs.
- Address-bound filters that restrict at most topic0 share one request with an address list. Topic0 is restricted to the union of their topic0 values when every member has one, and left open when a member reads every event of its contract (the SeaDrop filter does).

Topic positions beyond 0 cannot be ORed across positions, so mints (`from` in topic1) and burns (`to` in topic2) stay apart. A filter with no address cannot join an address list. With every group on, the eight filters become five requests: InkyPump's topic0 list, mints (`[Transfer, 0x0]`), ERC-721 burns with ERC-1155 mints (`[[Transfer, TransferSingle, TransferBatch], null, 0x0]`), ERC-1155 burns (`[[TransferSingle, TransferBatch], null, null, 0x0]`), and one address list for SeaDrop, both Seaport versions and the Chimera factory.

The only merge that fetches extra logs is the address list. With SeaDrop in it, the Seaport and factory addresses return every event they emit, and the split drops all but `OrderFulfilled` and `CampaignCreated`. Without SeaDrop the topic0 restriction applies and the extra is the cross product of those addresses and topics, which is empty in practice. The comment above `FILTERS` in `apps/indexer/src/sources/nft/index.ts` records this per request.

A replay test (`apps/indexer/test/merged-requests.test.ts`) runs the per-filter path (`Indexer`'s `mergeRequests: false`) and the merged path over the recorded InkyPump range and the recorded NFT logs, for all 16 subsets of the four groups. It asserts identical log arrays per source, identical events and rows, and the request count per subset.

**Call summary.** Every request through an endpoint's transport is counted by method (`eth_getLogs`, `eth_blockNumber`, `eth_getBlockByNumber`, other) under the endpoint's hostname. A failure is counted as rate limited when it has HTTP status 429, JSON-RPC code -32005 or -32003, or a message matching `/429|rate.?limit|request limit|too many requests/i`, on the error or any cause. Every 10 minutes the indexer logs one `rpc calls` line with `windowS` and, per endpoint, `getLogs`, `blockNumber`, `getBlock`, `other` and `rateLimited`, then starts the next window from zero.

## Consequences

- Requests per tick fall from 8 to 5 with every group on, from 5 to 4 for `nft-mints` alone, and from 2 to 1 for `nft-sales` with `nft-launches`. A single group that already has one filter stays at 1.
- A merged response is larger than any single filter's, and an endpoint's response-size cap applies to it. The range halving in ADR 0010 handles that as it does any failed request.
- A new filter joins an existing request when it fits one of the two merges, and gets its own otherwise; sources need no change.
- Tick frequency is unchanged.

## Amendment 2026-10-29: the v4-swaps group

The `v4-swaps` group (ADR 0033) adds two requests, a PoolManager swap filter and a `Transfer` filter on the dead address, once a pool is registered. With every group on a tick makes 7 requests, up from 5. `inkypump` alone makes 3, up from 1, and `inkypump` with `nft-launches` makes 4. `nft-sales` and `nft-launches` alone are unchanged. The two new filters match no other filter's topic positions, so they never merge. Without a registered pool the group makes no request. A span containing a bond makes one more request for that pool's swaps.
