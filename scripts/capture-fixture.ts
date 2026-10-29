// Records a transaction's InkyPump logs, plus launch state and token supply at its block, as a test fixture.
// With --topics v4 it records the transaction's InkyPump, Uniswap v4 Swap and ERC-20 Transfer logs, the
// transaction's sender, and the StateView slot0 and liquidity of each pool a LaunchFinalized log names.
// Usage: pnpm tsx scripts/capture-fixture.ts <name> <txHash> [httpRpcUrl] [--topics v4]
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
  SWAP_TOPIC,
  TRANSFER_TOPIC,
} from "@ink-indexer/sdk"
import { type Address, createPublicClient, type Hash, type Hex, http, parseAbi } from "viem"
import { ink } from "viem/chains"

const argv = process.argv.slice(2)
const topicsAt = argv.indexOf("--topics")
const mode = topicsAt === -1 ? "inkypump" : argv.splice(topicsAt, 2)[1]
if (mode !== "inkypump" && mode !== "v4") throw new Error(`unknown --topics ${mode}`)
const [name, txHash, url = "https://rpc-gel.inkonchain.com"] = argv
if (!name || !txHash)
  throw new Error("usage: capture-fixture.ts <name> <txHash> [httpRpcUrl] [--topics v4]")
const client = createPublicClient({ chain: ink, transport: http(url, { retryCount: 5 }) })

const kept: Hex[] = mode === "v4" ? [...LOG_TOPICS, SWAP_TOPIC, TRANSFER_TOPIC] : [...LOG_TOPICS]
const receipt = await client.getTransactionReceipt({ hash: txHash as Hash })
const block = await client.getBlock({ blockNumber: receipt.blockNumber })
const logs: ChainLog[] = receipt.logs
  .filter((l) => l.topics[0] !== undefined && kept.includes(l.topics[0]))
  .map((l) => ({
    address: l.address.toLowerCase() as Address,
    topics: [...l.topics] as Hex[],
    data: l.data,
    blockNumber: l.blockNumber,
    blockHash: l.blockHash,
    transactionHash: l.transactionHash,
    logIndex: l.logIndex,
  }))

const dir = join(import.meta.dirname, "../packages/sdk/test/fixtures")
mkdirSync(dir, { recursive: true })
const save = (fixture: object, summary: string) => {
  const json = JSON.stringify(fixture, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 2)
  writeFileSync(join(dir, `${name}.json`), `${json}\n`)
  console.log(`wrote ${name}.json: ${summary}`)
}

if (mode === "v4") {
  const STATE_VIEW: Address = "0x76fd297e2d437cd7f76d50f01afe6160f86e9990"
  const stateViewAbi = parseAbi([
    "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  ])
  const poolIds = logs.flatMap((l) => {
    const d = decodeLog(l)
    return d?.kind === "launchFinalized" ? [d.poolId] : []
  })
  const pools = []
  for (const poolId of poolIds) {
    const [slot0, liquidity] = await client.multicall({
      allowFailure: false,
      blockNumber: block.number,
      contracts: [
        { address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] },
        { address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] },
      ],
    })
    pools.push({ poolId, sqrtPriceX96: slot0[0], liquidity })
  }
  save(
    {
      name,
      txHash: receipt.transactionHash,
      blockNumber: block.number,
      blockHash: block.hash,
      timestamp: Number(block.timestamp),
      logs,
      senders: { [receipt.transactionHash]: receipt.from.toLowerCase() },
      pools,
    },
    `${logs.length} logs, ${pools.length} pools`,
  )
  process.exit(0)
}

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
save(fixture, `${logs.length} logs, ${states.length} launches`)
