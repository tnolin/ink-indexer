import { afterAll, expect, inject, it } from "vitest"
import { connect, migrate } from "../src/index"

const sql = connect(inject("databaseUrl"))
afterAll(() => sql.end())

it("applies migrations to an empty database, then does nothing on a second run", async () => {
  await sql`drop schema if exists indexer cascade`
  expect(await migrate(sql)).toEqual(["0001_init.sql", "0002_events_bot_indexes.sql"])
  expect(await migrate(sql)).toEqual([])
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'indexer' order by 1`
  expect(tables.map((t) => t.table_name)).toEqual([
    "cursors",
    "curve_state",
    "events",
    "hooks",
    "migrations",
    "recent_blocks",
    "tokens",
    "trades",
  ])
})
