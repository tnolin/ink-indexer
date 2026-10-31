# Architecture

ink-indexer is an open TypeScript SDK for reading Ink launchpads and NFTs, plus the indexer that stores their events in Postgres. The SDK runs anywhere with an Ink RPC. The indexer powers [MAKO](https://github.com/tnolin/mako).

All sources are on Ink mainnet (chain ID 57073).

## Parts

| Part | Path | License | What it does |
| --- | --- | --- | --- |
| SDK | `packages/sdk` | MIT | Event decoders, curve math, event builders and readers for InkyPump V2 and ink.fun, decoders for NFT mints, SeaDrop, Seaport and Chimera, and OpenSea response parsers |
| Events | `packages/events` | MIT | Typed, versioned event schema. The public contract between the indexer and anything that reads it |
| DB | `packages/db` | AGPL-3.0 | Postgres schema and migrations |
| Indexer | `apps/indexer` | AGPL-3.0 | Follows Ink, reads OpenSea, writes normalized rows |

## Flow

```text
 Ink RPC (HTTP reads,        OpenSea API v2
 WebSocket heads)            and Stream
        │                          │
        ▼                          ▼
 ┌───────────────────────────────────────┐
 │  packages/sdk: decoders, curve math,  │
 │  OpenSea parsers                      │
 └───────────────────────────────────────┘
        │                          │
        ▼                          ▼
 ┌───────────────────────────────────────┐
 │  apps/indexer: sources/*              │
 │  one module per source:               │
 │  InkyPump · ink.fun · NFTs · OpenSea   │
 └───────────────────────────────────────┘
                    │
                    ▼
 ┌───────────────────────────────────────┐
 │  Postgres (indexer schema)            │
 │  tokens · curve_state · trades ·      │
 │  nft_* · opensea_budget ·             │
 │  events  ◄── normalized, typed        │
 └───────────────────────────────────────┘
                    │
                    ▼
             MAKO bot rules
```

## Event sources

Each source is a module in `apps/indexer/src/sources/`. Adding a protocol means adding a module and its decoders; nothing downstream changes. Current sources:

| Source | What is tracked | How |
| --- | --- | --- |
| InkyPump V2 | Launches, curve buys and sells, curve progress, bond to Uniswap V4 | V2 hook events (`LaunchCreated`, `LaunchMetadata`, `Trade`, `LaunchFinalized`) read with `eth_getLogs`. See the [integration guide](https://docs.inkyswap.com/api-reference/contracts/integration-guide.md) |
| ink.fun | Launches with their IPFS metadata, curve buys and sells, curve progress, migration into a Uniswap v4 pool | One topic-only filter merged with InkyPump's (`LaunchCreated`, `Bought`, `Sold`, `Migrated`), trusted by emitter: the factory, a known curve or the migration module. See ADR 0035 |
| Uniswap v4 pools | Swaps in the pools of tracked tokens, with the trader, market cap, all-time-high market cap and pool liquidity; transfers of those tokens to the dead address | PoolManager `Swap` logs filtered to the pool ids in the pool registry, and `Transfer` logs to the dead address, read with `eth_getLogs`. See ADR 0033 |
| NFTs (chain) | ERC-721 and ERC-1155 mints and burns, SeaDrop drops and mint progress, Seaport sales, Chimera collection launches | `Transfer`, SeaDrop, `OrderFulfilled` and `CampaignCreated` logs on Ink. See ADR 0016 |
| OpenSea | Collection pages, drop schedules, floors and stats, listings, item ranks, creator accounts | API v2 with chain slug `ink`, and the Stream API for listings, both drawing on one shared request budget. See ADR 0017 and ADR 0019 |

**Mechanics the SDK models**

- InkyPump curves charge 2%. At the target raise, the next buy bonds the token to a Uniswap V4 pool in the same transaction.

## NFT events

NFT events share a `contract` (also the row's `entity`) and a `source` of `chain` or `opensea`. Chain events carry a real transaction hash. OpenSea events carry a synthetic id such as `os:list:<order hash>` and are stamped with the chain cursor's block (ADR 0018).

| Type | Written when | Source |
| --- | --- | --- |
| `nft.collection` | A collection is discovered, and whenever its page, kind, quality-check result or creator changes | chain and OpenSea |
| `nft.drop` | A drop schedule is first read or changes | OpenSea |
| `nft.mint` | A stage starts, a mint passes 25%, 50% or 75% of the max supply, and at sell-out | chain, with stage starts from the drop schedule and, for a verified collection with no SeaDrop stages, after 10 mints (`nft:start:<contract>`). A contract that had items minted before its first stored mint gets only `sold_out` (ADR 0027) |
| `nft.listing` | A Stream listing passes the listing filter | OpenSea |
| `nft.sale` | A Seaport fill | chain |
| `nft.stats` | Floor, owners, volume, sales or listed count changes | OpenSea |
| `nft.launch` | A Chimera campaign is created | chain |

- **Quality checks.** The indexer judges each collection on four checks (OpenSea page, mint structure, traits, and not being farm-minted). A page needs an X or website link that is not on more than 5 collections, and a name that no verified or manually real collection holds and writes the result into `nft.collection`. Collections that pass appear in feeds; the others can still be looked up and followed. ADR 0017 has the rules.
- **One log, several events.** `indexer.events` is unique on `(tx_hash, log_index, sub)`, so a sweep or a log that crosses two mint milestones yields one row per event (ADR 0016).
- **OpenSea budget.** Every process using the key draws from one request budget in Postgres (ADR 0019), so the hourly limit holds across processes.
- **Stream.** Listings arrive over the Stream in shards of 50 collections per connection, with a one-connection fallback for every collection (ADR 0017).
- **Backfill.** `pnpm backfill --sources` reads only the named sources: `inkypump`, `inkfun` (ink.fun launches, curve trades and migrations), `v4-swaps` (Uniswap v4 swaps and burns for registered pools), `nft-mints` (mints, burns, SeaDrop), `nft-sales` (Seaport) and `nft-launches` (Chimera).

## Data model

The indexer owns the `indexer` schema. Everything in it can be rebuilt from the chain and marketplace APIs.

| Table | Key fields |
| --- | --- |
| `tokens` | address, launchpad, name, ticker, creator, created_at, phase, quote_asset, paired_stock, ath_market_cap, ath_block, dead_balance, dead_balance_block |
| `curve_state` | token, progress_bps, curve_value, target, market_cap, updated_block |
| `trades` | tx_hash, log_index, token, side, trader, amount_in, amount_out, block, venue, pool_id |
| `pools` | pool_id, pool_manager, token, launchpad, quote_asset, token_is_currency0, created_block. The pool registry (ADR 0033) |
| `hooks` | InkyPump hook contracts: address, launchpad, kind (native or xStocks), ABI family, quote asset |
| `nft_collections` | contract, standard, kind, verdict and gates, why gate 1 failed, slug, name, safelist, first mint block and time, launchpad |
| `nft_mints`, `nft_burns`, `nft_seadrop_mints` | tx_hash, log_index, contract, token_id, recipient, holder or minter, qty, block. Kept 8 days |
| `nft_sales` | tx_hash, log_index, contract, token_id, qty, price_wei, currency, buyer, seller, order_hash, block. Kept 90 days |
| `nft_drops`, `nft_stages` | The drop schedule from OpenSea, and each stage's first mint |
| `nft_seadrop_config`, `nft_items_seen` | SeaDrop configuration logs, and the item names and images the listings saw |
| `nft_launches` | Chimera campaigns: collection, token, creator, pool, block |
| `nft_job_failures` | Consecutive failed OpenSea requests per collection and job, for the retry back-off (ADR 0030) |
| `nft_stats`, `nft_listing_state`, `nft_ranks`, `nft_accounts` | Floor and stats history, the last listed price per item, cached item ranks, cached creator accounts |
| `nft_overrides` | Manual verdicts and kinds set with `pnpm nft:mark` |
| `opensea_budget` | The shared OpenSea request budget (ADR 0019) |
| `events` | id, type, entity, payload (normalized JSON), block, confirmed, tx_hash, log_index, sub |
| `cursors`, `recent_blocks` | The shared chain cursor, and the last 128 block hashes the reorg check compares |
| `migrations` | The migrations applied |

`events` is the contract between the indexer and anything that reads from it. Consumers read normalized, typed events there and never touch source-specific tables. Its payload shapes are defined in `packages/events` and versioned with it.

## Reliability

- A WebSocket subscription announces new heads and reconnects automatically; the loop backfills from the last processed block.
- A tick whose head is not above the cursor reads every endpoint's own `eth_blockNumber` and uses the highest, so one endpoint stuck on an old block cannot stall ingestion (ADR 0025).
- Events are written unconfirmed and marked confirmed after 1 block, so consumers can choose how to handle reorgs.
- RPC: dRPC, Ink's public QuickNode and Gelato endpoints over HTTP with a 15 second request limit. Reads go to the endpoint with the best recent success and latency and fail over on error. See ADR 0014 and [Ink RPC docs](https://docs.inkonchain.com/tools/rpc).
- A stall watchdog exits the process when the cursor stops moving, so a supervisor restarts it (ADR 0014). With `SENTRY_DSN` set, fatal and stall exits are reported to Sentry (ADR 0015). Other errors are logged as JSON.

## Decisions

Events carry schema version 2 (ADR 0034). Dated decision records live in [`adr/`](./adr).
