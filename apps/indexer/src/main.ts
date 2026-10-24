import { connect, migrate } from "@ink-indexer/db"
import { viemChain } from "./chain"
import { parseCli } from "./cli"
import { log } from "./log"
import { Indexer } from "./loop"
import { applyMark } from "./mark-cli"
import { connectRpc, DEFAULT_WS_URLS, watchHeads } from "./rpc"
import { initSentry } from "./sentry"
import { createShutdown } from "./shutdown"
import { inkypumpSource } from "./sources/inkypump/index"
import { nftSource } from "./sources/nft/index"
import { createCollectionsFromSales } from "./sources/nft/write"
import { startStallWatch } from "./stall"
import { createStore } from "./store"
import {
  createNftVerdictJob,
  logStarted,
  readNftSettings,
  readSources,
  readTickMinIntervalMs,
  type SourceSelection,
  startSourceServices,
} from "./wiring"

const cli = parseCli(process.argv.slice(2))
if (!cli.ok) {
  console.error(`${cli.reason}\n${cli.usage}`)
  process.exit(2)
}
let sources: SourceSelection
try {
  sources = readSources(process.env, log)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
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
const reporter = initSentry(process.env)

const tickMinIntervalMs = readTickMinIntervalMs(process.env, log)

const sql = connect(databaseUrl)
const store = createStore(sql)
let current: Promise<void> | undefined
let stopNft = () => {}
const shutdown = createShutdown({
  stop: () => {
    // The NFT and OpenSea parts first, then the chain loop.
    stopNft()
    stopHeads()
    clearInterval(stallTimer)
    indexer.stop()
    rpc.stats.stop()
  },
  inFlight: () => current,
  end: () => sql.end({ timeout: 5 }),
  exit: (code) => process.exit(code),
  logger: log,
  report: reporter,
})
/** For errors the OpenSea parts recover from. Failures cut short by a shutdown are not reported. */
const report = (err: unknown) => {
  if (!shutdown.isStopping()) reporter.capture(err)
}
let rpc: Awaited<ReturnType<typeof connectRpc>>
let indexer: Indexer
try {
  await migrate(sql)
  if (cli.command === "collections-from-sales") {
    const created = await createCollectionsFromSales(sql)
    log("info", "collections from sales created", { created })
    await sql.end()
    process.exit(0)
  }
  rpc = await connectRpc(urls.length > 0 ? urls : DEFAULT_WS_URLS)
  const chain = viemChain(rpc.client, rpc.router, { isStopping: shutdown.isStopping })
  if (cli.command === "mark") {
    const { historyStartBlock } = readNftSettings(process.env, log)
    const verdict = await createNftVerdictJob({ historyStartBlock, sql, store, chain, log })
    await applyMark({ sql, verdict }, { contract: cli.contract, value: cli.value })
    log("info", "mark applied", { contract: cli.contract, mark: cli.value })
    await sql.end()
    process.exit(0)
  }
  indexer = new Indexer({
    chain,
    store,
    logger: log,
    only: sources.groups,
    tickMinIntervalMs,
    sources: [inkypumpSource({ sql, chain, logger: log }), nftSource({ sql, chain, logger: log })],
  })
  await indexer.init()
  if (cli.command === "start")
    stopNft = (
      await startSourceServices(sources, { env: process.env, sql, store, chain, log, report })
    ).stop
} catch (err) {
  log("error", cli.command === "start" ? "startup failed" : `${cli.command} failed`, {
    error: err instanceof Error ? (err.stack ?? String(err)) : String(err),
  })
  reporter.capture(err)
  await reporter.flush(2000)
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}
const { heads, pollHeads, router } = rpc

if (cli.command === "backfill") {
  await indexer.backfill(cli.from, cli.to, cli.sources ?? sources.groups)
  log("info", "backfill done", {
    from: cli.from,
    to: cli.to ?? "head",
    sources: cli.sources?.join(",") ?? "all",
  })
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
rpc.stats.start()
const stallTimer = startStallWatch({ indexer, shutdown, logger: log })
process.on("SIGINT", () => void shutdown.signal())
process.on("SIGTERM", () => void shutdown.signal())
logStarted(log, { transports: router.ranges(), tickMinIntervalMs })
