import { connect, migrate } from "@ink-indexer/db"
import { viemChain } from "./chain"
import { parseCli } from "./cli"
import { log } from "./log"
import { Indexer } from "./loop"
import { connectRpc, DEFAULT_WS_URLS, watchHeads } from "./rpc"
import { createShutdown } from "./shutdown"
import { startStallWatch } from "./stall"
import { createStore } from "./store"

const cli = parseCli(process.argv.slice(2))
if (!cli.ok) {
  console.error(`${cli.reason}\n${cli.usage}`)
  process.exit(2)
}
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error("DATABASE_URL is not set")
  process.exit(2)
}
const urls = (process.env.INK_RPC_WS_URLS ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean)

const sql = connect(databaseUrl)
const store = createStore(sql)
let current: Promise<void> | undefined
const shutdown = createShutdown({
  stop: () => {
    stopHeads()
    clearInterval(stallTimer)
  },
  inFlight: () => current,
  end: () => sql.end({ timeout: 5 }),
  exit: (code) => process.exit(code),
  logger: log,
})
let rpc: Awaited<ReturnType<typeof connectRpc>>
let indexer: Indexer
try {
  await migrate(sql)
  rpc = await connectRpc(urls.length > 0 ? urls : DEFAULT_WS_URLS)
  indexer = new Indexer({
    chain: viemChain(rpc.client, rpc.router, { isStopping: shutdown.isStopping }),
    store,
    logger: log,
  })
  await indexer.init()
} catch (err) {
  log("error", "startup failed", {
    error: err instanceof Error ? (err.stack ?? String(err)) : String(err),
  })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}
const { heads, pollHeads, router } = rpc

if (cli.command === "backfill") {
  await indexer.backfill(cli.from, cli.to)
  log("info", "backfill done", { from: cli.from, to: cli.to ?? "head" })
  await sql.end()
  process.exit(0)
}

const stopHeads = watchHeads(
  heads,
  () => {
    current = indexer.trigger().catch(shutdown.fail)
  },
  log,
  undefined,
  pollHeads,
)
const stallTimer = startStallWatch({ indexer, shutdown, logger: log })
process.on("SIGINT", () => void shutdown.signal())
process.on("SIGTERM", () => void shutdown.signal())
log("info", "indexer started", { transports: router.ranges() })
