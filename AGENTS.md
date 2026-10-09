# AGENTS.md

## Layout

- `packages/events`: typed event schema (MIT). The public contract for anything reading `indexer.events`.
- `packages/sdk`: decoders, curve math, event builders and multicall readers (MIT). No database code.
- `packages/db`: SQL migrations and the postgres.js connection (AGPL).
- `apps/indexer`: the ingestion loop, RPC routing and the per-protocol sources in `src/sources/` (AGPL).
- `docs/adr`: dated decision records. Read them before changing behaviour they cover.

## Commands

- `pnpm test`: all tests. A throwaway Postgres starts automatically unless `DATABASE_URL` is set.
- `pnpm lint`, `pnpm typecheck`, `pnpm format`.
- `pnpm db:dev`: persistent local Postgres in `.data/postgres`.
- `pnpm db:migrate`, `pnpm start`, `pnpm backfill --from <block> [--to <block>]`.
