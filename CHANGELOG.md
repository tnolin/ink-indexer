# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Indexer: `TICK_MIN_INTERVAL_MS`, the least time between the starts of two live ticks (default 0, a tick on every new block). Early triggers fold into one deferred tick. See ADR 0022.
- pnpm monorepo with `sdk`, `events`, `db` and `indexer` packages, CI on Node 22 and 24, and gitleaks secret scanning.
- SDK: InkyPump V2 event decoders for native and xStocks hooks, curve math, event builders and multicall readers.
- Events schema v1: `launchpad.launch`, `launchpad.trade` and `launchpad.bond`.
- Events: NFT types `nft.collection`, `nft.drop`, `nft.mint`, `nft.listing`, `nft.sale`, `nft.stats` and `nft.launch`, with `NftEvent` and `LaunchpadEvent` unions. Schema version stays 1 and existing types are unchanged, so readers of `events-v1` that ignore unknown types keep working.
- Events table (migration 0003): a `sub` column and a unique key on `(tx_hash, log_index, sub)`, so one log can yield several events, and an `events_type_entity_id` index on `(type, entity, id)`.
- Trade event `soldBps`: tokens sold over sale supply in basis points, capped at 10,000, beside the curve-based `progressBpsBefore` and `progressBpsAfter`.
- Indexer: backfill and live following of InkyPump V2 on Ink, getLogs routing across RPC providers, confirmation tracking and reorg rollback.
- SDK: decoders for ERC-721 and ERC-1155 mints and burns, SeaDrop logs, Seaport sales and Chimera campaigns, SeaDrop mint-stat reads, and OpenSea REST and Stream parsers.
- Indexer: a `Source` interface shared by every protocol (one cursor, one batch transaction, one rollback), with InkyPump and NFTs as the two sources. See ADR 0016.
- Indexer: NFT chain source for mints, burns, SeaDrop, Seaport sales (matched orders merged into one sale) and Chimera launches, with mint milestones and scheduled stage starts.
- Indexer: OpenSea source with REST jobs (discovery, metadata, drops, stats, listed counts, traits samples, item ranks, creator accounts), Stream shards of 50 collections per connection with a firehose fallback, and collection quality checks. See ADR 0017.
- Indexer: OpenSea-derived events with synthetic ids, stamped with the chain cursor's block and moved, not deleted, on a reorg, under an in-process mutex and a Postgres advisory lock. See ADR 0018.
- DB: a request budget shared by every process using one OpenSea key (`opensea_take`, `opensea_block`, `opensea_configure`). See ADR 0019.
- Indexer: `OPENSEA_API_KEY`, `OPENSEA_REQUESTS_PER_HOUR`, `OPENSEA_MIN_INTERVAL_MS` and `NFT_HISTORY_START_BLOCK` settings, `backfill --sources` (`inkypump`, `nft-mints`, `nft-sales`, `nft-launches`) and `pnpm nft:mark`.
- Indexer: `INDEXER_SOURCES` turns platforms (`inkypump`, `opensea`, `chimera`) on or off with one setting and a restart; the default runs all three. See ADR 0020.
- Indexer: a daily prune of NFT rows (mints, burns and SeaDrop mints after 8 days, sales after 90 days).
- Indexer: the live tick and backfill read the sources' log filters in fewer `eth_getLogs` requests (5 instead of 8 with every group on) and split the logs back to each filter, so every source receives the same logs as before. See ADR 0021.
- Indexer: a `rpc calls` log line every 10 minutes with each endpoint's requests by method (`getLogs`, `blockNumber`, `getBlock`, `other`) and its rate-limited failures. See ADR 0021.
- Optional Sentry reporting for fatal and stall exits (`SENTRY_DSN`, `SENTRY_RELEASE`).
- Migration 0002: `events_launch_creator` and `events_type_id` indexes for readers of `indexer.events`.

### Fixed

- The new-head subscription is created again after the WebSocket closes or goes silent, with backoff up to 5 minutes. An outage logs one warning when it starts and one line when heads return, instead of a warning every 10 seconds.
- A dropped WebSocket no longer leaves a new-head subscription behind. The indexer subscribed again on every subscription error, and viem's reconnect restored the old one too, so each drop added a subscription and every later drop reported an error for each of them (about a million warning lines a day). It now subscribes again only after 30 s without a head, and a repeating error logs once per outage.

### Changed

- Collection verdict `junk` is now `filtered`. A development database that applied migrations 0007 or 0009 before this rename must be reset (for the `pnpm db:dev` database, delete `.data/postgres`), because their check constraints still allow only `junk`.
- Sentry events drop HTTP, fetch and console breadcrumbs and redact the configured RPC and database URLs.
- Indexer: a block the endpoint does not serve yet is retried on the next head instead of stopping the process or triggering a rollback.
- Indexer: rate-limited reads are retried with backoff.
- Indexer: batch inserts are split into 1,000-row statements.
- Indexer: usage errors exit 2 before any connection is made.
- Tests read `TEST_DATABASE_URL`; `DATABASE_URL` is no longer used by the test harness.
- SDK: `curveValue` and `progressBps` return 0 instead of throwing when the sale supply or target is zero.

