import type { Sql } from "@ink-indexer/db"
import { type NftSaleEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import {
  CHIMERA_FACTORY,
  type ChainLog,
  decodeChimeraCampaign,
  decodeNftTransfers,
  decodeOrderFulfilled,
  decodeSeaDropLog,
  INK_CHAIN_ID,
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
import type { EventRow, Source, SourceBatch } from "../source"
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
  launch: { launchpad: "chimera"; token: Address } | null
}

export type NftBatch = SourceBatch & {
  mints: TransferRow[]
  burns: TransferRow[]
  seadropMints: SeaDropMintRow[]
  seadropConfig: SeaDropConfigRow[]
  sales: SaleRow[]
  launches: LaunchRow[]
  collections: CollectionTouch[]
  /** Every contract in `collections`: those with a mint, a burn, a SeaDrop log or a launch. */
  touched: Address[]
}

export type NftDeps = {
  sql: Sql
  chain: Pick<Chain, "getBlock">
  logger: Logger
}

const TRANSFER = NFT_TOPICS.transfer
const BATCHES = [NFT_TOPICS.transferSingle, NFT_TOPICS.transferBatch]

/** Same order as the log arrays `process` receives. */
const FILTERS: LogFilter[] = [
  { topics: [TRANSFER, ZERO_TOPIC] },
  { topics: [TRANSFER, null, ZERO_TOPIC] },
  { topics: [BATCHES, null, ZERO_TOPIC] },
  { topics: [BATCHES, null, null, ZERO_TOPIC] },
  { address: SEADROP_V1, topics: [] },
  { address: [SEAPORT_1_6, SEAPORT_1_5], topics: [NFT_TOPICS.orderFulfilled] },
  { address: CHIMERA_FACTORY, topics: [NFT_TOPICS.campaignCreated] },
]
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
    filters: () => FILTERS,
    process: (logs) => processLogs(logs, deps),
    write: writeRows,
    prepareRollback: async () => null,
    rollback: (tx, fork) => rollbackRows(tx, fork),
    // No in-memory state.
    reload: async () => {},
  }
}

const s = (x: bigint) => x.toString()

export async function processLogs(logs: ChainLog[][], deps: NftDeps): Promise<NftBatch> {
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

  const saleLogs: { log: ChainLog; sales: SaleRow[] }[] = []
  for (const l of at(SEAPORT)) {
    const sales = linesToSales(l, decodeOrderFulfilled(l))
    if (sales.length === 0) continue
    seen(l)
    saleLogs.push({ log: l, sales })
  }

  const launches: LaunchRow[] = []
  for (const l of at(CHIMERA)) {
    const d = decodeChimeraCampaign(l)
    if (!d) continue
    seen(l)
    launches.push({
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
  const wanted = new Set<bigint>([
    ...firstMintBlock.values(),
    ...saleLogs.map((x) => x.log.blockNumber),
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
  for (const l of launches) touch(l.collection).launch = { launchpad: l.launchpad, token: l.token }

  const events: EventRow[] = []
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
      events.push({ event: saleEvent(r, ts), block: r.block, blockHash: log.blockHash, sub })
    }
  }

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
    touched: [...collections.keys()],
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

function saleEvent(r: SaleRow, blockTimestamp: number): NftSaleEvent {
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
    // Item name, image and rank stay null until they are looked up from nft_ranks and the listing cache.
    itemName: null,
    imageUrl: null,
    rank: null,
    maxRank: null,
    // Null until nft_stats holds a floor to read.
    floorWei: null,
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
