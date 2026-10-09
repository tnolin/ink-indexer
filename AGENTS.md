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

## Adding an InkyPump hook

xStocks hooks are discovered on-chain. For a new native hook (the indexer logs "ignoring InkyPump-shaped event from an unknown contract" at its first launch):

1. Add it to `NATIVE_HOOKS` in `packages/sdk/src/inkypump/deployments.ts` with its ABI family and start block.
2. Capture one launch and one trade as fixtures (`pnpm tsx scripts/capture-fixture.ts <name> <tx>`) and add their names to `FIXTURES` in `packages/sdk/test/fixtures.ts`.
3. Release, stop `pnpm start`, run `pnpm backfill --from <start block>`, then start again.

## Adding an event source

1. Decoders and pure event builders go in `packages/sdk/src/<protocol>/`, tested against captured mainnet fixtures.
2. New event types go in `packages/events` (a new schema version if an existing shape changes).
3. Ingestion goes in `apps/indexer/src/sources/<protocol>/`, returning rows like `sources/inkypump`.
4. Record the decision in a new ADR.
