# ink-indexer

[![CI](https://github.com/tnolin/ink-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/tnolin/ink-indexer/actions/workflows/ci.yml)
[![License: MIT / AGPL-3.0](https://img.shields.io/badge/license-MIT%20%2F%20AGPL--3.0-blue)](LICENSE)

Open SDK and indexer for Ink launchpads and NFTs, starting with InkyPump V2.

ink-indexer watches the Ink blockchain for new memecoin launches, trades and bonds, and for NFT mints, sales, listings and collection stats, and turns them into clean, typed events that bots, dashboards and AI agents can read. The SDK decodes the raw chain data; the indexer stores it in Postgres.

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](https://github.com/tnolin/mako/blob/main/docs/deploy.md): the indexer is deployed with the MAKO bot, on one server
- [Decision records](docs/adr)
- [AGENTS.md](AGENTS.md), for coding agents

<!-- Privacy policy: add the link at https://makobot.xyz once the site is live. -->

## Quick start

    pnpm install
    pnpm db:dev          # in a second terminal: local Postgres, no Docker needed
    DATABASE_URL=postgres://ink:ink@localhost:5432/ink pnpm start

## What's inside

| Package | License | What it does |
| --- | --- | --- |
| [`packages/sdk`](packages/sdk) | MIT | Event decoders, curve math and event builders for InkyPump V2, and decoders for NFT mints, SeaDrop, Seaport and Chimera |
| [`packages/events`](packages/events) | MIT | Typed, versioned event schema |
| [`packages/db`](packages/db) | AGPL-3.0 | Postgres schema and migrations |
| [`apps/indexer`](apps/indexer) | AGPL-3.0 | Follows Ink, reads OpenSea, and writes normalized events to Postgres |

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

`confirmed` is set one block after an event's block, in the same commit that writes newer confirmed events, so this query never skips an older row. It does not mean final: a reorg rollback deletes every chain row above the fork point, up to 128 blocks back, confirmed rows included, and re-inserts the new fork's events with new ids. Off-chain `os:` and `nft:` rows are moved to the fork block, unconfirmed, and keep their ids (see [ADR 0018](docs/adr/0018-off-chain-events.md)). The event identities are listed in the Identity table of the [events README](packages/events/README.md#identity). Treat events within the last 128 blocks of the chain head as revisable. Drop `confirmed` to also read events from the newest block.

Event shapes are documented in [`packages/events`](packages/events/README.md).

## NFTs

Ink NFT events are `nft.collection`, `nft.drop`, `nft.mint`, `nft.listing`, `nft.sale`, `nft.stats` and `nft.launch`. Mints, burns, SeaDrop drops, Seaport sales and Chimera launches come from chain logs. Collection pages, drop schedules, floors, listings, item ranks and creator accounts come from OpenSea. Each `nft.collection` event carries the collection's verdict: `real` for collections that pass quality checks (a complete OpenSea page, a sound mint structure, traits, and minters who are not mostly repeat farm wallets), `pending` while checks are undecided, `filtered` once a check fails. Every collection's events stay readable. Read them like any other event:

```sql
select id, payload from indexer.events
where confirmed and type like 'nft.%' and id > $1
order by id limit 500;
```

Environment variables, all optional. An invalid value is logged and its default is used.

| Variable | Default | What it does |
| --- | --- | --- |
| `INDEXER_SOURCES` | `inkypump,opensea,chimera` | The platforms to run, comma-separated. `opensea` is the NFT mint, sale and OpenSea API parts, `chimera` the Chimera launches. A name that is unknown or repeated stops the start. `backfill` without `--sources` covers the enabled platforms |
| `OPENSEA_API_KEY` | empty | OpenSea API key. Empty runs the chain sources only, after one warning |
| `OPENSEA_REQUESTS_PER_HOUR` | 500 | The key's hourly request budget, shared by every process using the key |
| `OPENSEA_MIN_INTERVAL_MS` | 300 | The shortest gap between two requests on the key |
| `NFT_HISTORY_START_BLOCK` | the first stored mint | The block the mint backfill started from. A collection that minted earlier is `legacy` and has no mint events |

Backfill by source with `pnpm backfill --from <block> --sources nft-mints,nft-sales,nft-launches` (the names are `inkypump`, `nft-mints`, `nft-sales` and `nft-launches`; the default is every source). `pnpm nft:mark <contract> <value>` sets a collection's verdict or kind by hand (the values are listed in the indexer README). Details are in the [indexer README](apps/indexer/README.md) and ADRs [0016](docs/adr/0016-nft-chain-sources.md), [0017](docs/adr/0017-opensea-source.md), [0018](docs/adr/0018-off-chain-events.md) and [0019](docs/adr/0019-opensea-shared-budget.md).

## Upgrading and rollback

`pnpm db:migrate` (and `pnpm start`) applies new migrations in order. Migration 0003 replaces the events table's `unique (tx_hash, log_index)` with `unique (tx_hash, log_index, sub)`. A binary from before 0003 inserts with `on conflict (tx_hash, log_index)`, which the table no longer has, so it cannot write events. Rolling the code back past 0003 needs the reverse migration first:

```sql
-- Logs that yielded several events keep their first row only.
delete from indexer.events e using indexer.events k
where e.tx_hash = k.tx_hash and e.log_index = k.log_index and e.sub > k.sub;
drop index indexer.events_type_entity_id;
alter table indexer.events drop constraint events_tx_hash_log_index_sub_key;
alter table indexer.events add unique (tx_hash, log_index);
alter table indexer.events drop column sub;
```

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

Each tick asks for the logs of all enabled sources in a few `eth_getLogs` requests (filters that differ only in the event topic or the address share one) and splits the response back to each filter. Each new block triggers a catch-up from the last saved block, so backfill, live indexing and reconnects follow one path. Every source (InkyPump, NFTs) reads the same block range and shares one cursor and one rollback. Events are written unconfirmed and confirmed one block later; a reorg rolls back to the last matching block and re-ingests. Decisions are recorded in [`docs/adr`](docs/adr).

## Contributing, security and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensing is per package; see [LICENSE](LICENSE).
