# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Changed

- Indexer: a listing event carries a floor read within the last 10 minutes. When a listing arrives and the collection's stored floor is older, the indexer reads the floor from OpenSea first, at most once per collection every 10 minutes, and the event carries the new floor and its time. If the read fails or the request budget is blocked, the event carries the stored floor with its own `floorAt`. Before, the floor was read again only after 2 hours, at most once per 30 minutes. See ADR 0028.

### Fixed

- Indexer: gate 1 no longer passes a collection on a link that many collections share, or on a name copied from a verified or manually real collection. An X handle or website on more than 5 collections counts as missing, and a name that matches a verified or manually real collection fails. A manual mark and a verified collection or creator are unaffected. `nft_collections.page_reason` records why gate 1 failed. When a link goes over the limit, the other collections that use it are judged again. Migration 0013 adds the column and marks every collection's verdict to be re-checked once, so some collections that were `real` can become `filtered` after the update. See ADR 0026.
- Indexer: a contract that had items minted before its first stored mint no longer gets `stage_start` and `progress` mint events when it mints again. They were written all at once for a mint that began long before. Its mints, sales, `sold_out` event and collection snapshots are unchanged. See ADR 0027.

## [indexer-v0.3.4] - 2026-10-26

### Fixed

- Indexer: one endpoint answering `eth_blockNumber` with an old block no longer stops ingestion. When a tick's head is not above the cursor, it reads every endpoint's own head and uses the highest, and logs `stale head from <host>` once per incident and `head source recovered` when the head is current again. Ticks that find new blocks make no extra calls. See ADR 0025.

## [indexer-v0.3.3] - 2026-10-26

### Fixed

- A collection with a mint or sale in the last 7 days has its OpenSea page read daily whatever its verdict, and a mint or sale stored for a collection whose page read is more than a day away makes the read due at once. Links added after an early read are now picked up, so gate 1 no longer holds a collection back for a week. See ADR 0024.

## [indexer-v0.3.2] - 2026-10-24

### Added

- Indexer: a sale of a contract with no collection row creates the row, due for OpenSea discovery, as a first mint does. `pnpm nft:collections-from-sales` creates the rows for contracts that already have sales. See ADR 0023.

## [indexer-v0.3.1] - 2026-10-22

### Added

- Indexer: `TICK_MIN_INTERVAL_MS`, the least time between the starts of two live ticks (default 0, a tick on every new block). Early triggers fold into one deferred tick. See ADR 0022.

## [indexer-v0.3.0] - 2026-10-22

### Added

- Indexer: the live tick and backfill read the sources' log filters in fewer `eth_getLogs` requests (5 instead of 8 with every group on) and split the logs back to each filter, so every source receives the same logs as before. See ADR 0021.
- Indexer: a `rpc calls` log line every 10 minutes with each endpoint's requests by method (`getLogs`, `blockNumber`, `getBlock`, `other`) and its rate-limited failures. See ADR 0021.

## [indexer-v0.2.0] - 2026-10-21

### Added

- Indexer: `INDEXER_SOURCES` turns platforms (`inkypump`, `opensea`, `chimera`) on or off with one setting and a restart; the default runs all three. See ADR 0020.

## [events-v2] - 2026-10-21

### Added

- Events: NFT types `nft.collection`, `nft.drop`, `nft.mint`, `nft.listing`, `nft.sale`, `nft.stats` and `nft.launch`, with `NftEvent` and `LaunchpadEvent` unions. Schema version stays 1 and existing types are unchanged, so readers of `events-v1` that ignore unknown types keep working.
- Events table (migration 0003): a `sub` column and a unique key on `(tx_hash, log_index, sub)`, so one log can yield several events, and an `events_type_entity_id` index on `(type, entity, id)`.
- SDK: decoders for ERC-721 and ERC-1155 mints and burns, SeaDrop logs, Seaport sales and Chimera campaigns, SeaDrop mint-stat reads, and OpenSea REST and Stream parsers.
- Indexer: a `Source` interface shared by every protocol (one cursor, one batch transaction, one rollback), with InkyPump and NFTs as the two sources. See ADR 0016.
- Indexer: NFT chain source for mints, burns, SeaDrop, Seaport sales (matched orders merged into one sale) and Chimera launches, with mint milestones and scheduled stage starts.
- Indexer: OpenSea source with REST jobs (discovery, metadata, drops, stats, listed counts, traits samples, item ranks, creator accounts), Stream shards of 50 collections per connection with a firehose fallback, and collection quality checks. See ADR 0017.
- Indexer: OpenSea-derived events with synthetic ids, stamped with the chain cursor's block and moved, not deleted, on a reorg, under an in-process mutex and a Postgres advisory lock. See ADR 0018.
- DB: a request budget shared by every process using one OpenSea key (`opensea_take`, `opensea_block`, `opensea_configure`). See ADR 0019.
- Indexer: `OPENSEA_API_KEY`, `OPENSEA_REQUESTS_PER_HOUR`, `OPENSEA_MIN_INTERVAL_MS` and `NFT_HISTORY_START_BLOCK` settings, `backfill --sources` (`inkypump`, `nft-mints`, `nft-sales`, `nft-launches`) and `pnpm nft:mark`.
- Indexer: a daily prune of NFT rows (mints, burns and SeaDrop mints after 8 days, sales after 90 days).

### Changed

- Collection verdict `junk` is now `filtered`. A development database that applied migrations 0007 or 0009 before this rename must be reset (for the `pnpm db:dev` database, delete `.data/postgres`), because their check constraints still allow only `junk`.

## [indexer-v0.1.2] - 2026-10-20

### Fixed

- A dropped WebSocket no longer leaves a new-head subscription behind. The indexer subscribed again on every subscription error, and viem's reconnect restored the old one too, so each drop added a subscription and every later drop reported an error for each of them (about a million warning lines a day). It now subscribes again only after 30 s without a head, and a repeating error logs once per outage.

## [indexer-v0.1.1] - 2026-10-16

### Fixed

- The new-head subscription is created again after the WebSocket closes or goes silent, with backoff up to 5 minutes. An outage logs one warning when it starts and one line when heads return, instead of a warning every 10 seconds.

## [indexer-v0.1.0] - 2026-10-13

### Changed

- Sentry events drop HTTP, fetch and console breadcrumbs and redact the configured RPC and database URLs.

## [events-v1] - 2026-10-12

### Added

- pnpm monorepo with `sdk`, `events`, `db` and `indexer` packages, CI on Node 22 and 24, and gitleaks secret scanning.
- SDK: InkyPump V2 event decoders for native and xStocks hooks, curve math, event builders and multicall readers.
- Events schema v1: `launchpad.launch`, `launchpad.trade` and `launchpad.bond`.
- Trade event `soldBps`: tokens sold over sale supply in basis points, capped at 10,000, beside the curve-based `progressBpsBefore` and `progressBpsAfter`.
- Indexer: backfill and live following of InkyPump V2 on Ink, getLogs routing across RPC providers, confirmation tracking and reorg rollback.
- Optional Sentry reporting for fatal and stall exits (`SENTRY_DSN`, `SENTRY_RELEASE`).
- Migration 0002: `events_launch_creator` and `events_type_id` indexes for readers of `indexer.events`.

### Changed

- Indexer: a block the endpoint does not serve yet is retried on the next head instead of stopping the process or triggering a rollback.
- Indexer: rate-limited reads are retried with backoff.
- Indexer: batch inserts are split into 1,000-row statements.
- Indexer: usage errors exit 2 before any connection is made.
- Tests read `TEST_DATABASE_URL`; `DATABASE_URL` is no longer used by the test harness.
- SDK: `curveValue` and `progressBps` return 0 instead of throwing when the sale supply or target is zero.
