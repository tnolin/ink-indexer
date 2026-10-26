import type { Sql } from "@ink-indexer/db"
import { type NftLaunchEvent, type NftSaleEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import {
  CHIMERA_FACTORY,
  type ChainLog,
  decodeChimeraCampaign,
  decodeNftTransfers,
  decodeOrderFulfilled,
  decodeSeaDropLog,
  INK_CHAIN_ID,
  mergeMatchedSales,
  NFT_TOPICS,
  SEADROP_V1,
  SEAPORT_1_5,
  SEAPORT_1_6,
  type SeaportSale,
  ZERO_TOPIC,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../../chain"
import { BlockNotServedError } from "../../errors"
import type { Logger } from "../../log"
import type { LogFilter } from "../../rpc"
import { seenItems } from "../opensea/listings"
import { cachedRanks, itemKey } from "../opensea/ranks"
import { latestFloors } from "../opensea/stats"
import { type EventRow, pick, type Source, type SourceBatch } from "../source"
import {
  loadMilestoneContexts,
  type MilestoneUpdate,
  milestoneBlocks,
  milestoneEvents,
  type StageRow,
} from "./milestones"
import { TIMESTAMP_READ_CONCURRENCY } from "./policy"
import { rollbackRows, writeRows } from "./write"

/** One token id of a mint or burn log. `idx` is its position among the log's transfers. */
export type TransferRow = {
  txHash: Hash
  logIndex: number
  idx: number
  contract: Address
  tokenId: bigint
  /** The recipient of a mint, the holder of a burn. */
  account: Address
  qty: bigint
  block: bigint
}
export type SeaDropMintRow = {
  txHash: Hash
  logIndex: number
  contract: Address
  minter: Address
  payer: Address
  qty: bigint
  unitPrice: bigint
  stage: number
  block: bigint
}
export type SeaDropConfigRow = {
  txHash: Hash
  logIndex: number
  contract: Address
  /** The event name when decoded, the first topic otherwise. */
  event: string
  fields: Record<string, string | number>
  block: bigint
}
export type SaleRow = {
  txHash: Hash
  logIndex: number
  contract: Address
  tokenId: bigint
  qty: bigint
  /** Wei for one unit. */
  priceWei: bigint
  currency: "ETH" | "WETH"
  buyer: Address
  seller: Address
  orderHash: Hash
  block: bigint
}
export type LaunchRow = {
  txHash: Hash
  logIndex: number
  collection: Address
  launchpad: "chimera"
  campaignId: bigint
  token: Address
  core: Address
  poolId: Hash
  rewards: Address
  vault: Address
  creator: Address
  block: bigint
}
/** What a batch learned about one contract: the input of its `nft_collections` upsert. */
export type CollectionTouch = {
  contract: Address
  standard: "erc721" | "erc1155" | null
  /** The earliest mint in the batch, with its block time in unix seconds. */
  firstMint: { block: bigint; ts: number } | null
  /** A SeaDrop log in the batch names the contract. */
  seadrop: boolean
  launch: { launchpad: "chimera"; token: Address; creator: Address } | null
}

export type NftBatch = SourceBatch & {
  mints: TransferRow[]
  burns: TransferRow[]
  seadropMints: SeaDropMintRow[]
  seadropConfig: SeaDropConfigRow[]
  sales: SaleRow[]
  launches: LaunchRow[]
  collections: CollectionTouch[]
  /** Stages whose first mint is in this batch. */
  stages: StageRow[]
  /** Per SeaDrop contract that had mint stats: the state the milestones leave it in. */
  milestones: MilestoneUpdate[]
  /** Every contract in `collections`: those with a mint, a burn, a sale, a SeaDrop log or a launch. */
  touched: Address[]
}

export type NftDeps = {
  sql: Sql
  chain: Pick<Chain, "getBlock" | "readMintStats" | "readTotalSupplyAt" | "readErc20Names">
  logger: Logger
}

const TRANSFER = NFT_TOPICS.transfer
const BATCHES = [NFT_TOPICS.transferSingle, NFT_TOPICS.transferBatch]

/**
 * Same order as the log arrays `process` receives. These are logical filters: the loop merges them
 * into fewer eth_getLogs requests (`planRequests`) and hands `process` the logs each would have
 * returned. With every group on, the seven become four requests:
 *
 * - `[Transfer, 0x0]`: mints (ERC-721), alone. No extra logs.
 * - `[[Transfer, TransferSingle, TransferBatch], null, 0x0]`: ERC-721 burns and ERC-1155 mints.
 *   topic0 is the only position that differs, so the response is exactly the union of the two
 *   filters. No extra logs.
 * - `[[TransferSingle, TransferBatch], null, null, 0x0]`: ERC-1155 burns, alone. No extra logs.
 * - the SeaDrop, Seaport and Chimera addresses with no topic restriction, because the SeaDrop filter
 *   reads every event of its contract. Extra logs: every event of the two Seaport contracts other
 *   than OrderFulfilled (cancellations, validations, counter increments, OrdersMatched) and every
 *   event of the Chimera factory other than CampaignCreated. They are rare next to token transfers
 *   and are dropped when the response is split. Without the SeaDrop filter (no `nft-mints`), topic0
 *   is restricted to OrderFulfilled and CampaignCreated and the extras shrink to the cross product
 *   of the addresses and those two topics, which is empty in practice.
 *
 * Mints and burns cannot share a request: they constrain different topic positions (from in topic1
 * against to in topic2), and ORing positions would fetch every transfer.
 */
const FILTERS: LogFilter[] = [
  { topics: [TRANSFER, ZERO_TOPIC] },
  { topics: [TRANSFER, null, ZERO_TOPIC] },
  { topics: [BATCHES, null, ZERO_TOPIC] },
  { topics: [BATCHES, null, null, ZERO_TOPIC] },
  { address: SEADROP_V1, topics: [] },
  { address: [SEAPORT_1_6, SEAPORT_1_5], topics: [NFT_TOPICS.orderFulfilled] },
  { address: CHIMERA_FACTORY, topics: [NFT_TOPICS.campaignCreated] },
]
/** The backfill name of each filter: `nft-mints` is the first five, then Seaport, then Chimera. */
const FILTER_GROUPS = [
  "nft-mints",
  "nft-mints",
  "nft-mints",
  "nft-mints",
  "nft-mints",
  "nft-sales",
  "nft-launches",
] as const
const [MINTS_721, BURNS_721, MINTS_1155, BURNS_1155, SEADROP, SEAPORT, CHIMERA] = [
  0, 1, 2, 3, 4, 5, 6,
] as const

/**
 * NFTs as a loop source: mints and burns (ERC-721 and ERC-1155), SeaDrop logs, Seaport sales and
 * Chimera campaigns. Rows go to the `nft_*` tables; each Seaport sale also becomes an `nft.sale` event.
 */
export function nftSource(deps: NftDeps): Source<NftBatch, null> {
  return {
    name: "nft",
    filters: (only) => FILTERS.map((f, i) => pick(only, FILTER_GROUPS[i]!, f)),
    process: (logs, ctx) => processLogs(logs, deps, ctx.toBlock),
    write: writeRows,
    prepareRollback: async () => null,
    rollback: (tx, fork) => rollbackRows(tx, fork),
    // No in-memory state.
    reload: async () => {},
  }
}

const s = (x: bigint) => x.toString()

export async function processLogs(
  logs: ChainLog[][],
  deps: NftDeps,
  toBlock: bigint,
): Promise<NftBatch> {
  const { logger } = deps
  const empty: ChainLog[] = []
  const at = (i: number) => logs[i] ?? empty
  const hashes = new Map<bigint, Hash>()
  const seen = (l: ChainLog) => hashes.set(l.blockNumber, l.blockHash)

  const mints: TransferRow[] = []
  const burns: TransferRow[] = []
  const standards = new Map<Address, "erc721" | "erc1155">()
  for (const l of [MINTS_721, BURNS_721, MINTS_1155, BURNS_1155].flatMap(at)) {
    decodeNftTransfers(l).forEach((t, idx) => {
      seen(l)
      standards.set(t.contract, t.standard)
      const row: TransferRow = {
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        idx,
        contract: t.contract,
        tokenId: t.tokenId,
        account: t.account,
        qty: t.qty,
        block: l.blockNumber,
      }
      ;(t.kind === "mint" ? mints : burns).push(row)
    })
  }

  const seadropMints: SeaDropMintRow[] = []
  const seadropConfig: SeaDropConfigRow[] = []
  const seadropContracts = new Set<Address>()
  for (const l of at(SEADROP)) {
    const d = decodeSeaDropLog(l)
    if (!d) {
      logger("warn", "ignoring a SeaDrop log that does not decode", {
        tx: l.transactionHash,
        logIndex: l.logIndex,
      })
      continue
    }
    seen(l)
    seadropContracts.add(d.contract)
    const pos = { txHash: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber }
    if (d.kind === "seadropMint") {
      seadropMints.push({
        ...pos,
        contract: d.contract,
        minter: d.minter,
        payer: d.payer,
        qty: d.qty,
        unitPrice: d.unitPrice,
        stage: d.stage,
      })
    } else if (d.kind === "publicDrop") {
      seadropConfig.push({
        ...pos,
        contract: d.contract,
        event: "PublicDropUpdated",
        fields: {
          mintPrice: s(d.mintPrice),
          startTime: d.startTime,
          endTime: d.endTime,
          maxPerWallet: d.maxPerWallet,
        },
      })
    } else {
      seadropConfig.push({ ...pos, contract: d.contract, event: d.topic0, fields: {} })
    }
  }

  // Matched orders (a buyer's offer filled against a seller's listing) log the same NFT twice in one
  // transaction. Merge them per transaction before building rows: one sale, at the offer's log.
  const byTx = new Map<Hash, (SeaportSale & { log: ChainLog })[]>()
  for (const l of at(SEAPORT))
    for (const sale of decodeOrderFulfilled(l)) {
      const items = byTx.get(l.transactionHash) ?? []
      items.push({ ...sale, log: l })
      byTx.set(l.transactionHash, items)
    }
  const byLog = new Map<ChainLog, (SeaportSale & { log: ChainLog })[]>()
  for (const items of byTx.values())
    for (const item of mergeMatchedSales(items)) {
      const forLog = byLog.get(item.log) ?? []
      forLog.push(item)
      byLog.set(item.log, forLog)
    }
  const saleLogs: { log: ChainLog; sales: SaleRow[] }[] = []
  for (const [l, items] of byLog) {
    seen(l)
    saleLogs.push({ log: l, sales: linesToSales(l, items) })
  }
  saleLogs.sort((a, b) =>
    a.log.blockNumber === b.log.blockNumber
      ? a.log.logIndex - b.log.logIndex
      : a.log.blockNumber < b.log.blockNumber
        ? -1
        : 1,
  )

  const launches: LaunchRow[] = []
  for (const l of at(CHIMERA)) {
    const d = decodeChimeraCampaign(l)
    if (!d) continue
    seen(l)
    launches.push({
      txHash: l.transactionHash,
      logIndex: l.logIndex,
      collection: d.collection,
      launchpad: "chimera",
      campaignId: d.campaignId,
      token: d.token,
      core: d.core,
      poolId: d.poolId,
      rewards: d.rewards,
      vault: d.vault,
      creator: d.creator,
      block: l.blockNumber,
    })
  }

  // Block times: the first mint block of each contract (for `first_mint_ts`) and every sale block,
  // one read per block.
  const firstMintBlock = new Map<Address, bigint>()
  for (const m of mints) {
    const b = firstMintBlock.get(m.contract)
    if (b === undefined || m.block < b) firstMintBlock.set(m.contract, m.block)
  }
  const milestoneContexts = await loadMilestoneContexts(deps.sql, seadropMints)
  const wanted = new Set<bigint>([
    ...firstMintBlock.values(),
    ...launches.map((l) => l.block),
    ...saleLogs.map((x) => x.log.blockNumber),
    ...milestoneBlocks(milestoneContexts),
  ])
  const times = await blockTimestamps(deps.chain, [...wanted])

  const collections = new Map<Address, CollectionTouch>()
  const touch = (contract: Address): CollectionTouch => {
    let c = collections.get(contract)
    if (!c) {
      c = { contract, standard: null, firstMint: null, seadrop: false, launch: null }
      collections.set(contract, c)
    }
    return c
  }
  for (const [contract, standard] of standards) touch(contract).standard = standard
  for (const [contract, block] of firstMintBlock)
    touch(contract).firstMint = { block, ts: times.get(block)! }
  for (const contract of seadropContracts) touch(contract).seadrop = true
  // A contract that only trades gets its row (and its discovery) from its first sale.
  for (const { sales } of saleLogs) for (const r of sales) touch(r.contract)
  // The first launch of a collection wins, as in nft_launches.
  for (const l of launches)
    touch(l.collection).launch ??= { launchpad: l.launchpad, token: l.token, creator: l.creator }

  const events: EventRow[] = []
  // Each campaign is a launch event. The token's names are read once for the batch, at its last
  // block: the token exists from its campaign's block on.
  const names = await readTokenNames(deps.chain, launches, toBlock)
  for (const l of launches)
    events.push({
      event: launchEvent(l, names.get(l.token), times.get(l.block)!),
      block: l.block,
      blockHash: hashes.get(l.block)!,
      sub: "",
    })
  // A sale carries the collection's latest known floor (a read of our own stats, no network).
  // shortcut: this is the floor when the sale is processed, not when it happened, so a replay of old
  // sales stamps today's floor on them. Read the newest row at or before the sale's time to fix it.
  const floors = await latestFloors(deps.sql, [
    ...new Set(saleLogs.flatMap((x) => x.sales.map((r) => r.contract))),
  ])
  // And the item's name, image and rank, from what the listings cached (no network; a sale never
  // fetches a rank). The same shortcut applies: the cache as it stands when the sale is processed.
  const soldItems = [
    ...new Map(
      saleLogs
        .flatMap((x) => x.sales)
        .map((r) => [
          itemKey(r.contract, s(r.tokenId)),
          { contract: r.contract, tokenId: s(r.tokenId) },
        ]),
    ).values(),
  ]
  const [ranks, listedItems] = await Promise.all([
    cachedRanks(deps.sql, soldItems, new Date()),
    seenItems(deps.sql, soldItems),
  ])
  const sales: SaleRow[] = []
  for (const { log, sales: rows } of saleLogs) {
    const ts = times.get(log.blockNumber)!
    // A sub is unique within its log: the token id, plus the contract when another contract
    // in the same order already used that id.
    const owner = new Map<bigint, Address>()
    for (const r of rows) {
      const first = owner.get(r.tokenId) ?? r.contract
      owner.set(r.tokenId, first)
      const sub = first === r.contract ? `sale:${r.tokenId}` : `sale:${r.tokenId}:${r.contract}`
      sales.push(r)
      events.push({
        event: saleEvent(r, ts, floors.get(r.contract) ?? null, {
          ...listedItems.get(itemKey(r.contract, s(r.tokenId))),
          rank: ranks.get(itemKey(r.contract, s(r.tokenId))),
        }),
        block: r.block,
        blockHash: log.blockHash,
        sub,
      })
    }
  }

  const milestones = await milestoneEvents(milestoneContexts, deps, {
    toBlock,
    times,
    blockHash: (block) => hashes.get(block)!,
    mints,
    collections: [...collections.values()],
  })
  events.push(...milestones.events)

  return {
    events,
    blocks: [...hashes].map(([number, hash]) => ({ number, hash })),
    mints,
    burns,
    seadropMints,
    seadropConfig,
    sales,
    launches,
    collections: [...collections.values()],
    stages: milestones.stages,
    milestones: milestones.updates,
    touched: [...collections.keys()],
  }
}

type TokenNames = { symbol: string | null; name: string | null }

/** `symbol()` and `name()` of the launches' tokens, one read for all; null for a call that reverts. */
async function readTokenNames(
  chain: Pick<Chain, "readErc20Names">,
  launches: LaunchRow[],
  block: bigint,
): Promise<Map<Address, TokenNames>> {
  const tokens = [...new Set(launches.map((l) => l.token))]
  const read = tokens.length > 0 ? await chain.readErc20Names(tokens, block) : []
  return new Map(tokens.map((t, i) => [t, read[i]!]))
}

function launchEvent(
  l: LaunchRow,
  names: TokenNames | undefined,
  blockTimestamp: number,
): NftLaunchEvent {
  return {
    v: SCHEMA_VERSION,
    chainId: INK_CHAIN_ID,
    type: "nft.launch",
    contract: l.collection,
    source: "chain",
    txHash: l.txHash,
    logIndex: l.logIndex,
    blockNumber: s(l.block),
    blockTimestamp,
    launchpad: l.launchpad,
    campaignId: s(l.campaignId),
    token: l.token,
    tokenSymbol: names?.symbol ?? null,
    tokenName: names?.name ?? null,
    creator: l.creator,
    poolId: l.poolId,
  }
}

/**
 * One row per (contract, token) of an order. Lines of the same token merge, so the unique keys
 * never drop a line. The decoder's price is the line's share of the payment; the row's is one unit's.
 */
function linesToSales(log: ChainLog, decoded: SeaportSale[]): SaleRow[] {
  const merged = new Map<string, SaleRow & { line: bigint }>()
  for (const d of decoded) {
    const key = `${d.contract}:${d.tokenId}`
    const m = merged.get(key)
    if (m) {
      m.qty += d.qty
      m.line += d.priceWei
    } else {
      merged.set(key, {
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        contract: d.contract,
        tokenId: d.tokenId,
        qty: d.qty,
        priceWei: 0n,
        line: d.priceWei,
        currency: d.currency,
        buyer: d.buyer,
        seller: d.seller,
        orderHash: d.orderHash,
        block: log.blockNumber,
      })
    }
  }
  return [...merged.values()].map(({ line, ...row }) => ({
    ...row,
    priceWei: row.qty > 1n ? line / row.qty : line,
  }))
}

type SaleItem = {
  name?: string | null
  imageUrl?: string | null
  rank?: { rank: number; maxRank: number }
}

function saleEvent(
  r: SaleRow,
  blockTimestamp: number,
  floorWei: bigint | null,
  item: SaleItem,
): NftSaleEvent {
  return {
    v: SCHEMA_VERSION,
    chainId: INK_CHAIN_ID,
    type: "nft.sale",
    contract: r.contract,
    source: "chain",
    txHash: r.txHash,
    logIndex: r.logIndex,
    blockNumber: s(r.block),
    blockTimestamp,
    tokenId: s(r.tokenId),
    priceWei: s(r.priceWei),
    currency: r.currency,
    buyer: r.buyer,
    seller: r.seller,
    orderHash: r.orderHash,
    // From nft_items_seen and nft_ranks; null for an item no listing has cached.
    itemName: item.name ?? null,
    imageUrl: item.imageUrl ?? null,
    rank: item.rank?.rank ?? null,
    maxRank: item.rank?.maxRank ?? null,
    // The collection's latest stats floor; null while it has none.
    floorWei: floorWei === null ? null : s(floorWei),
  }
}

/** Block times in unix seconds, read in small parallel groups. */
async function blockTimestamps(
  chain: Pick<Chain, "getBlock">,
  blocks: bigint[],
): Promise<Map<bigint, number>> {
  const times = new Map<bigint, number>()
  for (let i = 0; i < blocks.length; i += TIMESTAMP_READ_CONCURRENCY) {
    await Promise.all(
      blocks.slice(i, i + TIMESTAMP_READ_CONCURRENCY).map(async (n) => {
        const block = await chain.getBlock(n)
        if (!block) throw new BlockNotServedError(n)
        times.set(n, Number(block.timestamp))
      }),
    )
  }
  return times
}
