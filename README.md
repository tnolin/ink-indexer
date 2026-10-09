# ink-indexer

[![CI](https://github.com/tnolin/ink-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/tnolin/ink-indexer/actions/workflows/ci.yml)
[![License: MIT / AGPL-3.0](https://img.shields.io/badge/license-MIT%20%2F%20AGPL--3.0-blue)](LICENSE)

Open SDK and indexer for Ink launchpads, starting with InkyPump V2.

ink-indexer watches the Ink blockchain for new memecoin launches, trades and bonds, and turns them into clean, typed events that bots, dashboards and AI agents can read. The SDK decodes the raw chain data; the indexer stores it in Postgres.

## Quick start

    pnpm install
    pnpm db:dev          # in a second terminal: local Postgres, no Docker needed
    DATABASE_URL=postgres://ink:ink@localhost:5432/ink pnpm start

## What's inside

| Package | License | What it does |
| --- | --- | --- |
| [`packages/sdk`](packages/sdk) | MIT | Event decoders, curve math and event builders for InkyPump V2 |
| [`packages/events`](packages/events) | MIT | Typed, versioned event schema |
| [`packages/db`](packages/db) | AGPL-3.0 | Postgres schema and migrations |
| [`apps/indexer`](apps/indexer) | AGPL-3.0 | Follows Ink and writes normalized events to Postgres |

## Contributing, security and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensing is per package; see [LICENSE](LICENSE).
