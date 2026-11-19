import type { Sql } from "@ink-indexer/db"
import { type NftLaunchEvent, SCHEMA_VERSION } from "@ink-indexer/events"
import {
  type ChainLog,
  cleanText,
  decodeNftxLog,
  INK_CHAIN_ID,
  NFTX_FLETH,
  NFTX_HOOK,
  NFTX_LAUNCHPAD,
  NFTX_LISTINGS,
  NFTX_LOCKER,
  NFTX_LOG_TOPICS,
  NFTX_ROYALTY_GATE,
  NFTX_ZAPS,
  type NftxLog,
  nftxSpotWei,
  poolKeyOf,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../../chain"
import { BlockNotServedError } from "../../errors"
import type { Logger } from "../../log"
import type { LogFilter } from "../../rpc"
import type { Reporter } from "../../sentry"
import { droppedLogs } from "../dropped"
import type { Ranks } from "../opensea/ranks"
import { blockSendersFor } from "../senders"
import { pick, type Source, type SourceBatch } from "../source"
import { planListings } from "./listings"
import { planSales, type SalesPlan } from "./sales"
import { fetchNftxSlug } from "./slug"
import { type PricePoint, planStats, type StatsBasis, type StatsPlan } from "./stats"
import { rollbackRows, writeRows } from "./write"

/** Slug lookups per batch, and the wait before a collection is asked about again. */
const SLUGS_PER_BATCH = 3
const SLUG_RETRY_MS = 5 * 60_000
const NAME_MAX = 64
const SYMBOL_MAX = 32

export type NftxDeps = {
  sql: Sql
  chain: Pick<Chain, "getBlockSenders" | "readNftxListings" | "readNftxPoolCounts">
  logger: Logger
  /** NFTX's API for the slug; tests pass a stub. */
  fetch?: typeof fetch
  /** The clock the slug retry gap and the dropped-log warnings read; tests inject one. */
  now?: () => number
  /** NFTX's launchpad. A collection created by a transaction sent by or to it is real without the gates. */
  launchpad?: Address | null
  /** Block-sender reads a backfill span keeps in flight; tests lower it. */
  blockReads?: number
  /** Where a trusted contract's undecodable log is reported; none by default. */
  report?: Pick<Reporter, "warn">
  /**
   * OpenSea's rank lookup, set while the OpenSea services run. A live listing priced within a tenth
   * of the floor asks it for the item's rank; with none set, listings carry cached ranks only.
   */
  ranks?: { current: Pick<Ranks, "getRank"> | null }
}

export type CreatedRow = {
  collection: Address
  floorToken: Address
  creator: Address
  name: string | null
  symbol: string | null
  block: bigint
  launchpadCreated: boolean
}
export type OpenedRow = {
  collection: Address
  block: bigint
  /** Null when the pool key did not decode. */
  poolId: Hash | null
  /** Null when the pool is not an NFTX pool with a flETH side. */
  flethIsCurrency0: boolean | null
  seeded: number
  /** Written only for a pool with a side. */
  launch: { token: Address; creator: Address } | null
}
export type PriceRow = {
  collection: Address
  block: bigint
  logIndex: number
  sqrtPriceX96: bigint
  priceWei: bigint | null
  at: number
}
export type NftxBatch = SourceBatch & {
  created: CreatedRow[]
  opened: OpenedRow[]
  prices: PriceRow[]
  sunsets: { collection: Address; block: bigint }[]
  slugs: { collection: Address; slug: string }[]
  /** Pool moves announced as stats (see `planStats`). */
  stats: StatsPlan["rows"]
  statsLast: StatsPlan["last"]
  combinedSince: StatsPlan["combinedSince"]
  /** Sales of listing fills, relists and instant trades (see `planSales`). */
  sales: SalesPlan["rows"]
  /** Items whose listing ended in the span. */
  closed: SalesPlan["closed"]
}

/** The pool sizes at a fork, read before the rollback transaction opens. */
export type NftxRollback = { poolCounts: { collection: Address; count: number | null }[] }

type Known = {
  collection: Address
  floorToken: Address
  creator: Address
  name: string | null
  symbol: string | null
  createdBlock: bigint
  initializedBlock: bigint | null
  flethIsCurrency0: boolean | null
  sunsetBlock: bigint | null
  slug: string | null
  statsPriceWei: bigint | null
  statsBlock: bigint | null
  combinedSince: Date | null
  maxSupply: string | null
}

/**
 * Every log the source reads, from one filter over its fixed contracts. The loop merges it into
 * the one address-bound `eth_getLogs` request with the other sources; the topics are the union
 * of what the contracts emit, and the emitter decides which kind of log a topic is trusted as.
 */
const ADDRESSES: LogFilter = {
  address: [NFTX_LOCKER, ...NFTX_ZAPS, NFTX_ROYALTY_GATE, NFTX_LISTINGS, NFTX_HOOK],
  topics: [[...NFTX_LOG_TOPICS]],
}

/** The contract each kind of log is accepted from. */
function emitterOk(d: NftxLog, emitter: Address): boolean {
  switch (d.kind) {
    case "created":
    case "initialized":
    case "deposit":
    case "withdrawal":
    case "sunset":
      return emitter === NFTX_LOCKER
    case "zapBought":
    case "zapRedeemed":
    case "zapSold":
      return NFTX_ZAPS.includes(emitter)
    case "gatedSale":
      return emitter === NFTX_ROYALTY_GATE
    case "listingsCreated":
    case "relisted":
    case "multipleUpdated":
    case "filled":
    case "cancelled":
    case "stale":
      return emitter === NFTX_LISTINGS
    case "poolState":
      return emitter === NFTX_HOOK
  }
}

const TRUSTED = new Set<Address>([ADDRESSES.address].flat() as Address[])

const byPosition = (a: ChainLog, b: ChainLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

const text = (s: string, max: number) => cleanText(cleanText(s).slice(0, max)) || null

/**
 * NFTX v4 as a loop source: collections created in the Locker, the opening of their pools and the
 * pool's price. A collection is the ERC-721 contract; its floor token is the ERC-20 the Locker
 * mints for it. Each kind of log is accepted only from the contract that emits it.
 */
export function nftxSource(deps: NftxDeps): Source<NftxBatch, NftxRollback> {
  const { sql, chain, logger } = deps
  const now = deps.now ?? Date.now
  const launchpad = deps.launchpad === undefined ? NFTX_LAUNCHPAD : deps.launchpad
  const dropped = droppedLogs({
    source: "nftx",
    logger,
    topics: NFTX_LOG_TOPICS,
    trusted: (a) => TRUSTED.has(a),
    report: deps.report,
    now: deps.now,
  })
  /** When each collection's slug was last asked for; a miss waits before the next attempt. */
  const slugAsked = new Map<Address, number>()

  async function loadKnown(collections: Address[]): Promise<Map<Address, Known>> {
    if (collections.length === 0) return new Map()
    const rows = await sql<
      {
        collection: Address
        floor_token: Address
        creator: Address
        name: string | null
        symbol: string | null
        created_block: string
        initialized_block: string | null
        fleth_is_currency0: boolean | null
        sunset_block: string | null
        nftx_slug: string | null
        stats_price_wei: string | null
        stats_block: string | null
        combined_since: Date | null
        max_supply: string | null
      }[]
    >`
      select c.collection, c.floor_token, c.creator, c.name, c.symbol, c.created_block::text,
        c.initialized_block::text, c.fleth_is_currency0, c.sunset_block::text, n.nftx_slug,
        c.stats_price_wei::text, c.stats_block::text, c.combined_since, n.max_supply::text
      from indexer.nftx_collections c
      left join indexer.nft_collections n on n.contract = c.collection
      where c.collection = any(${sql.array(collections)}::text[])`
    return new Map(
      rows.map((r) => [
        r.collection,
        {
          collection: r.collection,
          floorToken: r.floor_token,
          creator: r.creator,
          name: r.name,
          symbol: r.symbol,
          createdBlock: BigInt(r.created_block),
          initializedBlock: r.initialized_block === null ? null : BigInt(r.initialized_block),
          flethIsCurrency0: r.fleth_is_currency0,
          sunsetBlock: r.sunset_block === null ? null : BigInt(r.sunset_block),
          slug: r.nftx_slug,
          statsPriceWei: r.stats_price_wei === null ? null : BigInt(r.stats_price_wei),
          statsBlock: r.stats_block === null ? null : BigInt(r.stats_block),
          combinedSince: r.combined_since,
          maxSupply: r.max_supply,
        },
      ]),
    )
  }

  async function process(
    logs: ChainLog[][],
    ctx: { toBlock: bigint; live: boolean },
  ): Promise<NftxBatch> {
    const batch: NftxBatch = {
      created: [],
      opened: [],
      prices: [],
      sunsets: [],
      slugs: [],
      stats: [],
      statsLast: [],
      combinedSince: [],
      sales: [],
      closed: [],
      events: [],
      blocks: [],
    }
    const items: { log: ChainLog; d: NftxLog }[] = []
    for (const log of [...(logs[0] ?? [])].sort(byPosition)) {
      const d = decodeNftxLog(log)
      if (!d) {
        dropped(log)
        continue
      }
      if (emitterOk(d, log.address)) items.push({ log, d })
    }
    if (items.length === 0) return batch

    const known = await loadKnown([...new Set(items.map((i) => i.d.collection))])
    const blockNumbers = [...new Set(items.map((i) => i.log.blockNumber))]
    const senders = await blockSendersFor(chain, blockNumbers, {
      live: ctx.live,
      limit: deps.blockReads,
    })
    const blocks = new Map<bigint, NonNullable<Awaited<ReturnType<typeof senders>>>>()
    for (const n of blockNumbers) {
      const block = await senders(n)
      const hash = items.find((i) => i.log.blockNumber === n)!.log.blockHash
      // The logs and the block can come from different endpoints on either side of a reorg.
      if (!block || block.hash !== hash) throw new BlockNotServedError(n)
      blocks.set(n, block)
      batch.blocks.push({ number: n, hash })
    }

    // Collections as the span leaves them, from what is stored and what the logs say in order.
    const state = new Map(known)
    const sunsetAt = new Map<Address, { block: bigint; logIndex: number }>()
    const opens: { log: ChainLog; d: Extract<NftxLog, { kind: "initialized" }> }[] = []
    for (const { log, d } of items) {
      const c = state.get(d.collection)
      switch (d.kind) {
        case "created": {
          if (c) break
          const tx = log.transactionHash
          const meta = blocks.get(log.blockNumber)!
          const from = meta.senders.get(tx)
          const to = meta.targets.get(tx)
          batch.created.push({
            collection: d.collection,
            floorToken: d.token,
            creator: d.creator,
            name: text(d.name, NAME_MAX),
            symbol: text(d.symbol, SYMBOL_MAX),
            block: log.blockNumber,
            launchpadCreated: launchpad !== null && (from === launchpad || to === launchpad),
          })
          const made = batch.created.at(-1)!
          state.set(d.collection, {
            collection: d.collection,
            floorToken: made.floorToken,
            creator: made.creator,
            name: made.name,
            symbol: made.symbol,
            createdBlock: log.blockNumber,
            initializedBlock: null,
            flethIsCurrency0: null,
            sunsetBlock: null,
            slug: null,
            statsPriceWei: null,
            statsBlock: null,
            combinedSince: null,
            maxSupply: null,
          })
          break
        }
        case "initialized": {
          // The first opening stands; the same log read again gives the same rows.
          if (!c || (c.initializedBlock !== null && c.initializedBlock !== log.blockNumber)) break
          const key = poolKeyOf(d.poolKey)
          const side =
            key && key.hooks === NFTX_HOOK
              ? key.currency0 === NFTX_FLETH
                ? true
                : key.currency1 === NFTX_FLETH
                  ? false
                  : null
              : null
          if (side === null)
            logger(
              "warn",
              "ignoring a CollectionInitialized whose pool is not an NFTX flETH pool",
              {
                collection: d.collection,
                tx: log.transactionHash,
              },
            )
          c.initializedBlock = log.blockNumber
          c.flethIsCurrency0 = side
          opens.push({ log, d })
          batch.opened.push({
            collection: d.collection,
            block: log.blockNumber,
            poolId: key?.poolId ?? null,
            flethIsCurrency0: side,
            seeded: new Set(d.tokenIds.map(String)).size,
            launch: side === null ? null : { token: c.floorToken, creator: c.creator },
          })
          break
        }
        case "sunset":
          if (!c) break
          if (c.sunsetBlock === null || c.sunsetBlock === log.blockNumber) {
            c.sunsetBlock = log.blockNumber
            sunsetAt.set(d.collection, { block: log.blockNumber, logIndex: log.logIndex })
            batch.sunsets.push({ collection: d.collection, block: log.blockNumber })
          }
          break
        default:
          break
      }
    }

    // Prices come after the whole span's openings: an opening transaction logs the pool's first
    // prices before the opening itself.
    for (const { log, d } of items) {
      if (d.kind !== "poolState") continue
      const c = state.get(d.collection)
      if (!c || c.flethIsCurrency0 === null || c.initializedBlock === null) continue
      if (log.blockNumber < c.initializedBlock) continue
      const sunset = sunsetAt.get(d.collection)
      if (c.sunsetBlock !== null && log.blockNumber > c.sunsetBlock) continue
      if (sunset && log.blockNumber === sunset.block && log.logIndex > sunset.logIndex) continue
      batch.prices.push({
        collection: d.collection,
        block: log.blockNumber,
        logIndex: log.logIndex,
        sqrtPriceX96: d.sqrtPriceX96,
        priceWei: nftxSpotWei(d.sqrtPriceX96, c.flethIsCurrency0),
        at: blocks.get(log.blockNumber)!.timestamp,
      })
    }

    // The link name comes from NFTX's API for a few active collections that have none yet.
    const active = [...new Set(items.map((i) => i.d.collection))].filter((a) => {
      const c = state.get(a)
      return c && c.slug === null && now() - (slugAsked.get(a) ?? -Infinity) >= SLUG_RETRY_MS
    })
    const asked = active.slice(0, SLUGS_PER_BATCH)
    for (const a of asked) slugAsked.set(a, now())
    const fetched = await Promise.all(
      asked.map(async (a) => [a, await fetchNftxSlug(a, { fetch: deps.fetch })] as const),
    )
    for (const [collection, slug] of fetched) {
      if (slug === null) continue
      batch.slugs.push({ collection, slug })
      state.get(collection)!.slug = slug
    }

    const plan = await planStats(
      { sql, chain },
      {
        prices: batch.prices satisfies PricePoint[],
        basis: new Map(
          [...state].map(([a, c]): [Address, StatsBasis] => [
            a,
            {
              statsPriceWei: c.statsPriceWei,
              statsBlock: c.statsBlock,
              combinedSince: c.combinedSince,
              slug: c.slug,
              maxSupply: c.maxSupply,
            },
          ]),
        ),
        blockHash: (n) => items.find((i) => i.log.blockNumber === n)!.log.blockHash,
        live: ctx.live,
      },
    )
    batch.stats = plan.rows
    batch.statsLast = plan.last
    batch.combinedSince = plan.combinedSince
    batch.events.push(...plan.events)

    const salesPlan = await planSales(
      { sql, chain, logger },
      {
        items,
        slugOf: (a) => state.get(a)?.slug,
        prices: batch.prices,
        timestamp: (n) => blocks.get(n)!.timestamp,
      },
    )
    batch.sales = salesPlan.rows
    batch.closed = salesPlan.closed
    batch.events.push(...salesPlan.events)

    batch.events.push(
      ...(await planListings(
        { sql, chain, logger, ranks: deps.ranks ?? { current: null } },
        {
          items,
          slugOf: (a) => state.get(a)?.slug,
          prices: batch.prices,
          timestamp: (n) => blocks.get(n)!.timestamp,
          live: ctx.live,
        },
      )),
    )

    for (const { log, d } of opens) {
      const c = state.get(d.collection)!
      if (c.flethIsCurrency0 === null) continue
      const meta = blocks.get(log.blockNumber)!
      batch.events.push({
        event: launchEvent(c, d, log, meta.timestamp),
        block: log.blockNumber,
        blockHash: log.blockHash,
        sub: "",
      })
    }
    return batch
  }

  return {
    name: "nftx",
    filters: (only) => [pick(only, "nftx", ADDRESSES)],
    process: (logs, ctx) => process(logs, ctx),
    write: (tx, batch) => writeRows(tx, batch),
    prepareRollback: async (fork) => {
      const rows = await sql<{ collection: Address }[]>`
        select collection from indexer.nftx_collections where pool_count_block > ${fork.toString()}`
      const counts =
        rows.length === 0
          ? []
          : await chain.readNftxPoolCounts(
              rows.map((r) => r.collection),
              fork,
            )
      return {
        poolCounts: rows.map((r, i) => ({ collection: r.collection, count: counts[i] ?? null })),
      }
    },
    rollback: (tx, fork, prepared) => rollbackRows(tx, fork, prepared),
    reload: async () => {},
  }
}

function launchEvent(
  c: Known,
  d: Extract<NftxLog, { kind: "initialized" }>,
  log: ChainLog,
  timestamp: number,
): NftLaunchEvent {
  const key = poolKeyOf(d.poolKey)!
  return {
    v: SCHEMA_VERSION,
    chainId: INK_CHAIN_ID,
    type: "nft.launch",
    contract: c.collection,
    source: "chain",
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber.toString(),
    blockTimestamp: timestamp,
    launchpad: "nftx",
    campaignId: c.floorToken,
    token: c.floorToken,
    tokenSymbol: c.symbol,
    tokenName: c.name,
    creator: c.creator,
    poolId: key.poolId,
    nftxFloorWei: nftxSpotWei(d.sqrtPriceX96, c.flethIsCurrency0!)?.toString() ?? null,
    poolCount: new Set(d.tokenIds.map(String)).size,
    nftxSlug: c.slug,
  }
}
