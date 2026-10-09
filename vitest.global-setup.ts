import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import EmbeddedPostgres from "embedded-postgres"
import type { TestProject } from "vitest/node"

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

// CI sets DATABASE_URL (postgres service container). Locally we start a throwaway Postgres.
export default async function setup(project: TestProject) {
  if (process.env.DATABASE_URL) {
    project.provide("databaseUrl", process.env.DATABASE_URL)
    return
  }
  const port = 54329
  const pg = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), "ink-indexer-pg-")),
    user: "ink",
    password: "ink",
    port,
    persistent: false,
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase("ink_test")
  project.provide("databaseUrl", `postgres://ink:ink@localhost:${port}/ink_test`)
  return async () => {
    await pg.stop()
  }
}
