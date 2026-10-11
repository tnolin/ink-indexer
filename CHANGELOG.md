# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- pnpm monorepo with `sdk`, `events`, `db` and `indexer` packages, CI on Node 22 and 24, and gitleaks secret scanning.
- SDK: InkyPump V2 event decoders for native and xStocks hooks, curve math, event builders and multicall readers.
- Events schema v1: `launchpad.launch`, `launchpad.trade` and `launchpad.bond`.
- Trade event `soldBps`: tokens sold over sale supply in basis points, capped at 10,000, beside the curve-based `progressBpsBefore` and `progressBpsAfter`.
- Indexer: backfill and live following of InkyPump V2 on Ink, getLogs routing across RPC providers, confirmation tracking and reorg rollback.

### Changed

- Indexer: a block the endpoint does not serve yet is retried on the next head instead of stopping the process or triggering a rollback.
- Indexer: rate-limited reads are retried with backoff.
- Indexer: batch inserts are split into 1,000-row statements.
- Indexer: usage errors exit 2 before any connection is made.
- Tests read `TEST_DATABASE_URL`; `DATABASE_URL` is no longer used by the test harness.
- SDK: `curveValue` and `progressBps` return 0 instead of throwing when the sale supply or target is zero.

