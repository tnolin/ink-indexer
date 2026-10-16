# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- pnpm monorepo with `sdk`, `events`, `db` and `indexer` packages, CI on Node 22 and 24, and gitleaks secret scanning.
- SDK: InkyPump V2 event decoders for native and xStocks hooks, curve math, event builders and multicall readers.
- Events schema v1: `launchpad.launch`, `launchpad.trade` and `launchpad.bond`.
- Trade event `soldBps`: tokens sold over sale supply in basis points, capped at 10,000, beside the curve-based `progressBpsBefore` and `progressBpsAfter`.
- Indexer: backfill and live following of InkyPump V2 on Ink, getLogs routing across RPC providers, confirmation tracking and reorg rollback.
- Optional Sentry reporting for fatal and stall exits (`SENTRY_DSN`, `SENTRY_RELEASE`).
- Migration 0002: `events_launch_creator` and `events_type_id` indexes for readers of `indexer.events`.

### Fixed

- The new-head subscription is created again after the WebSocket closes or goes silent, with backoff up to 5 minutes. An outage logs one warning when it starts and one line when heads return, instead of a warning every 10 seconds.

### Changed

- Sentry events drop HTTP, fetch and console breadcrumbs and redact the configured RPC and database URLs.
- Indexer: a block the endpoint does not serve yet is retried on the next head instead of stopping the process or triggering a rollback.
- Indexer: rate-limited reads are retried with backoff.
- Indexer: batch inserts are split into 1,000-row statements.
- Indexer: usage errors exit 2 before any connection is made.
- Tests read `TEST_DATABASE_URL`; `DATABASE_URL` is no longer used by the test harness.
- SDK: `curveValue` and `progressBps` return 0 instead of throwing when the sale supply or target is zero.

