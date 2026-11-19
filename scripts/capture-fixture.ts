// Records a transaction's InkyPump logs, plus launch state and token supply at its block, as a test fixture.
// With --topics v4 it records the transaction's InkyPump, Uniswap v4 Swap and ERC-20 Transfer logs, the
// transaction's sender, and the StateView slot0 and liquidity of each pool a LaunchFinalized log names.
// With --topics inkfun it records the transaction's ink.fun logs and, for every curve it touches, the curve
// parameters, token supply, metadata URI, tokensSold and realQuote at the transaction's block.
// With --topics tsunami it records the transaction's Tsunami logs, the transaction's sender and, for every curve
// it touches, the token, the curve state, and the token's total supply and Riptide vault balance at the
// transaction's block, plus the curve state at the chain head when the fixture was recorded.
// With --topics hookit it records the transaction's Hookit logs, PoolManager Swap and Initialize logs and the
// ERC-20 Transfers of every Hookit token it touches, the transaction's sender, and for each of those tokens the
// total supply (at the block and the block before), the metadata URI and, for a bonding launch, launches(id).
// --topics hookit-history <name> <launchId> <fromBlock> <toBlock> [httpRpcUrl] records every bonding event of one
// launch in a block range with launches(id) at the last event's block.
// --topics hookit-state <name> <block> <poolId>... [--rpc url] records StateView slot0 and liquidity at a block.
// --topics hookit-config <name> <txHash>... records, for every Master launch in those transactions, what the
// launching factory's views answer (token, bitmask, quote, tick spacing, fee) at the launch block.
// --topics nftx <name> <txHash> <httpRpcUrl> [--ethereum] records the transaction's NFTX, Seaport and ERC-721 Transfer logs,
// its sender and target, the Listings reads of every item its listing logs name at the block before and at the block,
// and, for each collection it touches, the newest CollectionInitialized and PoolStateUpdated logs at or before it.
// --topics nftx-auction <name> <auction> <fromBlock> <toBlock> [--rpc url] records the factory's AuctionCreated log, every
// log the auction emitted (read in pages of 1,000 blocks), the creating transaction's sender and target, the floor token's
// totalSupply at creation, the checkpoint multicall at each in-range price update and at the end block, the plain reads
// at the end block, and the block times of the auction's phases.
// Usage: pnpm tsx scripts/capture-fixture.ts <name> <txHash> [httpRpcUrl] [--topics v4|inkfun|tsunami|hookit|nftx|nftx-auction]
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  CCA_AUCTION_TOPICS,
  CCA_FACTORY,
  CCA_TOPICS,
  type ChainLog,
  decodeCcaLog,
  decodeHookitLog,
  decodeInkfunLog,
  decodeLog,
  HOOKIT_BONDING_FACTORY,
  HOOKIT_LOG_TOPICS,
  HOOKIT_MASTER_FACTORIES,
  HOOKIT_TOPICS,
  INKFUN_LOG_TOPICS,
  type LaunchKey,
  type LaunchState,
  LOG_TOPICS,
  NFTX_FLETH,
  NFTX_HOOK,
  NFTX_LISTINGS,
  NFTX_LOCKER,
  NFTX_LOG_TOPICS,
  NFTX_ROYALTY_GATE,
  NFTX_TOPICS,
  NFTX_ZAPS,
  RIPTIDE_VAULT,
  readAuctionCheckpoint,
  readBalances,
  readClassicLaunches,
  readCurveSold,
  readInkfunLaunches,
  readLaunchStates,
  readMasterLaunchConfigs,
  readMetadataUris,
  readNftxListings,
  readTotalSupplies,
  readTsunamiCurves,
  SEAPORT_1_5,
  SEAPORT_1_6,
  SWAP_TOPIC,
  TRANSFER_TOPIC,
  TSUNAMI_LOG_TOPICS,
  TSUNAMI_TOPICS,
  tsunamiCurveAbi,
} from "@ink-indexer/sdk"
import {
  type Address,
  createPublicClient,
  decodeEventLog,
  type Hash,
  type Hex,
  http,
  pad,
  parseAbi,
  toHex,
} from "viem"
import { ink, mainnet } from "viem/chains"

// PoolManager `Initialize`.
const INITIALIZE_TOPIC: Hex = TSUNAMI_TOPICS.initialize
const argv = process.argv.slice(2)
const topicsAt = argv.indexOf("--topics")
const mode = topicsAt === -1 ? "inkypump" : argv.splice(topicsAt, 2)[1]
if (
  mode !== "inkypump" &&
  mode !== "v4" &&
  mode !== "inkfun" &&
  mode !== "tsunami" &&
  mode !== "hookit" &&
  mode !== "hookit-history" &&
  mode !== "hookit-state" &&
  mode !== "hookit-config" &&
  mode !== "nftx" &&
  mode !== "nftx-auction"
)
  throw new Error(`unknown --topics ${mode}`)
const ethereumAt = argv.indexOf("--ethereum")
const onEthereum = ethereumAt !== -1
if (onEthereum) argv.splice(ethereumAt, 1)
const rpcAt = argv.indexOf("--rpc")
const rpcFlag = rpcAt === -1 ? undefined : argv.splice(rpcAt, 2)[1]
const [name, txHash] = argv
const url =
  rpcFlag ??
  (mode.startsWith("hookit-") || mode === "nftx-auction" ? undefined : argv[2]) ??
  "https://rpc-gel.inkonchain.com"
if (!name || !txHash)
  throw new Error(
    "usage: capture-fixture.ts <name> <txHash> [httpRpcUrl] [--topics v4|inkfun|tsunami|hookit]",
  )
const client = createPublicClient({
  chain: onEthereum ? mainnet : ink,
  transport: http(url, { retryCount: 5 }),
})

const dir = join(import.meta.dirname, "../packages/sdk/test/fixtures")
mkdirSync(dir, { recursive: true })
const save = (fixture: object, summary: string) => {
  const json = JSON.stringify(fixture, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 2)
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, `${name}.json`), `${json}\n`)
  console.log(`wrote ${name}.json: ${summary}`)
}
const toChainLog = (l: {
  address: Address
  topics: readonly Hex[]
  data: Hex
  blockNumber: bigint
  blockHash: Hash
  transactionHash: Hash
  logIndex: number
}): ChainLog => ({
  address: l.address.toLowerCase() as Address,
  topics: [...l.topics],
  data: l.data,
  blockNumber: l.blockNumber,
  blockHash: l.blockHash,
  transactionHash: l.transactionHash,
  logIndex: l.logIndex,
})

if (mode === "hookit-history") {
  // <name> <launchId> <fromBlock> <toBlock>: the range is scanned in chunks the node accepts.
  const [, launchId, from, to] = argv
  if (!from || !to) throw new Error("usage: <name> <launchId> <fromBlock> <toBlock> [--rpc url]")
  const classic = [
    HOOKIT_TOPICS.classicLaunched,
    HOOKIT_TOPICS.bought,
    HOOKIT_TOPICS.sold,
    HOOKIT_TOPICS.drop,
    HOOKIT_TOPICS.graduated,
  ]
  const chunk = rpcFlag ? 9_999n : 999n
  const history: ChainLog[] = []
  for (let a = BigInt(from); a <= BigInt(to); a += chunk + 1n) {
    const found = await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: HOOKIT_BONDING_FACTORY,
          topics: [classic, pad(toHex(BigInt(launchId as string)), { size: 32 })],
          fromBlock: toHex(a),
          toBlock: toHex(a + chunk > BigInt(to) ? BigInt(to) : a + chunk),
        },
      ],
    })
    for (const l of found)
      history.push(
        toChainLog({
          ...l,
          blockNumber: BigInt(l.blockNumber as Hex),
          logIndex: Number(l.logIndex),
        } as Parameters<typeof toChainLog>[0]),
      )
  }
  const last = history.at(-1)
  if (!last) throw new Error("no events in range")
  const [at] = await readClassicLaunches(client, [BigInt(launchId as string)], last.blockNumber)
  save(
    {
      name,
      launchId: BigInt(launchId as string),
      blockNumber: last.blockNumber,
      logs: history,
      state: at,
    },
    `${history.length} logs`,
  )
  process.exit(0)
}

if (mode === "hookit-config") {
  // <name> <txHash>...
  const reads = []
  for (const hash of argv.slice(1) as Hash[]) {
    const receipt = await client.getTransactionReceipt({ hash })
    for (const l of receipt.logs) {
      const d = decodeHookitLog(l)
      const factory = l.address.toLowerCase() as Address
      if (d?.kind !== "masterLaunched" || !HOOKIT_MASTER_FACTORIES.has(factory)) continue
      const [config] = await readMasterLaunchConfigs(
        client,
        [{ factory, launchId: d.launchId }],
        receipt.blockNumber,
      )
      reads.push({
        txHash: hash,
        blockNumber: receipt.blockNumber,
        factory,
        launchId: d.launchId,
        config,
      })
    }
  }
  save({ name, reads }, `${reads.length} launch configurations`)
  process.exit(0)
}

if (mode === "hookit-state") {
  // <name> <block> <poolId>...
  const STATE_VIEW: Address = "0x76fd297e2d437cd7f76d50f01afe6160f86e9990"
  const stateViewAbi = parseAbi([
    "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  ])
  const at = BigInt(txHash)
  const pools = []
  for (const poolId of argv.slice(2) as Hash[]) {
    const [slot0, liquidity] = await client.multicall({
      allowFailure: false,
      blockNumber: at,
      contracts: [
        { address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] },
        { address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] },
      ],
    })
    pools.push({ poolId, sqrtPriceX96: slot0[0], tick: slot0[1], liquidity })
  }
  save({ name, blockNumber: at, pools }, `${pools.length} pools`)
  process.exit(0)
}

/** eth_getLogs with raw topics, which viem's getLogs does not take. */
async function rawLogs(params: {
  address?: Address
  topics: (Hex | Hex[] | null)[]
  fromBlock: bigint
  toBlock: bigint
}): Promise<ChainLog[]> {
  const found = await client.request({
    method: "eth_getLogs",
    params: [
      {
        ...(params.address ? { address: params.address } : {}),
        topics: params.topics,
        fromBlock: toHex(params.fromBlock),
        toBlock: toHex(params.toBlock),
      },
    ],
  })
  return found.map((l) =>
    toChainLog({
      ...l,
      blockNumber: BigInt(l.blockNumber as Hex),
      logIndex: Number(l.logIndex),
    } as Parameters<typeof toChainLog>[0]),
  )
}

const byPosition = (a: ChainLog, b: ChainLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

/**
 * The newest log at or before `toBlock`. A node that accepts a wide range answers in one request;
 * otherwise the range is scanned back in pages of `page` blocks.
 */
async function newestLog(
  params: { address?: Address; topics: (Hex | Hex[] | null)[] },
  toBlock: bigint,
  page: bigint,
  maxPages: number,
): Promise<ChainLog | null> {
  const wide = toBlock > 3_000_000n ? toBlock - 3_000_000n : 0n
  try {
    const logs = await rawLogs({ ...params, fromBlock: wide, toBlock })
    return logs.sort(byPosition).at(-1) ?? null
  } catch {
    // Fall through to paging.
  }
  for (let n = 0, hi = toBlock; n < maxPages && hi > 0n; n++, hi -= page) {
    const lo = hi - page + 1n > 0n ? hi - page + 1n : 0n
    const logs = await rawLogs({ ...params, fromBlock: lo, toBlock: hi })
    const last = logs.sort(byPosition).at(-1)
    if (last) return last
  }
  return null
}

if (mode === "nftx") {
  // <name> <txHash> <httpRpcUrl> [--ethereum]
  const hash = txHash as Hash
  const receipt = await client.getTransactionReceipt({ hash })
  const tx = await client.getTransaction({ hash })
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  const nftxEmitters = new Set<Address>([
    NFTX_LOCKER,
    NFTX_HOOK,
    NFTX_LISTINGS,
    NFTX_ROYALTY_GATE,
    NFTX_FLETH,
    ...NFTX_ZAPS,
  ])
  const isNftx = (l: { address: Address; topics: readonly Hex[] }) =>
    nftxEmitters.has(l.address.toLowerCase() as Address) ||
    (l.topics[0] !== undefined && NFTX_LOG_TOPICS.includes(l.topics[0]))
  const logs: ChainLog[] = receipt.logs
    .filter(
      (l) =>
        isNftx(l) ||
        l.address.toLowerCase() === SEAPORT_1_6 ||
        l.address.toLowerCase() === SEAPORT_1_5 ||
        (l.topics[0] === TRANSFER_TOPIC && l.topics.length === 4),
    )
    .map(toChainLog)

  // The items the Listings logs name, read before and at the block.
  const listingTopics: Hex[] = [
    NFTX_TOPICS.ListingsCreated,
    NFTX_TOPICS.ListingRelisted,
    NFTX_TOPICS.ListingFloorMultipleUpdated,
    NFTX_TOPICS.ListingsFilled,
    NFTX_TOPICS.ListingsCancelled,
    NFTX_TOPICS.ListingClosedAsStale,
  ]
  const abi = parseAbi([
    "struct Listing { address owner; uint40 created; uint32 duration; uint16 floorMultiple; }",
    "event ListingsCreated(address indexed _collection, uint256[] _tokenIds, Listing _listing, uint8 _listingType, uint256 _tokensRequired, uint256 _taxRequired, address _sender)",
    "event ListingRelisted(address indexed _collection, uint256 _tokenId, Listing _listing)",
    "event ListingFloorMultipleUpdated(address indexed _collection, uint256 _tokenId, uint32 _oldFloorMultiple, uint32 _newFloorMultiple)",
    "event ListingsFilled(address indexed _collection, uint256[][] _tokenIds, address _recipient)",
    "event ListingsCancelled(address indexed _collection, uint256[] _tokenIds)",
    "event ListingClosedAsStale(address indexed _collection, uint256 _tokenId, address _owner, uint256 _feesCaptured, uint256 _refunded)",
  ])
  const items = new Map<string, { collection: Address; tokenId: bigint }>()
  for (const l of logs) {
    if (!listingTopics.includes(l.topics[0] as Hex)) continue
    const ev = decodeEventLog({ abi, topics: l.topics as [Hex, ...Hex[]], data: l.data })
    const a = ev.args as Record<string, unknown>
    const collection = (a._collection as string).toLowerCase() as Address
    const ids: bigint[] =
      "_tokenIds" in a
        ? (a._tokenIds as (bigint | readonly bigint[])[]).flatMap((x) =>
            typeof x === "bigint" ? [x] : [...x],
          )
        : [a._tokenId as bigint]
    for (const tokenId of ids) items.set(`${collection}:${tokenId}`, { collection, tokenId })
  }
  const list = [...items.values()]
  const readAt = async (at: bigint) =>
    (await readNftxListings(client, list, at)).map((read, i) => ({ ...list[i], read }))
  const before = await readAt(receipt.blockNumber - 1n)
  const atBlock = await readAt(receipt.blockNumber)

  // Pool logs: the collection's opening and its newest price at or before the block.
  const collections = [
    ...new Set(
      logs
        .filter((l) => isNftx(l) && l.topics[1] !== undefined && l.topics.length > 1)
        .map((l) => `0x${l.topics[1]?.slice(26)}` as Address),
    ),
  ].filter((c) => !nftxEmitters.has(c))
  const page = onEthereum ? 10_000n : 999n
  const pools: ChainLog[] = []
  // Ink fixtures hold what they need in the transaction; only an Ethereum fixture looks back.
  for (const c of onEthereum ? collections : []) {
    const topic1 = pad(c, { size: 32 })
    const opened = await newestLog(
      { address: NFTX_LOCKER, topics: [NFTX_TOPICS.CollectionInitialized, topic1] },
      receipt.blockNumber,
      onEthereum ? 100_000n : page,
      onEthereum ? 300 : 100,
    )
    const price = await newestLog(
      { topics: [NFTX_TOPICS.PoolStateUpdated, topic1] },
      receipt.blockNumber,
      page,
      onEthereum ? 300 : 100,
    )
    for (const l of [opened, price])
      if (
        l &&
        !logs.some((k) => k.transactionHash === l.transactionHash && k.logIndex === l.logIndex)
      )
        pools.push(l)
  }
  save(
    {
      name,
      chainId: client.chain.id,
      txHash: hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      timestamp: Number(block.timestamp),
      from: tx.from.toLowerCase(),
      to: tx.to?.toLowerCase() ?? null,
      logs,
      pools,
      listings: { before, at: atBlock },
    },
    `${logs.length} logs, ${pools.length} pool logs, ${list.length} listing items`,
  )
  process.exit(0)
}

if (mode === "nftx-auction") {
  // <name> <auction> <fromBlock> <toBlock>
  const auction = (txHash as string).toLowerCase() as Address
  const [, , from, to] = argv
  if (!from || !to) throw new Error("usage: <name> <auction> <fromBlock> <toBlock> [--rpc url]")
  const factoryLogs: ChainLog[] = []
  const auctionLogs: ChainLog[] = []
  for (let a = BigInt(from); a <= BigInt(to); a += 1_000n) {
    const hi = a + 999n > BigInt(to) ? BigInt(to) : a + 999n
    factoryLogs.push(
      ...(await rawLogs({
        address: CCA_FACTORY,
        topics: [CCA_TOPICS.AuctionCreated, pad(auction, { size: 32 })],
        fromBlock: a,
        toBlock: hi,
      })),
    )
    auctionLogs.push(
      ...(await rawLogs({
        address: auction,
        topics: [[...CCA_AUCTION_TOPICS]],
        fromBlock: a,
        toBlock: hi,
      })),
    )
  }
  const created = factoryLogs[0]
  if (!created) throw new Error("no AuctionCreated in range")
  const decoded = decodeCcaLog(created)
  if (decoded?.kind !== "auctionCreated") throw new Error("AuctionCreated does not decode")
  const tx = await client.getTransaction({ hash: created.transactionHash })
  const erc20 = parseAbi(["function totalSupply() view returns (uint256)"])
  const tokenSupply = await client.readContract({
    address: decoded.token,
    abi: erc20,
    functionName: "totalSupply",
    blockNumber: created.blockNumber,
  })
  const { startBlock, endBlock, claimBlock } = decoded.config
  const priceBlocks = [
    ...new Set(
      auctionLogs.flatMap((l) => {
        const d = decodeCcaLog(l)
        return d?.kind === "clearingPrice" &&
          d.checkpointBlock >= startBlock &&
          d.checkpointBlock <= endBlock
          ? [l.blockNumber]
          : []
      }),
    ),
  ]
  const checkpointBlocks = [...new Set([...priceBlocks, startBlock, endBlock, endBlock + 1n])]
  const checkpoints = []
  for (const b of checkpointBlocks)
    checkpoints.push({ block: b, read: await readAuctionCheckpoint(client, auction, b) })
  const plainAbi = parseAbi([
    "function currencyRaised() view returns (uint256)",
    "function totalCleared() view returns (uint256)",
    "function isGraduated() view returns (bool)",
    "function clearingPrice() view returns (uint256)",
    "function lastCheckpointedBlock() view returns (uint64)",
  ])
  const plain: Record<string, unknown> = {}
  for (const fn of [
    "currencyRaised",
    "totalCleared",
    "isGraduated",
    "clearingPrice",
    "lastCheckpointedBlock",
  ] as const)
    plain[fn] = await client.readContract({
      address: auction,
      abi: plainAbi,
      functionName: fn,
      blockNumber: endBlock,
    })
  const times: Record<string, number> = {}
  for (const b of new Set([created.blockNumber, startBlock, endBlock, claimBlock, ...priceBlocks]))
    times[String(b)] = Number((await client.getBlock({ blockNumber: b })).timestamp)
  save(
    {
      name,
      chainId: client.chain.id,
      auction,
      created,
      from: tx.from.toLowerCase(),
      to: tx.to?.toLowerCase() ?? null,
      tokenSupplyAtCreation: tokenSupply,
      logs: auctionLogs,
      checkpoints,
      plainAtEnd: { block: endBlock, ...plain },
      blockTimes: times,
    },
    `${auctionLogs.length} auction logs, ${checkpoints.length} checkpoint reads`,
  )
  process.exit(0)
}

const kept: Hex[] =
  mode === "inkfun"
    ? [...INKFUN_LOG_TOPICS]
    : mode === "tsunami"
      ? [...TSUNAMI_LOG_TOPICS]
      : mode === "v4"
        ? [...LOG_TOPICS, SWAP_TOPIC, TRANSFER_TOPIC]
        : mode === "hookit"
          ? [...HOOKIT_LOG_TOPICS, SWAP_TOPIC, TRANSFER_TOPIC, INITIALIZE_TOPIC]
          : [...LOG_TOPICS]
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

if (mode === "hookit") {
  // A Hookit token answers metadataURI(); the Transfer emitters that do are the tokens the transaction touches.
  const emitters = [
    ...new Set(logs.filter((l) => l.topics[0] === TRANSFER_TOPIC).map((l) => l.address)),
  ]
  const uris = await readMetadataUris(client, emitters, block.number)
  const tokens = emitters.filter((_, i) => uris[i] !== null)
  const tokenUris = uris.filter((u) => u !== null)
  const hookitLogs = logs.filter(
    (l) => l.topics[0] !== TRANSFER_TOPIC || tokens.includes(l.address),
  )
  const supplies = await readTotalSupplies(client, tokens, block.number)
  const suppliesBefore = await readTotalSupplies(client, tokens, block.number - 1n).catch(
    () => null,
  )
  const classicIds = [
    ...new Set(
      hookitLogs.flatMap((l) =>
        l.address === HOOKIT_BONDING_FACTORY && l.topics[1] ? [BigInt(l.topics[1])] : [],
      ),
    ),
  ]
  const launches = await readClassicLaunches(client, classicIds, block.number)
  const launchesBefore = await readClassicLaunches(client, classicIds, block.number - 1n).catch(
    () => null, // the launch did not exist yet
  )
  save(
    {
      name,
      txHash: receipt.transactionHash,
      blockNumber: block.number,
      blockHash: block.hash,
      timestamp: Number(block.timestamp),
      logs: hookitLogs,
      sender: receipt.from.toLowerCase(),
      tokens: tokens.map((token, i) => ({
        token,
        metadataURI: tokenUris[i],
        totalSupply: supplies[i],
        totalSupplyBefore: suppliesBefore?.[i] ?? null,
      })),
      classic: classicIds.map((id, i) => ({
        id,
        at: launches[i],
        before: launchesBefore?.[i] ?? null,
      })),
    },
    `${hookitLogs.length} logs, ${tokens.length} tokens, ${classicIds.length} bonding launches`,
  )
  process.exit(0)
}

if (mode === "inkfun") {
  const curveAbi = parseAbi([
    "function token() view returns (address)",
    "function realQuote() view returns (uint256)",
  ])
  const curves = [
    ...new Set(
      logs.flatMap((l) => {
        const d = decodeInkfunLog(l)
        return d?.kind === "launchCreated" ? [d.curve] : d ? [l.address] : []
      }),
    ),
  ]
  const tokens = await client.multicall({
    allowFailure: false,
    blockNumber: block.number,
    contracts: curves.map((c) => ({ address: c, abi: curveAbi, functionName: "token" }) as const),
  })
  const pairs = curves.map((curve, i) => ({
    curve,
    token: (tokens[i] as Address).toLowerCase() as Address,
  }))
  const states = await readInkfunLaunches(client, pairs, block.number)
  const sold = await readCurveSold(client, curves, block.number)
  const realQuotes = await client.multicall({
    allowFailure: false,
    blockNumber: block.number,
    contracts: curves.map(
      (c) => ({ address: c, abi: curveAbi, functionName: "realQuote" }) as const,
    ),
  })
  save(
    {
      name,
      txHash: receipt.transactionHash,
      blockNumber: block.number,
      blockHash: block.hash,
      timestamp: Number(block.timestamp),
      logs,
      curves: pairs.map((p, i) => ({
        ...p,
        params: states[i]?.curve,
        lpSupply: states[i]?.lpSupply,
        totalSupply: states[i]?.totalSupply,
        metadataURI: states[i]?.metadataURI,
        sold: sold[i],
        realQuote: realQuotes[i],
      })),
    },
    `${logs.length} logs, ${curves.length} curves`,
  )
  process.exit(0)
}

if (mode === "tsunami") {
  const emitted = new Set<string>([
    TSUNAMI_TOPICS.bought,
    TSUNAMI_TOPICS.sold,
    TSUNAMI_TOPICS.migrated,
  ])
  const launched = new Set<string>([TSUNAMI_TOPICS.launched, TSUNAMI_TOPICS.launchedLegacy])
  const curves = [
    ...new Set(
      logs.flatMap((l) => {
        const t0 = l.topics[0] ?? ""
        if (emitted.has(t0)) return [l.address]
        if (launched.has(t0) && l.topics[1]) return [`0x${l.topics[1].slice(26)}` as Address]
        return []
      }),
    ),
  ]
  const tokens = (await client.multicall({
    allowFailure: false,
    blockNumber: block.number,
    contracts: curves.map(
      (c) => ({ address: c, abi: tsunamiCurveAbi, functionName: "token" }) as const,
    ),
  })) as Address[]
  const pairs = curves.map((curve, i) => ({
    curve,
    token: (tokens[i] as Address).toLowerCase() as Address,
  }))
  const at = await readTsunamiCurves(client, curves, block.number)
  const head = await client.getBlockNumber()
  const atHead = await readTsunamiCurves(client, curves, head)
  const supplies = await readTotalSupplies(
    client,
    pairs.map((p) => p.token),
    block.number,
  )
  const vault = await readBalances(
    client,
    pairs.map((p) => ({ token: p.token, holder: RIPTIDE_VAULT })),
    block.number,
  )
  const supplyNow = await readTotalSupplies(
    client,
    pairs.map((p) => p.token),
    head,
  )
  save(
    {
      name,
      txHash: receipt.transactionHash,
      blockNumber: block.number,
      blockHash: block.hash,
      timestamp: Number(block.timestamp),
      logs,
      sender: receipt.from.toLowerCase(),
      headBlock: head,
      curves: pairs.map((p, i) => ({
        ...p,
        state: at[i],
        totalSupply: supplies[i],
        vaultBalance: vault[i],
        stateAtHead: atHead[i],
        totalSupplyAtHead: supplyNow[i],
      })),
    },
    `${logs.length} logs, ${curves.length} curves`,
  )
  process.exit(0)
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
