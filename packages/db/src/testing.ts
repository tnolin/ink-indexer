import { connect, migrate, type Sql } from "./index"

/** Drops the indexer schema and migrates from scratch. For tests only. */
export async function resetDb(url: string): Promise<Sql> {
  const sql = connect(url)
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  return sql
}
