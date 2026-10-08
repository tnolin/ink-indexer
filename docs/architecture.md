# Architecture

ink-indexer is an open TypeScript SDK for reading Ink launchpads, DEXs, NFT marketplaces and lending protocols, plus the indexer that stores their events in Postgres. The SDK runs anywhere with an Ink RPC. The indexer powers [MAKO](https://github.com/tnolin/mako) and, later, a keyed hosted API.

All sources are on Ink mainnet (chain ID 57073).

## Parts

| Part | Path | License | What it does |
| --- | --- | --- | --- |
| SDK | `packages/sdk` | MIT | Curve state, progress, quotes and event decoders for each supported protocol |
| Events | `packages/events` | MIT | Typed, versioned event schema. The public contract between the indexer and anything that reads it |
| DB | `packages/db` | AGPL-3.0 | Postgres schema and migrations |
| Indexer | `apps/indexer` | AGPL-3.0 | Subscribes to chain and marketplace events, writes normalized rows |
| MCP server | `apps/mcp` | MIT | Local MCP server on the SDK, using the user's own RPC |
| Hosted API | `apps/api` | AGPL-3.0 | Keyed private beta, built after the indexer is stable |

## Flow

```text
 Ink RPC (WebSocket)        Marketplace APIs  
        │                          │
        ▼                          ▼
 ┌───────────────────────────────────────┐
 │  packages/sdk: decoders, curve math   │
 └───────────────────────────────────────┘
        │                          │
        ▼                          ▼
 ┌───────────────────────────────────────┐
 │  apps/indexer: sources/*              │
 │  one module per protocol:             │
 │  launchpads · DEXs · NFTs · lending   │
 └───────────────────────────────────────┘
                    │
                    ▼
 ┌───────────────────────────────────────┐
 │  Postgres (indexer schema)            │
 │  tokens · curve_state · trades ·      │
 │  collections · nft_events · wallets · │
 │  events  ◄── normalized, typed        │
 └───────────────────────────────────────┘
          │                   │
          ▼                   ▼
   MAKO bot rules      apps/api (private beta)
```

## Event sources

Each source is a module in `apps/indexer/src/sources/`. Adding a protocol means adding a module and its decoders; nothing downstream changes. Current sources:

| Source | What is tracked | How |
| --- | --- | --- |
| InkyPump V2 | Launches, curve buys and sells, curve progress, bond to Uniswap V4, post-bond swaps | V2 hook events; REST API for metadata, King of the INK and rankings. See the [integration guide](https://docs.inkyswap.com/api-reference/contracts/integration-guide.md) and [llms.txt](https://docs.inkyswap.com/llms.txt) |
| Tsunami | Launches, curve buys and sells, graduation | Both factories: `0x5934a5C377309453746EE8aa5194F671930c09fa` and `0x1fC16511f5Fa4b4C1591ffeB8C38AFfc367076f1`. Factory emits `TokenLaunched` and `PoolCreated`; curves emit `TokenBought`, `TokenSold` and `TokenMigrated`. See [addresses](https://docs.tsunami.trade/#/reference/addresses) and [events](https://docs.tsunami.trade/#/reference/events) |
| Calamari | Post-graduation swaps and liquidity | PoolManager `0x6E4723A612831AfB9f5B2a5aE22723c37aAB9560` (Uniswap v4 style) `Initialize` and `Swap` logs; StateView and Quoter for prices. See [addresses](https://docs.calamari.trade/#/contracts/addresses) |
| OpenSea | Sales, listings, floor, collection stats and traits | API v2 with chain slug `ink` and the Stream API; Blockscout token transfers as fallback |
| Tydro | Health factors and liquidations | Scheduled `getUserAccountData` reads on the Aave V3 pool; `LiquidationCall` logs |

**Mechanics the SDK models**

- InkyPump curves charge 2%. At the target raise, the next buy bonds the token to a Uniswap V4 pool in the same transaction. Post-bond trades pay 0.1%.
- Tsunami tokens price on the curve until the sellable reserve drains, then the raise seeds a Calamari pool.
- Every lookup checks whether a token is on its curve or bonded before routing.

## Data model

The indexer owns the `indexer` schema. Everything in it can be rebuilt from the chain and marketplace APIs.

| Table | Key fields |
| --- | --- |
| `tokens` | address, launchpad, name, ticker, creator, created_at, phase, quote_asset, paired_stock |
| `curve_state` | token, progress_pct, raised, target, market_cap, updated_block |
| `trades` | tx_hash, log_index, token, side, trader, amount_in, amount_out, block, venue |
| `collections` | address, name, slug, floor, supply, traits_indexed |
| `nft_events` | collection, token_id, type (sale, listing), price, from, to, block_or_ts |
| `wallets` | address, first_seen, funded_by, linked_group, launches_count, bonded_count, labels |
| `events` | id, type, entity, payload (normalized JSON), block, confirmed |

`events` is the contract between the indexer and anything that reads from it. Consumers read normalized, typed events there and never touch source-specific tables. Its payload shapes are defined in `packages/events` and versioned with it.

## Reliability

- WebSocket subscriptions reconnect automatically and backfill from the last processed block.
- Events are written unconfirmed and marked confirmed after 1 block, so consumers can choose how to handle reorgs.
- RPC: dRPC (`wss://ink.drpc.org`) as primary, Ink's public QuickNode and Gelato endpoints as failover. See [Ink RPC docs](https://docs.inkonchain.com/tools/rpc).
- A heartbeat alerts the operator after 10 minutes with no processed events.
- Errors go to Sentry from the first deploy.

## Agent-native docs

- `llms.txt` at the docs root.
- `AGENTS.md` at the repo root: architecture, commands, how to add an event source.
- `apps/mcp` lets agents read Ink launchpads directly through the SDK.

## Decisions

Dated decision records live in [`adr/`](./adr).
