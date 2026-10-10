# Contributing

Outside pull requests open once our contributor license agreement (CLA) is in place. Until then, please open an issue to report a bug or suggest a change.

## Development

- Node 22.12 or later and pnpm 12.
- `pnpm install`, then `pnpm test`. Tests start a throwaway Postgres automatically, or use `TEST_DATABASE_URL` if set. The tests drop the `indexer` schema of that database, and `DATABASE_URL` is never used for tests.
- `pnpm lint`, `pnpm typecheck` and `pnpm format`.

## Rules

- Write the failing test first.
- Conventional commit messages: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`, `refactor:`.
- CI (lint, typecheck, tests, secret scan) must pass before merge.
- Never commit secrets or `.env` files. `.env.example` lists every variable with an empty value.
- Record significant technical decisions as a dated ADR in `docs/adr/`.
