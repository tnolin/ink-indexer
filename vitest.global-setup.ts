import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestProject } from "vitest/node"
import { testDatabaseUrl } from "./packages/db/src/testing"

const EXIT_EVENTS = ["exit", "beforeExit"] as const

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

// CI sets TEST_DATABASE_URL (postgres service container). Locally we start a throwaway Postgres.
// DATABASE_URL is the runtime database and is never used here: the tests drop the `indexer` schema.
export default async function setup(project: TestProject) {
  const url = testDatabaseUrl(process.env)
  if (url) {
    project.provide("databaseUrl", url)
    return
  }
  // embedded-postgres registers `exit` and `beforeExit` hooks; the latter calls process.exit(0),
  // which would replace the non-zero exit code vitest sets for failing tests. Both are dropped
  // once teardown has stopped the database. Its signal hooks stay.
  const hooksBefore = EXIT_EVENTS.map((e) => new Set<() => void>(process.listeners(e)))
  const { default: EmbeddedPostgres } = await import("embedded-postgres")
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
    EXIT_EVENTS.forEach((event, i) => {
      for (const hook of process.listeners(event)) {
        if (!hooksBefore[i]!.has(hook)) process.off(event, hook)
      }
    })
  }
}
