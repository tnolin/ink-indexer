# 0017. OpenSea source: REST jobs, Stream shards and collection quality checks

Date: 2026-10-17
Status: Accepted. Amends ADR 0006.

## Context

ADR 0006 chose OpenSea API v2 and the Stream API for Ink NFTs. Chain logs say what happened (mints, burns, sales). OpenSea holds what is offered (listings, floors) and what things are (names, images, drop schedules, traits, ranks). Most Ink NFT activity is repeated collections: 184 of 300 SeaDrop contracts minted 1,000 or more tokens within 5 minutes in a 5-day window measured on 2026-10-17, and the same wallets minted many of them. Most listings are re-listings of the same items by a few accounts.

## Decision

**ADR 0006 is amended: chain data comes from Ink RPC logs (ADR 0016), and the Stream feeds listings.**

**Disabled without a key.** With no `OPENSEA_API_KEY` the indexer logs one warning and runs the chain sources only. Without a key no collection resolves a page, so none passes the quality checks.

**REST jobs.** A scheduler runs these jobs. Jobs that call OpenSea draw from the shared request budget (ADR 0019) and defer when it cannot serve them.

| Job | When | Reads |
| --- | --- | --- |
| Discovery | A new NFT contract (first mint, SeaDrop configuration, sale or launch) | The contract's slug, then the collection page. With no slug, retry after 5 minutes, 30 minutes, 2 hours and 6 hours, then daily for 7 days. |
| Metadata | Daily | The collection page |
| Drops | A SeaDrop contract's discovery, a new SeaDrop configuration (debounced 5 minutes), 1 hour before the first stage, and daily while a drop page is missing before the first mint | The drop page: every stage with its type, label, price, times, wallet cap and allowlist size |
| Stage starts | Every 30 seconds | None: reads the stored schedule (ADR 0016) |
| Verdict | When a gate input changes, and on a timer while a collection mints | None: gathers stored facts |
| Traits sample | At checkpoints after a mint ends, and after a burst of 20 metadata updates in 10 minutes | One minted item |
| Stats | By tier | The collection's stats |
| Creator accounts | At discovery, and again once an account is over 7 days old | The owner's account: username and verified flag |

**Stats tiers.**
- Hot, every 20 minutes: collections minting now, and the 30 with the most on-chain sales in 7 days.
- Warm, every 2 hours: the next 70 tracked collections.
- Cold, every 12 hours: any other collection with a slug and a sale or listing in 30 days.
- A listing that passes the filter while its collection's floor is more than 10 minutes old asks for one refresh (at most one per collection per 10 minutes) and waits up to 10 seconds for it (ADR 0028).
- An `nft.stats` event is written when the floor, owners, volume, sales or listed count changes.

**Listed counts.** The number of active listings is counted from the best-listings pages, 100 per page, up to 3 pages. A count that goes past 300 is reported as 300 with `listedCapped` true. Hot collections are counted hourly, warm ones every 6 hours, and a sold-out collection once.

**Stream shards.**
- A Stream connection accepts exactly 50 collection topics. Measured on 2026-10-17: joins 51 and up get an error reply, and a join of 50 plus 1 at once accepts 50 and refuses 1. One key held 10 parallel connections of 50 topics each; the ceiling beyond 10 is unknown.
- The tracked set is capped at 1,000 collections and ordered by: manual marks (a mark that says the collection does not pass removes it from the set), collections that pass the quality checks, collections still being judged that are minting now, then any collection with an on-chain sale in 7 days, most sales first. It is read again every 5 minutes. The source opens up to 20 connections of 50 topics, and a changed set leaves and joins topics on existing shards before opening a new one.
- At startup a probe joins 51 test topics to confirm a connection accepts 50.
- Reconnects wait 1, 2, 5, 10, then 30 seconds. A connection that has been down for 5 minutes is reported once. Listings during a disconnect are not replayed.
- Items whose chain is not Ink are dropped, since slugs spanning chains leak other chains' events.
- URLs are never logged, because the Stream URL carries the key.

**Firehose fallback.** The source switches to one connection joined to every collection, filtered to the tracked set on the client, when any of these happens:
- the tracked set is over capacity (more than the 1,000 topics that 20 connections hold);
- the startup probe shows a connection accepts fewer than 50 topics;
- two distinct new shards are refused in a row (their first connection or all their joins fail) while another shard is connected. Retries of one shard and plain outages do not count, and a shard that connects resets the count.

The firehose stays on until the process restarts. It logs its messages and bytes per minute every 10 minutes. The all-collections feed carried about 300,000 messages a minute across all chains on 2026-10-17, about 1,400 of them from Ink.

**Collection kinds.**
- `drop`: the collection has a mint phase.
- `continuous`: NFTs keep minting and burning with no stages and no max supply. A Chimera collection is `continuous` from its first block. For other contracts the kind switches when, within 7 days of the first mint, a contract without SeaDrop has at least 100 mints, burns at least 20% of its mints, and no readable `maxSupply()`. A contract without SeaDrop whose burns are 5% or more of its mints is held as undecided, which skips the mint checks.
- `legacy`: the mint finished before the indexer's history (ADR 0016).
- A manual mark overrides the kind.

**Quality checks.** A collection passes when it meets four checks, in this order. A collection that fails any check is not marked as passing, so readers can leave it out of feeds, but can still be looked up and followed. The result can change in either direction as checks resolve, and it is written into `nft.collection` as the collection's `verdict`, with the state of each gate.

1. **Page.** The contract resolves to a slug, and the collection has a name, an image, and a Twitter account or a website. Waiting while discovery retries; failing when a slug exists without those fields or no slug appears in 7 days. It passes later if a daily refresh finds the fields or new activity restarts discovery.
2. **Mint structure** (`drop` only). The drop has more than one stage or any signed or allowlist stage, or the mint ran longer than 30 minutes: still minting 30 minutes after the first mint, or sold out more than 30 minutes after it. A single free stage that finishes in minutes fails.
3. **Traits.** A sampled item has traits or an OpenSea rank. It fails only when the sampled item has neither, 72 hours after the mint ended (sell-out, or 24 hours without mints). Until then it is pending, which allows a late reveal.
4. **Not farm-minted** (`drop` only). At most 30% of the distinct minters are farm wallets, meaning wallets that received mints from 5 or more other `drop` collections in the last 7 days. Decided once the collection has 50 distinct minters, and re-checked at each mint milestone.

Order of precedence:
- A manual mark wins.
- A collection OpenSea marks `verified`, or one whose creator's OpenSea account is verified, passes the page check and the mint structure check; a `verified` collection passes outright.
- Otherwise the collection passes when checks 1 and 2 pass and checks 3 and 4 have not failed, waits when check 1 or 2 is undecided, and does not pass when any check has failed.
- For `continuous` and `legacy` collections, checks 2 and 4 do not apply.

All thresholds are named constants in `apps/indexer/src/sources/nft/policy.ts`.

**Listings.** A Stream listing is written as `nft.listing` only when it passes this filter:
1. It is not private.
2. It is priced in ETH or WETH.
3. It lives at least 1 hour (expiry minus listing time).
4. For ERC-1155, the price is per unit.
5. It is lower than the last price written for that item. The per-item state resets on a sale or cancel, and expires with the listing.

The event then carries the collection's latest floor and its age, and the item's name and image.

**Lazy ranks.** Ranks come from OpenSea's rarity data: the rank is OpenSea's `rarity.rank`, stored per fetched item. A rank is fetched for one item at a time, only for a listing priced at or under the floor plus 10%, never for sales or whole collections. It is cached for 7 days, or until the collection's rarity calculation time changes (for example at a reveal). The listing waits up to 10 seconds for the fetch. Where OpenSea returns no rank, the fields are null.

**Creator accounts.** The collection owner OpenSea names (or the creator in a Chimera launch) is looked up once and cached per address for 7 days. The username and verified flag go into `nft.collection` as `creator`. A verified creator counts as in the quality-check rule above.

## Consequences

- The Stream keeps listings current only for tracked collections. A collection that does not pass the quality checks and has no sale in 7 days is not streamed, so a user following it by hand gets mint, sale and floor events but no listings.
- The firehose path costs about 5,000 messages a second to parse if it triggers.
- Everything OpenSea-derived depends on one key's request budget (ADR 0019); when it runs low, background work waits first.
