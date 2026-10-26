// Records a block range of InkyPump chain data, and what the indexer loop makes of it, as a replayable fixture.
// Usage: INK_RPC=<http rpc url> pnpm tsx scripts/record-inkypump-range.ts --from <block> --to <block>
// Writes apps/indexer/test/fixtures/inkypump-range/calls.json (every Chain call and its answer) and
// golden.json (the indexer.events rows the loop wrote). The golden test replays calls.json through the
// loop and compares with golden.json.
// The database is TEST_DATABASE_URL when set (its `indexer` schema is dropped), else a throwaway Postgres.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetDb, testDatabaseUrl } from "@ink-indexer/db/testing"
import { type ChainLog, decodeLog, LOG_TOPICS, NATIVE_QUOTE_ASSET } from "@ink-indexer/sdk"
import EmbeddedPostgres from "embedded-postgres"
import type { Address } from "viem"
import { type Chain, viemChain } from "../apps/indexer/src/chain"
import type { Logger } from "../apps/indexer/src/log"
import { Indexer } from "../apps/indexer/src/loop"
import { connectRpc } from "../apps/indexer/src/rpc"
import { inkypumpSource } from "../apps/indexer/src/sources/inkypump/index"
import { createStore } from "../apps/indexer/src/store"

function flag(name: string): bigint {
  const i = process.argv.indexOf(`--${name}`)
  const v = process.argv[i + 1]
  if (i < 0 || !v || !/^\d+$/.test(v))
    throw new Error(`usage: record-inkypump-range.ts --from <block> --to <block>`)
  return BigInt(v)
}
const from = flag("from")
const to = flag("to")
if (from > to) throw new Error("--from must not exceed --to")
const rpcUrl = process.env.INK_RPC ?? "https://rpc-qnd.inkonchain.com"
const outDir = join(import.meta.dirname, "../apps/indexer/test/fixtures/inkypump-range")

/** Bigints are stored as "123n" strings, as in the SDK fixtures. */
const toJson = (v: unknown) =>
  `${JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x), 2)}\n`

const warnings: string[] = []
const logger: Logger = (level, msg) => {
  if (level === "warn" || level === "error") warnings.push(`${level}: ${msg}`)
}

const { client, router } = await connectRpc([rpcUrl], logger, { rank: false })
const live = viemChain(client, router, { logger })

/** launchId of every launch created in the range, per hook. */
const createdKeys = new Set<string>()
for (let next = from; next <= to; ) {
  const { logs, toBlock } = await live.getLogs(next, to, { topics: [LOG_TOPICS] })
  for (const l of logs) {
    const d = decodeLog(l)
    if (d?.kind === "launchCreated") createdKeys.add(`${l.address}:${d.launchId}`)
  }
  next = toBlock + 1n
}

/**
 * A trade, bond or metadata log for a launch created before `from` cannot be processed: the loop
 * only knows launches it has stored, and a fresh database holds none. Those logs are dropped from
 * the recording, so the recorded chain is a coherent slice that starts at `from`.
 */
let droppedOrphans = 0
function keep(l: ChainLog): boolean {
  const d = decodeLog(l)
  if (!d || d.kind === "launchCreated" || d.kind === "xstocksHookCreated") return true
  const ok = createdKeys.has(`${l.address}:${d.launchId}`)
  if (!ok) droppedOrphans++
  return ok
}

type Call = { method: string; args: unknown; result: unknown }
const calls: Call[] = []
const recording: Chain = {
  async getBlockNumber() {
    calls.push({ method: "getBlockNumber", args: [], result: to })
    return to
  },
  // The recorded range ends at `to`, which no transport has to be asked about.
  getTransportHeads: async () => [],
  async getBlock(n) {
    const result = await live.getBlock(n)
    calls.push({ method: "getBlock", args: [n], result })
    return result
  },
  async getLogs(a, b, filter) {
    const r = await live.getLogs(a, b, filter)
    const logs = r.logs.filter(keep)
    calls.push({ method: "getLogs", args: [a, b], result: { logs, toBlock: r.toBlock } })
    return { logs, toBlock: r.toBlock }
  },
  async readLaunchStates(keys, block) {
    const result = await live.readLaunchStates(keys, block)
    calls.push({ method: "readLaunchStates", args: [keys, block], result })
    return result
  },
  async readTotalSupplies(tokens, block) {
    const result = await live.readTotalSupplies(tokens, block)
    calls.push({ method: "readTotalSupplies", args: [tokens, block], result })
    return result
  },
  async readErc20Meta(token) {
    const result = await live.readErc20Meta(token)
    calls.push({ method: "readErc20Meta", args: [token], result })
    return result
  },
  // Only the NFT source, its verdict job and the stats job read mint stats, supplies, contract
  // code and token names, and the recording runs without them.
  readErc20Names: (tokens, block) => live.readErc20Names(tokens, block),
  readMintStats: (contract, minter, block) => live.readMintStats(contract, minter, block),
  readMaxSupply: (contract, block) => live.readMaxSupply(contract, block),
  readTotalSupplyAt: (contract, block) => live.readTotalSupplyAt(contract, block),
  hasCodeAt: (address, block) => live.hasCodeAt(address, block),
}

let stopDb = async () => {}
let databaseUrl = testDatabaseUrl(process.env)
if (!databaseUrl) {
  const port = 54331
  const pg = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), "ink-indexer-record-")),
    user: "ink",
    password: "ink",
    port,
    persistent: false,
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase("ink_record")
  databaseUrl = `postgres://ink:ink@localhost:${port}/ink_record`
  stopDb = () => pg.stop()
}

const sql = await resetDb(databaseUrl)
const indexer = new Indexer({
  chain: recording,
  store: createStore(sql),
  logger,
  sources: [inkypumpSource({ sql, chain: recording, logger })],
})
await indexer.init()
await indexer.backfill(from, to)

const events = await sql<
  {
    type: string
    entity: string
    payload: unknown
    block: bigint
    block_hash: string
    tx_hash: string
    log_index: number
    confirmed: boolean
  }[]
>`select type, entity, payload, block, block_hash, tx_hash, log_index, confirmed from indexer.events order by id`
await sql.end()
await stopDb()

const allLogs = new Map<string, ChainLog>()
const getLogsCalls: { from: bigint; to: bigint; toBlock: bigint; logs: number }[] = []
const rest: Call[] = []
for (const c of calls) {
  if (c.method === "getLogs") {
    const [a, b] = c.args as [bigint, bigint]
    const r = c.result as { logs: ChainLog[]; toBlock: bigint }
    for (const l of r.logs) allLogs.set(`${l.transactionHash}:${l.logIndex}`, l)
    getLogsCalls.push({ from: a, to: b, toBlock: r.toBlock, logs: r.logs.length })
  } else rest.push(c)
}
const sortedLogs = [...allLogs.values()].sort((x, y) =>
  x.blockNumber === y.blockNumber
    ? x.logIndex - y.logIndex
    : x.blockNumber < y.blockNumber
      ? -1
      : 1,
)
const unique = (method: string) => {
  const seen = new Set<string>()
  return rest
    .filter((c) => c.method === method)
    .filter((c) => {
      const k = toJson(c.args)
      return !seen.has(k) && seen.add(k)
    })
}

mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, "calls.json"),
  toJson({
    range: { from, to },
    head: to,
    getLogs: getLogsCalls,
    logs: sortedLogs,
    getBlock: unique("getBlock").map((c) => ({
      block: (c.args as [bigint])[0],
      result: c.result,
    })),
    readLaunchStates: unique("readLaunchStates").map((c) => {
      const [keys, block] = c.args as [unknown, bigint]
      return { keys, block, result: c.result }
    }),
    readTotalSupplies: unique("readTotalSupplies").map((c) => {
      const [tokens, block] = c.args as [Address[], bigint]
      return { tokens, block, result: c.result }
    }),
    readErc20Meta: unique("readErc20Meta").map((c) => ({
      token: (c.args as [Address])[0],
      result: c.result,
    })),
  }),
)
writeFileSync(
  join(outDir, "golden.json"),
  toJson(events.map((e) => ({ ...e, block: e.block.toString() }))),
)

const count = (t: string) => events.filter((e) => e.type === t).length
console.log(
  `range ${from}-${to}: ${sortedLogs.length} logs kept, ${droppedOrphans} dropped for launches created before the range`,
)
console.log(
  `golden: ${events.length} events (${count("launchpad.launch")} launches, ${count("launchpad.bond")} bonds, ${count("launchpad.trade")} trades)`,
)
const xstocks = events.filter(
  (e) => (e.payload as { quoteAsset: string }).quoteAsset !== NATIVE_QUOTE_ASSET,
)
const xstocksCount = (t: string) => xstocks.filter((e) => e.type === t).length
console.log(
  `xStocks: ${xstocksCount("launchpad.launch")} launches, ${xstocksCount("launchpad.bond")} bonds, ${xstocksCount("launchpad.trade")} trades`,
)
console.log(`${rest.length} state and block reads recorded`)
for (const w of new Set(warnings)) console.log(w)
