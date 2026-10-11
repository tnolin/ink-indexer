// Records a transaction's InkyPump logs, plus launch state and token supply at its block, as a test fixture.
// Usage: pnpm tsx scripts/capture-fixture.ts <name> <txHash> [httpRpcUrl]
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type ChainLog,
  decodeLog,
  type LaunchKey,
  type LaunchState,
  LOG_TOPICS,
  readLaunchStates,
  readTotalSupplies,
} from "@ink-indexer/sdk"
import { type Address, createPublicClient, type Hash, type Hex, http } from "viem"
import { ink } from "viem/chains"

const [name, txHash, url = "https://rpc-gel.inkonchain.com"] = process.argv.slice(2)
if (!name || !txHash) throw new Error("usage: capture-fixture.ts <name> <txHash> [httpRpcUrl]")
const client = createPublicClient({ chain: ink, transport: http(url, { retryCount: 5 }) })

const receipt = await client.getTransactionReceipt({ hash: txHash as Hash })
const block = await client.getBlock({ blockNumber: receipt.blockNumber })
const logs: ChainLog[] = receipt.logs
  .filter((l) => l.topics[0] !== undefined && LOG_TOPICS.includes(l.topics[0]))
  .map((l) => ({
    address: l.address.toLowerCase() as Address,
    topics: [...l.topics] as Hex[],
    data: l.data,
    blockNumber: l.blockNumber,
    blockHash: l.blockHash,
    transactionHash: l.transactionHash,
    logIndex: l.logIndex,
  }))

const keys = new Map<string, LaunchKey>()
for (const l of logs) {
  const d = decodeLog(l)
  if (d && "launchId" in d)
    keys.set(`${l.address}:${d.launchId}`, { hook: l.address, launchId: d.launchId })
}
const states: (LaunchKey & { at: LaunchState; prev: LaunchState | null })[] = []
for (const key of keys.values()) {
  const [at] = await readLaunchStates(client, [key], block.number)
  const prev = await readLaunchStates(client, [key], block.number - 1n)
    .then((r) => r[0] ?? null)
    .catch(() => null) // the launch did not exist yet
  if (!at) throw new Error(`no state for ${key.hook}:${key.launchId}`)
  states.push({ ...key, at, prev })
}
const tokens = [...new Set(states.map((s) => s.at.token))]
const supplies = await readTotalSupplies(client, tokens, block.number)

const fixture = {
  name,
  txHash,
  blockNumber: block.number,
  blockHash: block.hash,
  timestamp: Number(block.timestamp),
  logs,
  states,
  totalSupplies: Object.fromEntries(tokens.map((t, i) => [t, supplies[i]])),
}
const dir = join(import.meta.dirname, "../packages/sdk/test/fixtures")
mkdirSync(dir, { recursive: true })
const json = JSON.stringify(fixture, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 2)
writeFileSync(join(dir, `${name}.json`), `${json}\n`)
console.log(`wrote ${name}.json: ${logs.length} logs, ${states.length} launches`)
