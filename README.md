# ink-indexer

[![CI](https://github.com/tnolin/ink-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/tnolin/ink-indexer/actions/workflows/ci.yml)
[![License: MIT / AGPL-3.0](https://img.shields.io/badge/license-MIT%20%2F%20AGPL--3.0-blue)](LICENSE)

Open SDK and indexer for Ink memecoin launchpads and NFTs.

ink-indexer watches the Ink blockchain for new memecoin launches, trades and bonds, and for NFT mints, sales, listings and collection stats, and turns them into clean, typed events that bots, dashboards and AI agents can read. The SDK decodes the raw chain data; the indexer stores it in Postgres.

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](https://github.com/tnolin/mako/blob/main/docs/deploy.md): the indexer is deployed with the MAKO bot, on one server
- [Decision records](docs/adr)
- [AGENTS.md](AGENTS.md), for coding agents

## Quick start

    pnpm install
    pnpm db:dev          # in a second terminal: local Postgres, no Docker needed
    DATABASE_URL=postgres://ink:ink@localhost:5432/ink pnpm start

## What's inside

| Package | License | What it does |
| --- | --- | --- |
| [`packages/sdk`](packages/sdk) | MIT | Event decoders, curve math and event builders for InkyPump V2 and ink.fun, Uniswap v4 swap decoding and pool math, and decoders for NFT mints, SeaDrop, Seaport and Chimera |
| [`packages/events`](packages/events) | MIT | Typed, versioned event schema |
| [`packages/db`](packages/db) | AGPL-3.0 | Postgres schema and migrations |
| [`apps/indexer`](apps/indexer) | AGPL-3.0 | Follows Ink, reads OpenSea, and writes normalized events to Postgres |

## Supported platforms

Each row is one platform the indexer reads: the contracts it follows, the events it writes, and the names that turn it on and backfill it.

| Platform | Contracts | Events | `INDEXER_SOURCES` | Backfill names |
| --- | --- | --- | --- | --- |
| InkyPump curve | Native hooks `0x4cc8f6d5b7ce150ccc0a9b7664532b1283b96ac4`, `0x893183da2411c7df81f103bfef09e4e46c326ac4`; xStocks hooks found through factories `0x81c95e12d40c0eacb61609b0bb0d8100d92a5fc4`, `0x92f303ae539052ebb7d551bb2ec1a6f1affbaf85` | `launchpad.launch`, `launchpad.trade`, `launchpad.bond` | `inkypump` | `inkypump` |
| InkyPump pools | Uniswap v4 PoolManager `0x360e68faccca8ca495c1b759fd9eee466db9fb32` (swaps of bonded tokens; transfers to the dead address) | `launchpad.swap` | `inkypump` | `v4-swaps` |
| ink.fun | Factory `0x329ae95b937415b7ee805ff2c4e358137daccd37`, one curve per launch, migration module `0xc202bb7fb1e9c7e67305e09ad2313756e0b5034d`; pools in the Uniswap v4 PoolManager with hook `0x735458d31dcf29dc204109430b1f7f96738568cc` | `launchpad.launch`, `launchpad.trade`, `launchpad.bond`, `launchpad.swap` | `inkfun` | `inkfun`, `v4-swaps` |
| NFT mints | Any ERC-721 or ERC-1155 contract (mints and burns) | `nft.mint`, `nft.collection` | `opensea` | `nft-mints` |
| SeaDrop | SeaDrop v1 `0x00005ea00ac477b1030ce78506496e8c2de24bf5` | `nft.mint` | `opensea` | `nft-mints` |
| Seaport | Seaport 1.6 `0x0000000000000068f116a894984e2db1123eb395`, 1.5 `0x00000000000000adc04c56bf30ac9d3c0aaf14dc` | `nft.sale` | `opensea` | `nft-sales` |
| OpenSea API | none (OpenSea REST and Stream) | `nft.collection`, `nft.drop`, `nft.listing`, `nft.stats`, `nft.mint` | `opensea` | none (read live) |
| Chimera | Factory `0xa66c05f14e79f40952531c20de0b60282e3800be` | `nft.launch` | `chimera` | `nft-launches` |

Launchpads: `launchpad.swap` is a swap in a tracked Uniswap v4 pool, with the trader, the market cap after the swap, the token's all-time-high market cap and the pool's quote-side liquidity (ADR [0033](docs/adr/0033-uniswap-v4-swaps-and-pool-registry.md)). A token's pool is registered when it graduates, and its swaps are indexed from then on. ink.fun launches carry their name, image, description and links, read from the token's IPFS metadata ([ADR 0035](docs/adr/0035-inkfun-source.md)). Events use schema version 2 ([ADR 0034](docs/adr/0034-events-schema-version-2.md)); rows written before it keep `v: 1`.

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

Ink NFT events are `nft.collection`, `nft.drop`, `nft.mint`, `nft.listing`, `nft.sale`, `nft.stats` and `nft.launch`. Mints, burns, SeaDrop drops, Seaport sales and Chimera launches come from chain logs. Collection pages, drop schedules, floors, listings, item ranks and creator accounts come from OpenSea. Each `nft.collection` event carries the collection's verdict: `real` for collections that pass quality checks (a complete OpenSea page with a link of its own and a name of its own, a sound mint structure, traits, and minters who are not mostly repeat farm wallets), `pending` while checks are undecided, `filtered` once a check fails. Every collection's events stay readable. Read them like any other event:

```sql
select id, payload from indexer.events
where confirmed and type like 'nft.%' and id > $1
order by id limit 500;
```

Environment variables, all optional. An invalid value is logged and its default is used.

| Variable | Default | What it does |
| --- | --- | --- |
| `INDEXER_SOURCES` | `inkypump,opensea,chimera,inkfun` | The platforms to run, comma-separated. `inkypump` is the InkyPump curve and its Uniswap v4 pools (`inkypump` and `v4-swaps`), `opensea` is the NFT mint, sale and OpenSea API parts, `chimera` the Chimera launches, `inkfun` ink.fun's curve and its Uniswap v4 pools (`inkfun` and `v4-swaps`). A name that is unknown or repeated stops the start. `backfill` without `--sources` covers the enabled platforms |
| `IPFS_GATEWAY` | `https://cracker.mypinata.cloud` | HTTPS origin of an IPFS gateway for ink.fun token metadata and images. Empty uses the default |
| `OPENSEA_API_KEY` | empty | OpenSea API key. Empty runs the chain sources only, after one warning |
| `OPENSEA_REQUESTS_PER_HOUR` | 500 | The key's hourly request budget, shared by every process using the key |
| `OPENSEA_MIN_INTERVAL_MS` | 300 | The shortest gap between two requests on the key |
| `TICK_MIN_INTERVAL_MS` | 0 | The least time in milliseconds between the starts of two live ticks (0 to 60000). 0 runs a tick on every new block. A higher value reads several blocks per request and adds up to that much latency for every source. See [ADR 0022](docs/adr/0022-tick-min-interval.md) |
| `NFT_HISTORY_START_BLOCK` | the first stored mint | The block the mint backfill started from. A collection that minted earlier is `legacy` and has no mint events |

Backfill by source with `pnpm backfill --from <block> --sources nft-mints,nft-sales,nft-launches` (the names are `inkypump`, `inkfun`, `v4-swaps`, `nft-mints`, `nft-sales` and `nft-launches`; the default is every source). `pnpm nft:mark <contract> <value>` sets a collection's verdict or kind by hand (the values are listed in the indexer README). Details are in the [indexer README](apps/indexer/README.md) and ADRs [0016](docs/adr/0016-nft-chain-sources.md), [0017](docs/adr/0017-opensea-source.md), [0018](docs/adr/0018-off-chain-events.md) and [0019](docs/adr/0019-opensea-shared-budget.md).

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

Each tick asks for the logs of all enabled sources in a few `eth_getLogs` requests (filters that differ only in the event topic or the address share one) and splits the response back to each filter. Each new block triggers a catch-up from the last saved block, so backfill, live indexing and reconnects follow one path. Every source (InkyPump, ink.fun, Uniswap v4 pools, NFTs) reads the same block range and shares one cursor and one rollback. Events are written unconfirmed and confirmed one block later; a reorg rolls back to the last matching block and re-ingests. Decisions are recorded in [`docs/adr`](docs/adr).

## Contributing, security and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensing is per package; see [LICENSE](LICENSE).
