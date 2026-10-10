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

## Usage

Decode InkyPump V2 events with the SDK and any viem client:

```ts
import { decodeLog } from "@ink-indexer/sdk"

const event = decodeLog(log)
if (event?.kind === "trade") console.log(event.side, event.sold)
```

Run the example: `pnpm tsx examples/decode-launches.ts`. Curve math (`curveValue`, `curvePrice`, `progressBps`) is described in the [SDK README](packages/sdk/README.md).

Read normalized events from the indexer's database:

```sql
select id, type, payload from indexer.events
where confirmed and id > $1
order by id limit 500;
```

`(txHash, logIndex)` in each payload is the stable event identity. `id` can change after a reorg rollback, so dedupe on `(txHash, logIndex)`. Drop `confirmed` to also read events from the newest block, which a reorg can still remove.

Event shapes are documented in [`packages/events`](packages/events/README.md).

## How it works

```text
 Ink RPC (WebSocket heads) ── new head ──► tick
        ▲                              │
        └──── eth_getLogs from cursor ◄┘   (routed to the provider with the widest range,
                       │                     clamped to that provider's own head)
                       ▼
     decode → trusted hooks only → curve progress → rows
                       │
                       ▼
     Postgres `indexer` schema: hooks · tokens · curve_state · trades · events · cursors · recent_blocks
```

Each new block triggers a catch-up from the last saved block, so backfill, live indexing and reconnects follow one path. Events are written unconfirmed and confirmed one block later; a reorg rolls back to the last matching block and re-ingests. Decisions are recorded in [`docs/adr`](docs/adr).

## Contributing, security and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensing is per package; see [LICENSE](LICENSE).
