import { connect, migrate, type Sql } from "./index"

/**
 * The database the tests may wipe: TEST_DATABASE_URL, never DATABASE_URL (the runtime database).
 * Undefined when unset or empty.
 */
export function testDatabaseUrl(env: Record<string, string | undefined>): string | undefined {
  return env.TEST_DATABASE_URL || undefined
}

/** Drops the indexer schema and migrates from scratch. For tests only. */
export async function resetDb(url: string): Promise<Sql> {
  const sql = connect(url)
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  return sql
}
