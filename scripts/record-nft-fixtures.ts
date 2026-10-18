// Records NFT test fixtures from Ink and OpenSea: chain logs, REST responses and Stream frames.
// Usage: OPENSEA_API_KEY=<key> INK_RPC=<http rpc url> pnpm tsx scripts/record-nft-fixtures.ts [--only <step,step>]
//        INK_RPC=<http rpc url> pnpm tsx scripts/record-nft-fixtures.ts --chimera
//        INK_RPC=<http rpc url> pnpm tsx scripts/record-nft-fixtures.ts --matched <tx hash>
// --chimera records the Chimera factory's campaign logs from its deployment block to head. It needs only the RPC.
// --matched records every log of one Seaport transaction in which two orders were matched, as seaport-matched.json. It needs only the RPC.
// Steps: collections, seaport, erc1155, farm, rest, stream (all by default).
// Chain logs go to packages/sdk/test/fixtures/nft, OpenSea responses to apps/indexer/test/fixtures/opensea.
// Run it once while the key is valid, then commit the output. Every file is checked for the API key
// before it is written, and the script exits 1 if the key appears in one.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createPublicClient, decodeEventLog, type Hex, http, parseAbi } from "viem"
import { ink } from "viem/chains"

const CHIMERA_ONLY = process.argv.includes("--chimera")
const matchedArg = process.argv.indexOf("--matched")
const MATCHED_TX = matchedArg > 0 ? (process.argv[matchedArg + 1] ?? "") : ""
const KEY = process.env.OPENSEA_API_KEY ?? ""
if (!KEY && !CHIMERA_ONLY && !MATCHED_TX) throw new Error("OPENSEA_API_KEY is not set")
const RPC_URL = process.env.INK_RPC ?? "https://rpc-qnd.inkonchain.com"
const ROOT = join(import.meta.dirname, "..")
const CHAIN_DIR = join(ROOT, "packages/sdk/test/fixtures/nft")
const OPENSEA_DIR = join(ROOT, "apps/indexer/test/fixtures/opensea")
const ALL_STEPS = ["collections", "seaport", "erc1155", "farm", "rest", "stream"]
const onlyArg = process.argv.indexOf("--only")
const steps = new Set(onlyArg > 0 ? (process.argv[onlyArg + 1] ?? "").split(",") : ALL_STEPS)

const client = createPublicClient({
  chain: ink,
  transport: http(RPC_URL, {
    retryCount: 4,
    retryDelay: 500,
    timeout: 120_000,
    // A busy mint block can answer with tens of megabytes of logs.
    maxResponseBodySize: 512 * 1024 * 1024,
  }),
})
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const redact = (s: string) => (KEY ? s.replaceAll(KEY, "[key]") : s)

// ---- constants ----

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62"
const TRANSFER_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb"
const ZERO_TOPIC = `0x${"0".repeat(64)}` as Hex
const SEADROP = "0x00005ea00ac477b1030ce78506496e8c2de24bf5"
const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395"
const WETH = "0x4200000000000000000000000000000000000006"
const ORDER_FULFILLED = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31"
const BLOCKS_PER_DAY = 86_400
/** SeaDrop config events can come days before the first mint. */
const SEADROP_LOOKBACK = 3 * BLOCKS_PER_DAY
const SPAN = 10_000
const BURST_BLOCKS = 120
const BURST_CAP = 3_000

const ORDER_FULFILLED_ABI = parseAbi([
  "struct SpentItem { uint8 itemType; address token; uint256 identifier; uint256 amount; }",
  "struct ReceivedItem { uint8 itemType; address token; uint256 identifier; uint256 amount; address recipient; }",
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, SpentItem[] offer, ReceivedItem[] consideration)",
])

/** The four reference collections, with the window their mints are recorded over (UTC, end exclusive). */
const COLLECTIONS = {
  hornet: {
    address: "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b",
    slug: "ink-hornet",
    from: "2026-09-06",
    to: "2026-09-10",
    seadrop: true,
  },
  inkverse: {
    address: "0xfffbd67f37e1e9fd9d9ebef9b687daa72a33da64",
    slug: "inkverse-920024436",
    from: "2026-10-14",
    to: "2026-10-15",
    seadrop: true,
  },
  prtscn: {
    address: "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448",
    slug: "prtscn-ink",
    from: "2026-09-09",
    to: "2026-09-10",
    seadrop: false,
  },
  wired: {
    address: "0x7c701c0148e0e965065aa05e008ac9341e6efc6c",
    slug: "wiredonink",
    from: "",
    to: "",
    seadrop: false,
  },
} as const
const CHIMERA_FACTORY = "0xa66c05f14e79f40952531c20de0b60282e3800be"
const CHIMERA_FACTORY_START_BLOCK = 57_096_880
const CAMPAIGN_CREATED = "0x001b4892649817454e3dcb90d0d534ad709c098776f4f6de335baf16506299b3"
const BURST_ADDRESS = "0x165dcae7953657e23035c96503b2a5b51ddfa4cd"

// ---- output ----

const writtenFiles: string[] = []

/** Writes a fixture, refusing to save anything that contains the API key. */
function save(path: string, text: string) {
  if (KEY && text.includes(KEY)) {
    console.error(`refusing to write ${path}: it contains the API key`)
    process.exit(1)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  writtenFiles.push(path)
}

type SavedLog = {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  blockHash: string
  transactionHash: string
  logIndex: number
}
type RpcLogLike = {
  address: string
  topics: readonly string[]
  data: string
  blockNumber: string | null
  blockHash: string | null
  transactionHash: string | null
  logIndex: string | null
}

function toSaved(l: RpcLogLike): SavedLog {
  if (!l.blockNumber || !l.blockHash || !l.transactionHash || l.logIndex === null)
    throw new Error("pending log")
  return {
    address: l.address.toLowerCase(),
    topics: [...l.topics],
    data: l.data,
    blockNumber: BigInt(l.blockNumber).toString(),
    blockHash: l.blockHash.toLowerCase(),
    transactionHash: l.transactionHash.toLowerCase(),
    logIndex: Number(l.logIndex),
  }
}

const position = (l: SavedLog) => [BigInt(l.blockNumber), l.logIndex] as const
function sortLogs(logs: SavedLog[]): SavedLog[] {
  const seen = new Set<string>()
  return logs
    .filter((l) => {
      const k = `${l.transactionHash}:${l.logIndex}`
      return !seen.has(k) && seen.add(k)
    })
    .sort((a, b) => {
      const [ab, ai] = position(a)
      const [bb, bi] = position(b)
      return ab === bb ? ai - bi : ab < bb ? -1 : 1
    })
}

/** One log per line, so a fixture diffs and reads well. */
const logsJson = (logs: SavedLog[]) =>
  `[\n${sortLogs(logs)
    .map((l) => `  ${JSON.stringify(l)}`)
    .join(",\n")}\n]\n`

// ---- chain access ----

type Filter = { address?: string; topics: (string | string[] | null)[] }
const hex = (n: number | bigint) => `0x${n.toString(16)}` as Hex

/** One eth_getLogs call; a span the node refuses is halved and asked again. */
async function getLogsSpan(from: number, to: number, filter: Filter): Promise<RpcLogLike[]> {
  try {
    return (await client.request({
      method: "eth_getLogs",
      params: [{ ...filter, fromBlock: hex(from), toBlock: hex(to) } as never],
    })) as RpcLogLike[]
  } catch (err) {
    if (to - from < 200) throw err
    const mid = Math.floor((from + to) / 2)
    console.log(`  span ${from}-${to} refused; splitting`)
    return [...(await getLogsSpan(from, mid, filter)), ...(await getLogsSpan(mid + 1, to, filter))]
  }
}

/** Walks [from, to] in sequential spans, handing each span's logs to `each`. */
async function scan(
  from: number,
  to: number,
  filter: Filter,
  each: (logs: RpcLogLike[]) => boolean | undefined,
) {
  for (let a = from; a <= to; a += SPAN) {
    const logs = await getLogsSpan(a, Math.min(a + SPAN - 1, to), filter)
    if (each(logs) === false) return
  }
}

async function collect(from: number, to: number, filter: Filter): Promise<SavedLog[]> {
  const out: SavedLog[] = []
  await scan(from, to, filter, (logs) => {
    for (const l of logs) out.push(toSaved(l))
  })
  return out
}

const headBlock = async () => Number(await client.getBlockNumber({ cacheTime: 0 }))

async function timestampOf(block: number): Promise<number> {
  const b = (await client.request({
    method: "eth_getBlockByNumber",
    params: [hex(block), false],
  })) as { timestamp: Hex }
  return Number(BigInt(b.timestamp))
}

/** First block whose timestamp is at or after the UTC time. */
async function blockAt(iso: string, head: number): Promise<number> {
  const t = Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000)
  let lo = 1
  let hi = head
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((await timestampOf(mid)) < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}` as Hex
const mintFilter = (address: string): Filter => ({ address, topics: [TRANSFER, ZERO_TOPIC] })
const is721 = (l: RpcLogLike | SavedLog) => l.topics.length === 4

// ---- chain fixtures ----

async function recordCollections() {
  const head = await headBlock()
  const counts: Record<string, string> = {}

  // Mints of a SeaDrop collection come with its SeaDropMint and config events.
  const seaDropLogs = (address: string, from: number, to: number) =>
    collect(from - SEADROP_LOOKBACK, to, { address: SEADROP, topics: [null, pad(address)] })

  for (const [name, c] of Object.entries(COLLECTIONS)) {
    if (name === "wired") continue
    const from = await blockAt(c.from, head)
    const to = (await blockAt(c.to, head)) - 1
    console.log(`${name}: blocks ${from}-${to}`)
    const mints = (await collect(from, to, mintFilter(c.address))).filter(is721)
    const logs = c.seadrop ? [...mints, ...(await seaDropLogs(c.address, from, to))] : mints
    save(join(CHAIN_DIR, `${name}-mints.json`), logsJson(logs))
    counts[name] = `${mints.length} mints, ${logs.length - mints.length} SeaDrop logs`
  }

  // WIRED: one day of mints and burns.
  {
    const w = COLLECTIONS.wired
    const search = head - 14 * BLOCKS_PER_DAY
    let firstMint = 0
    await scan(search, head, mintFilter(w.address), (logs) => {
      const l = logs.find(is721)
      if (l) firstMint = Number(BigInt(l.blockNumber as string))
      return !l
    })
    if (!firstMint) throw new Error("no WIRED mint in the last 14 days")
    // The second day after the first mint: a full day of both, at a size a fixture can hold.
    const start = firstMint + BLOCKS_PER_DAY
    const end = start + BLOCKS_PER_DAY - 1
    const mints = (await collect(start, end, mintFilter(w.address))).filter(is721)
    const burns = (
      await collect(start, end, {
        address: w.address,
        topics: [TRANSFER, null, ZERO_TOPIC],
      })
    ).filter(is721)
    save(join(CHAIN_DIR, "wired-transfers.json"), logsJson([...mints, ...burns]))
    counts.wired = `${mints.length} mints, ${burns.length} burns`
  }

  // The burst collection: its first two minutes of mints, capped.
  {
    const search = head - 6 * BLOCKS_PER_DAY
    let first = 0
    await scan(search, head, mintFilter(BURST_ADDRESS), (logs) => {
      const l = logs.find(is721)
      if (l) first = Number(BigInt(l.blockNumber as string))
      return !l
    })
    if (!first) throw new Error("no burst-collection mint in the last 6 days")
    const end = first + BURST_BLOCKS
    const mints = (await collect(first, end, mintFilter(BURST_ADDRESS))).filter(is721)
    const capped = sortLogs(mints).slice(0, BURST_CAP)
    const lastBlock = Number(BigInt(capped.at(-1)?.blockNumber ?? first))
    const config = await seaDropLogs(BURST_ADDRESS, first, lastBlock)
    save(join(CHAIN_DIR, "burst-mints.json"), logsJson([...capped, ...config]))
    counts.burst = `${capped.length} of ${mints.length} mints, ${config.length} SeaDrop logs`
  }
  console.log("collections:", counts)
}

type Item = { itemType: number; token: string }
type Fill = { block: number; tx: string; offer: Item[]; consideration: Item[] }

async function recordSeaport() {
  const head = await headBlock()
  const byTx = new Map<string, Fill[]>()
  let total = 0
  await scan(
    head - 30 * BLOCKS_PER_DAY,
    head,
    { address: SEAPORT, topics: [ORDER_FULFILLED] },
    (logs) => {
      for (const l of logs) {
        const d = decodeEventLog({
          abi: ORDER_FULFILLED_ABI,
          data: l.data as Hex,
          topics: l.topics as [Hex, ...Hex[]],
        }).args as unknown as { offer: Item[]; consideration: Item[] }
        const items = (xs: Item[]) =>
          xs.map((i) => ({ itemType: Number(i.itemType), token: i.token.toLowerCase() }))
        const tx = (l.transactionHash as string).toLowerCase()
        const fill = {
          block: Number(BigInt(l.blockNumber as string)),
          tx,
          offer: items(d.offer),
          consideration: items(d.consideration),
        }
        byTx.set(tx, [...(byTx.get(tx) ?? []), fill])
        total++
      }
    },
  )
  console.log(`seaport: ${total} fills in ${byTx.size} transactions`)

  const nft = (i: Item) => i.itemType === 2 || i.itemType === 3
  const latest = (pick: (fills: Fill[]) => boolean) =>
    [...byTx.values()].filter(pick).sort((a, b) => b[0]!.block - a[0]!.block)[0]?.[0]?.tx ?? null
  const nftCount = (f: Fill) => [...f.offer, ...f.consideration].filter(nft).length
  const roles = {
    sweep: latest((f) => f.length === 50),
    listing: latest(
      (f) =>
        f.length === 1 &&
        f[0]!.offer.length === 1 &&
        f[0]!.offer[0]!.itemType === 2 &&
        f[0]!.consideration.some((i) => i.itemType === 0),
    ),
    offer: latest(
      (f) =>
        f.length === 1 &&
        f[0]!.offer.length === 1 &&
        f[0]!.offer[0]!.itemType === 1 &&
        f[0]!.offer[0]!.token === WETH &&
        f[0]!.consideration.some((i) => i.itemType === 2),
    ),
    // One order carrying several NFTs if any exists; else a transaction that fills a few orders over more than one collection.
    multi:
      latest((f) => f.length === 1 && nftCount(f[0]!) >= 2) ??
      latest(
        (f) =>
          f.length >= 2 &&
          f.length <= 5 &&
          new Set(
            f.flatMap((x) => [...x.offer, ...x.consideration].filter(nft).map((i) => i.token)),
          ).size >= 2,
      ),
    unsupportedErc20: latest(
      (f) =>
        f.length === 1 &&
        [...f[0]!.offer, ...f[0]!.consideration].some((i) => i.itemType === 1 && i.token !== WETH),
    ),
  }
  const multiIsSingleOrder = roles.multi !== null && byTx.get(roles.multi)?.length === 1
  const missing = Object.entries(roles)
    .filter(([, v]) => v === null)
    .map(([k]) => k)
  console.log("seaport roles:", roles, missing.length ? `none found: ${missing}` : "")
  if (!roles.sweep || !roles.listing || !roles.offer)
    throw new Error("no sweep, listing or offer fill in 30 days")

  const logs: SavedLog[] = []
  for (const tx of new Set(Object.values(roles).filter((v): v is string => v !== null))) {
    const receipt = (await client.request({
      method: "eth_getTransactionReceipt",
      params: [tx as Hex],
    })) as unknown as { logs: RpcLogLike[] } | null
    if (!receipt) throw new Error(`no receipt for ${tx}`)
    for (const l of receipt.logs)
      if (l.address.toLowerCase() === SEAPORT && l.topics[0] === ORDER_FULFILLED)
        logs.push(toSaved(l))
  }
  save(join(CHAIN_DIR, "seaport-fills.json"), logsJson(logs))
  save(
    join(CHAIN_DIR, "seaport-roles.json"),
    `${JSON.stringify({ ...roles, multiIsSingleOrder }, null, 2)}\n`,
  )
}

async function recordErc1155() {
  const head = await headBlock()
  let single: SavedLog | undefined
  let batch: SavedLog | undefined
  for (let to = head; to > head - 5 * BLOCKS_PER_DAY && !(single && batch); to -= SPAN) {
    const from = to - SPAN + 1
    if (!single) {
      const l = (await getLogsSpan(from, to, { topics: [TRANSFER_SINGLE, null, ZERO_TOPIC] }))[0]
      if (l) single = toSaved(l)
    }
    if (!batch) {
      const l = (await getLogsSpan(from, to, { topics: [TRANSFER_BATCH, null, ZERO_TOPIC] }))[0]
      if (l) batch = toSaved(l)
    }
  }
  if (!single || !batch) throw new Error("no ERC-1155 mint of both kinds in 5 days")
  save(join(CHAIN_DIR, "erc1155-mints.json"), logsJson([single, batch]))
  console.log(`erc1155: single in block ${single.blockNumber}, batch in block ${batch.blockNumber}`)
}

/** The recipient sets of the 10 largest mint bursts of the last 5 days, and the wallets in 5 or more of them. */
async function recordFarmWallets() {
  const head = await headBlock()
  const ids = new Map<string, number>()
  const wallets: string[] = []
  const intern = (a: string) => {
    let i = ids.get(a)
    if (i === undefined) {
      i = wallets.length
      ids.set(a, i)
      wallets.push(a)
    }
    return i
  }
  const byContract = new Map<string, { blocks: number[]; to: number[] }>()
  let total = 0
  await scan(head - 5 * BLOCKS_PER_DAY, head, { topics: [TRANSFER, ZERO_TOPIC] }, (logs) => {
    for (const l of logs) {
      if (!is721(l)) continue
      total++
      const contract = l.address.toLowerCase()
      let s = byContract.get(contract)
      if (!s) {
        s = { blocks: [], to: [] }
        byContract.set(contract, s)
      }
      s.blocks.push(Number(BigInt(l.blockNumber as string)))
      s.to.push(intern(`0x${(l.topics[2] as string).slice(26)}`))
    }
  })
  console.log(`farm: ${total} mints over ${byContract.size} contracts`)

  const bursts = [...byContract]
    .map(([contract, s]) => {
      let start = 0
      let best = { count: 0, start: 0, end: 0 }
      for (let i = 0; i < s.blocks.length; i++) {
        while (s.blocks[start]! < s.blocks[i]! - (BURST_BLOCKS - 1)) start++
        if (i - start + 1 > best.count) best = { count: i - start + 1, start, end: i }
      }
      return { contract, s, best }
    })
    .sort((a, b) => b.best.count - a.best.count)
    .slice(0, 10)
  const sets = bursts.map(({ s, best }) => new Set(s.to.slice(best.start, best.end + 1)))
  const appearances = new Map<number, number>()
  for (const set of sets) for (const w of set) appearances.set(w, (appearances.get(w) ?? 0) + 1)
  const farm = [...appearances].filter(([, n]) => n >= 5).map(([w]) => wallets[w] as string)

  const out: Record<string, string[]> = {}
  bursts.forEach(({ contract }, i) => {
    out[contract] = [...(sets[i] as Set<number>)].map((w) => wallets[w] as string)
  })
  out.farmWallets = farm.sort()
  save(
    join(CHAIN_DIR, "farm-wallets.json"),
    `{\n${Object.entries(out)
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(",\n")}\n}\n`,
  )
  console.log(
    `farm: ${bursts.map((b) => `${b.contract.slice(0, 8)}=${b.best.count}`).join(" ")}; ${farm.length} farm wallets`,
  )
}

// ---- OpenSea REST ----

type Saved = { status: number; body: unknown }

async function openSea(path: string): Promise<Saved> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.opensea.io${path}`, {
      headers: { "x-api-key": KEY as string, accept: "application/json" },
    })
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 6) throw new Error(`OpenSea ${path} kept answering ${res.status}`)
      await sleep(1_000 * 2 ** attempt)
      continue
    }
    const text = await res.text()
    await sleep(300)
    try {
      return { status: res.status, body: JSON.parse(text) }
    } catch {
      return { status: res.status, body: text }
    }
  }
}

async function recordRest() {
  const savedJson = (name: string, r: Saved) =>
    save(join(OPENSEA_DIR, `${name}.json`), `${JSON.stringify(r, null, 2)}\n`)
  /** Saves a response that must be 200; a drops 404 is data, so it is saved by the caller. */
  const ok = async (name: string, path: string) => {
    const r = await openSea(path)
    if (r.status !== 200) throw new Error(`${path} answered ${r.status}`)
    savedJson(name, r)
    return r.body as Record<string, unknown>
  }

  const burstContract = await ok(
    `contract/${BURST_ADDRESS}`,
    `/api/v2/chain/ink/contract/${BURST_ADDRESS}`,
  )
  const targets = [
    ...Object.values(COLLECTIONS).map((c) => ({
      address: c.address as string,
      slug: c.slug as string,
    })),
    { address: BURST_ADDRESS as string, slug: String(burstContract.collection) },
  ]
  for (const { address, slug } of targets) {
    if (address !== BURST_ADDRESS) {
      const c = await ok(`contract/${address}`, `/api/v2/chain/ink/contract/${address}`)
      if (c.collection !== slug)
        throw new Error(`${address} belongs to ${String(c.collection)}, not ${slug}`)
    }
    await ok(`collections/${slug}`, `/api/v2/collections/${slug}`)
    await ok(`collections/${slug}/stats`, `/api/v2/collections/${slug}/stats`)
    savedJson(`drops/${slug}`, await openSea(`/api/v2/drops/${slug}`))
  }

  // One token per collection: the first one minted, from the chain fixtures.
  const firstToken = (file: string, address: string) => {
    const logs = JSON.parse(readFileSync(join(CHAIN_DIR, file), "utf8")) as SavedLog[]
    const mint = logs.find((l) => l.address === address && l.topics[0] === TRANSFER)
    if (!mint) throw new Error(`no mint of ${address} in ${file}`)
    return BigInt(mint.topics[3] as string).toString()
  }
  const files: [string, string][] = [
    [COLLECTIONS.hornet.address, "hornet-mints.json"],
    [COLLECTIONS.inkverse.address, "inkverse-mints.json"],
    [COLLECTIONS.prtscn.address, "prtscn-mints.json"],
    [COLLECTIONS.wired.address, "wired-transfers.json"],
    [BURST_ADDRESS, "burst-mints.json"],
  ]
  for (const [address, file] of files) {
    const id = firstToken(file, address)
    await ok(`nfts/${address}/${id}`, `/api/v2/chain/ink/contract/${address}/nfts/${id}`)
  }
  await ok(
    "collection-nfts/ink-hornet",
    `/api/v2/collection/${COLLECTIONS.hornet.slug}/nfts?limit=200`,
  )
  await ok("collections-new", "/api/v2/collections?chain=ink&order_by=created_date&limit=20")
  console.log(`rest: ${targets.length} collections recorded`)
}

// ---- OpenSea Stream ----

type Frame = { atMs: number; frame: string }

function connect(): { ws: WebSocket; frames: Frame[]; t0: number; opened: Promise<void> } {
  const ws = new WebSocket(`wss://stream-api.opensea.io/socket/websocket?token=${KEY}&vsn=2.0.0`)
  const frames: Frame[] = []
  const t0 = Date.now()
  ws.addEventListener("message", (ev) =>
    frames.push({ atMs: Date.now() - t0, frame: String(ev.data) }),
  )
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    // The event carries nothing worth keeping, and a message built from the URL would hold the key.
    ws.addEventListener("error", () => reject(new Error("stream connection failed")))
  })
  return { ws, frames, t0, opened }
}

/** Most frames of one topic and event kept in a fixture; the file notes how many arrived. */
const STREAM_FRAMES_PER_KIND = 40

/**
 * Frames as received (a Phoenix array: join ref, ref, topic, event, payload), one per line. With a
 * limit, only the first frames of each topic and event are kept, and `counts` says how many arrived.
 */
function framesJson(frames: Frame[], perKind = Number.POSITIVE_INFINITY): string {
  const counts: Record<string, number> = {}
  const kept = frames.filter((f) => {
    const [, , topic, event] = JSON.parse(f.frame) as [unknown, unknown, string, string]
    const kind = `${topic} ${event}`
    counts[kind] = (counts[kind] ?? 0) + 1
    return counts[kind] <= perKind
  })
  const lines = kept.map(
    (f) => `    ${JSON.stringify({ atMs: f.atMs, frame: JSON.parse(f.frame) })}`,
  )
  return `{\n  "counts": ${JSON.stringify(counts)},\n  "frames": [\n${lines.join(",\n")}\n  ]\n}\n`
}

const join_ = (i: number, slug: string) =>
  JSON.stringify([String(i), String(i), `collection:${slug}`, "phx_join", {}])

async function recordStream() {
  // The 51st join on one connection is refused.
  {
    const { ws, frames, opened } = connect()
    await opened
    for (let i = 1; i <= 51; i++) {
      ws.send(join_(i, `fixture-limit-${String(i).padStart(2, "0")}`))
      await sleep(100)
    }
    await sleep(5_000)
    ws.close()
    const refusals = frames.filter((f) => /"phx_reply".*"error"/.test(f.frame))
    save(join(OPENSEA_DIR, "stream/join-limit.json"), framesJson(frames))
    console.log(`stream: ${frames.length} replies to 51 joins, ${refusals.length} refused`)
  }

  // Five minutes of the four reference collections on one connection.
  const slugs = Object.values(COLLECTIONS).map((c) => c.slug)
  const { ws, frames, t0, opened } = connect()
  await opened
  slugs.forEach((s, i) => {
    ws.send(join_(i + 1, s))
  })
  const heartbeats: { sent: string; at: number }[] = []
  const beat = setInterval(() => {
    const sent = JSON.stringify([null, String(100 + heartbeats.length), "phoenix", "heartbeat", {}])
    heartbeats.push({ sent, at: Date.now() - t0 })
    ws.send(sent)
  }, 25_000)
  await sleep(5 * 60_000)
  clearInterval(beat)
  ws.close()
  save(join(OPENSEA_DIR, "stream/collections.json"), framesJson(frames, STREAM_FRAMES_PER_KIND))
  const first = heartbeats[0]
  const reply = frames.find((f) => f.frame.includes('"phoenix"') && f.frame.includes('"phx_reply"'))
  if (first && reply)
    save(
      join(OPENSEA_DIR, "stream/heartbeat.json"),
      `${JSON.stringify({ sent: JSON.parse(first.sent), reply: JSON.parse(reply.frame) }, null, 2)}\n`,
    )
  else console.log("stream: no heartbeat reply seen")
  console.log(`stream: ${frames.length} frames in 5 minutes`)
}

// ---- chimera ----

/** Every CampaignCreated log of the Chimera factory, plus one other factory log. Needs only the RPC. */
async function recordChimera() {
  const head = await headBlock()
  const campaigns = await collect(CHIMERA_FACTORY_START_BLOCK, head, {
    address: CHIMERA_FACTORY,
    topics: [CAMPAIGN_CREATED],
  })
  const everything = await collect(CHIMERA_FACTORY_START_BLOCK, head, {
    address: CHIMERA_FACTORY,
    topics: [],
  })
  const other = everything.find((l) => l.topics[0] !== CAMPAIGN_CREATED)
  if (!other) throw new Error("no non-campaign factory log found")
  save(join(CHAIN_DIR, "chimera-campaigns.json"), logsJson([...campaigns, other]))
  console.log(
    `chimera: ${campaigns.length} campaigns up to block ${head}, other log ${other.topics[0]}`,
  )
}

/** Every log of one transaction, for a fill that settles two matched orders. */
async function recordMatched(txHash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("--matched needs a transaction hash")
  const receipt = await client.getTransactionReceipt({ hash: txHash as Hex })
  const logs = receipt.logs.map((l) =>
    toSaved({ ...l, blockNumber: hex(l.blockNumber), logIndex: hex(l.logIndex) }),
  )
  save(join(CHAIN_DIR, "seaport-matched.json"), logsJson(logs))
  console.log(`matched: ${logs.length} logs of ${txHash} in block ${receipt.blockNumber}`)
}

// ---- main ----

function checkForKey(dir: string) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) checkForKey(p)
    else if (KEY && readFileSync(p, "utf8").includes(KEY)) {
      console.error(`${p} contains the API key`)
      process.exit(1)
    }
  }
}

try {
  if (MATCHED_TX) {
    await recordMatched(MATCHED_TX)
    console.log(`wrote ${writtenFiles.length} files`)
    process.exit(0)
  }
  if (CHIMERA_ONLY) {
    await recordChimera()
    console.log(`wrote ${writtenFiles.length} files`)
    process.exit(0)
  }
  const streamDone = steps.has("stream") ? recordStream() : Promise.resolve()
  streamDone.catch(() => {}) // surfaced below; keeps an early failure from being unhandled meanwhile
  if (steps.has("collections")) await recordCollections()
  if (steps.has("seaport")) await recordSeaport()
  if (steps.has("erc1155")) await recordErc1155()
  if (steps.has("farm")) await recordFarmWallets()
  if (steps.has("rest")) await recordRest()
  await streamDone
  for (const dir of [CHAIN_DIR, OPENSEA_DIR]) checkForKey(dir)
  console.log(`wrote ${writtenFiles.length} files`)
} catch (err) {
  console.error(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)))
  process.exit(1)
}
