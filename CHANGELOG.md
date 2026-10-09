# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- pnpm monorepo with `sdk`, `events`, `db` and `indexer` packages, CI on Node 22 and 24, and gitleaks secret scanning.
- SDK: InkyPump V2 event decoders for native and xStocks hooks, curve math, event builders and multicall readers.
- Events schema v1: `launchpad.launch`, `launchpad.trade` and `launchpad.bond`.
- Indexer: backfill and live following of InkyPump V2 on Ink, getLogs routing across RPC providers, confirmation tracking and reorg rollback.
