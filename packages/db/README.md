# @ink-indexer/db

Postgres schema and migrations for ink-indexer. AGPL-3.0-only.

- `migrations/`: numbered SQL files applied in order. Never edit an applied migration; add a new file.
- `connect(url)`: a postgres.js connection that parses `int8` as `bigint`.
- `migrate(sql)`: applies pending migrations. Also available as `pnpm db:migrate`.

Everything lives in the `indexer` schema and can be rebuilt from the chain.
