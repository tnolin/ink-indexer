# 0012. Tooling: Biome, Vitest, embedded Postgres, plain SQL migrations

Date: 2026-10-08
Status: Accepted

## Context

The monorepo needs lint, format, tests against a real Postgres, and schema migrations. Contributors may not have Docker or a system Postgres.

## Decision

- Biome for lint and format, Vitest for tests, `tsc --noEmit` over one root `tsconfig.json` for typechecking. Workspace packages export TypeScript source until they are published to npm.
- Tests and local runs use `embedded-postgres`. CI uses a `postgres:18` service container through `DATABASE_URL`.
- Migrations are numbered `.sql` files in `packages/db/migrations`, applied in order by a small runner that records them in `indexer.migrations`. Queries use postgres.js.

## Consequences

- `pnpm install && pnpm test` works with Node and pnpm only.
- Schema changes are plain SQL that reviewers read directly.
- Publishing a package to npm will add a build step for that package.
