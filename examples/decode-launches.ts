// Prints InkyPump V2 launches on the native hooks from the last 50,000 Ink blocks (about 14 hours).
// Run: pnpm tsx examples/decode-launches.ts   (set INK_RPC_HTTP_URL to use your own RPC)
import {
  decodeLog,
  type LaunchCreated,
  type LaunchMetadata,
  NATIVE_HOOKS,
  TOPICS,
} from "@ink-indexer/sdk"
import { createPublicClient, formatEther, http, toHex } from "viem"
import { ink } from "viem/chains"

const client = createPublicClient({
  chain: ink,
  transport: http(process.env.INK_RPC_HTTP_URL ?? "https://rpc-qnd.inkonchain.com"),
})
const head = await client.getBlockNumber()

for (let from = head - 49_999n; from <= head; from += 10_000n) {
  const to = from + 9_999n < head ? from + 9_999n : head
  const logs = await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: NATIVE_HOOKS.map((h) => h.address),
        fromBlock: toHex(from),
        toBlock: toHex(to),
        topics: [[TOPICS.launchCreated, TOPICS.launchMetadata]],
      },
    ],
  })
  const decoded = logs.map((l) => decodeLog({ topics: [...l.topics], data: l.data }))
  for (const c of decoded.filter((d): d is LaunchCreated => d?.kind === "launchCreated")) {
    const m = decoded.find(
      (d): d is LaunchMetadata => d?.kind === "launchMetadata" && d.launchId === c.launchId,
    )
    console.log(
      `${m?.ticker ?? "?"}\t${m?.name ?? ""}\ttoken ${c.token}\ttarget ${formatEther(c.targetRaise)} ETH`,
    )
  }
}
