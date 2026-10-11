// Starts a persistent local Postgres in .data/postgres for running the indexer without Docker.
import { existsSync } from "node:fs"
import EmbeddedPostgres from "embedded-postgres"

const dir = ".data/postgres"
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "ink",
  password: "ink",
  port: 5432,
  persistent: true,
})
if (!existsSync(`${dir}/PG_VERSION`)) await pg.initialise()
await pg.start()
await pg.createDatabase("ink").catch(() => {})
console.log("Postgres ready: DATABASE_URL=postgres://ink:ink@localhost:5432/ink (Ctrl+C to stop)")
const stop = async () => {
  await pg.stop()
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
