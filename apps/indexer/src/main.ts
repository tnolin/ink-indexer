import { parseArgs } from "node:util"
import { connect, migrate } from "@ink-indexer/db"
import { viemChain } from "./chain"
import { log } from "./log"
import { Indexer } from "./loop"
import { connectRpc, DEFAULT_WS_URLS, watchHeads } from "./rpc"
import { createShutdown } from "./shutdown"
import { createStallWatchdog } from "./stall"
import { createStore } from "./store"

const USAGE = "usage: main.ts start | backfill --from <block> [--to <block>]"
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string" }, to: { type: "string" } },
})
const [command] = positionals
if (command !== "start" && command !== "backfill") {
  console.error(USAGE)
  process.exit(2)
}
if (command === "backfill" && !values.from) {
  console.error(USAGE)
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
await migrate(sql)
const { client, heads, router } = await connectRpc(urls.length > 0 ? urls : DEFAULT_WS_URLS)
const indexer = new Indexer({
  chain: viemChain(client, router, { isStopping: shutdown.isStopping }),
  store,
  logger: log,
})
await indexer.init()

if (command === "backfill") {
  await indexer.backfill(BigInt(values.from!), values.to ? BigInt(values.to) : undefined)
  log("info", "backfill done", { from: values.from, to: values.to ?? "head" })
  await sql.end()
  process.exit(0)
}

const stopHeads = watchHeads(heads, () => {
  current = indexer.trigger().catch(shutdown.fail)
})
const stall = createStallWatchdog({
  getCursor: async () => (await store.getCursor())?.block ?? null,
  getHead: () => indexer.lastHead,
  now: Date.now,
  logger: log,
  onStall: () => void shutdown.abort("indexer exiting after stall; a supervisor should restart it"),
})
const stallTimer = setInterval(() => {
  stall.check().catch((err) => log("warn", "stall check failed", { error: String(err) }))
}, 30_000)
stallTimer.unref()
process.on("SIGINT", () => void shutdown.signal())
process.on("SIGTERM", () => void shutdown.signal())
log("info", "indexer started", { transports: router.ranges() })
