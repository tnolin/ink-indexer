import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "./index"

const MIGRATIONS = join(import.meta.dirname, "../migrations")

/** Applies pending migrations in file-name order, each in its own transaction. Returns what it applied. */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql`create schema if not exists indexer`
  await sql`create table if not exists indexer.migrations (name text primary key, applied_at timestamptz not null default now())`
  const done = new Set(
    (await sql<{ name: string }[]>`select name from indexer.migrations`).map((r) => r.name),
  )
  const applied: string[] = []
  for (const name of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (done.has(name)) continue
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(MIGRATIONS, name), "utf8"))
      await tx`insert into indexer.migrations (name) values (${name})`
    })
    applied.push(name)
  }
  return applied
}
