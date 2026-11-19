import type { Sql } from "@ink-indexer/db"
import {
  type ChainLog,
  decodeNftxLog,
  type NFTX_EVENTS,
  NFTX_LOCKER,
  NFTX_TOPICS,
  nftxEventsAbi,
  nftxSpotWei,
  poolKeyOf,
} from "@ink-indexer/sdk"
import {
  type Abi,
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hash,
  type Hex,
} from "viem"
import type { NftxFixture, NftxFixtureName } from "../../../packages/sdk/test/fixtures"
import { loadNftxFixture } from "../../../packages/sdk/test/fixtures"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import { nftSource } from "../src/sources/nft/index"
import { nftxSource } from "../src/sources/nftx/index"
import type { Ranks } from "../src/sources/opensea/ranks"
import type { Store } from "../src/store"
import { FakeChain } from "./fake-chain"

export const ZERO = "0x0000000000000000000000000000000000000000" as Address

/** A chain over recorded NFTX transactions and an indexer running the NFTX source (and optionally the NFT one). */
export function nftxHarness(
  sql: Sql,
  store: Store,
  fixtures: NftxFixtureName[],
  opts: {
    both?: boolean
    now?: () => number
    /** OpenSea's rank lookups, as `startNftServices` shares them; none by default. */
    ranks?: { current: Pick<Ranks, "getRank"> | null }
  } = {},
) {
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
  const logger: Logger = (level, msg, fields) => {
    if (level === "warn") warnings.push({ msg, fields })
  }
  const loaded = fixtures.map((n) => loadNftxFixture(n))
  const head = loaded.reduce((m, f) => (f.blockNumber > m ? f.blockNumber : m), 0n) + 100n
  const chain = new FakeChain(head)
  chain.maxSpan = 10_000_000n
  for (const f of loaded) addFixture(chain, f)
  const nftx = nftxSource({
    sql,
    chain,
    logger,
    fetch: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
    now: opts.now,
    launchpad: null,
    ranks: opts.ranks,
  })
  const sources = opts.both ? [nftSource({ sql, chain, logger }), nftx] : [nftx]
  const idx = new Indexer({ chain, store, logger, sources })
  const firstBlock = () =>
    chain.logs.reduce((m, l) => (l.blockNumber < m ? l.blockNumber : m), head)
  /** Reads the chain as the live tick does, from the block before the first fixture. */
  const live = async () => {
    await idx.init()
    await store.writeBatch([], [], {
      cursor: { block: firstBlock() - 1n, hash: chain.hashOf(firstBlock() - 1n) },
      head: chain.head,
    })
    await idx.trigger()
  }
  /** Reads the chain from the first fixture's block up to the head as backfill spans. */
  const backfill = async () => {
    await idx.init()
    await idx.backfill(firstBlock(), chain.head)
  }
  return { chain, idx, warnings, live, backfill, loaded }
}

/** Adds a fixture's logs and its block's senders, targets and time. */
export function addFixture(chain: FakeChain, f: NftxFixture) {
  for (const l of f.logs) chain.add(l)
  const prev = chain.senders.get(f.blockNumber)
  const senders = prev?.senders ?? new Map<Hash, Address>()
  const targets = prev?.targets ?? new Map<Hash, Address | null>()
  senders.set(f.txHash, f.from)
  targets.set(f.txHash, f.to)
  chain.senders.set(f.blockNumber, {
    hash: chain.hashOf(f.blockNumber),
    senders,
    targets,
    timestamp: f.timestamp,
  })
}

/**
 * Stores the pools a recorded transaction trades in as open NFTX pools with flETH as currency0 (as
 * on the chain they were recorded on), priced at the newest price recorded before the transaction.
 * Returns each collection's spot price.
 */
export async function seedPools(sql: Sql, f: NftxFixture): Promise<Map<Address, bigint>> {
  const spot = new Map<Address, bigint>()
  for (const l of f.pools) {
    const d = decodeNftxLog(l)
    if (d?.kind !== "initialized") continue
    const key = poolKeyOf(d.poolKey)!
    await sql`
      insert into indexer.nftx_collections ${sql({
        collection: d.collection,
        floor_token: key.currency1,
        creator: ZERO,
        created_block: (l.blockNumber - 1n).toString(),
        initialized_block: l.blockNumber.toString(),
        pool_id: key.poolId,
        fleth_is_currency0: true,
      })} on conflict do nothing`
    spot.set(d.collection, nftxSpotWei(d.sqrtPriceX96, true)!)
  }
  // The newest PoolStateUpdated before the transaction, where one was recorded, is the spot.
  for (const l of f.pools) {
    const d = decodeNftxLog(l)
    if (d?.kind === "poolState") spot.set(d.collection, nftxSpotWei(d.sqrtPriceX96, true)!)
  }
  for (const [collection, price] of spot)
    await sql`
      insert into indexer.nftx_prices ${sql({
        collection,
        block: (f.blockNumber - 1000n).toString(),
        log_index: 0,
        sqrt_price_x96: 1,
        price_wei: price.toString(),
        at: new Date((f.timestamp - 1000) * 1000),
      })} on conflict do nothing`
  return spot
}

/** Answers `readNftxListings` for a recorded transaction: the "before" reads one block before it, the "at" reads from it on. */
export function stubListings(chain: FakeChain, f: NftxFixture) {
  const at = new Map(f.listings.at.map((i) => [`${i.collection}:${i.tokenId}`, i.read]))
  for (const i of f.listings.before)
    chain.nftxListings.set(`${i.collection}:${i.tokenId}`, (block) =>
      block < f.blockNumber ? i.read : (at.get(`${i.collection}:${i.tokenId}`) ?? null),
    )
}

const NON_INDEXED = (item: { inputs: readonly { name: string; indexed?: boolean }[] }) =>
  item.inputs.filter((i) => !i.indexed)

/** A log of an NFTX event, built from its ABI. `like` gives the block, transaction and hash of the log it stands beside. */
export function synthLog(
  like: ChainLog,
  name: keyof typeof NFTX_EVENTS,
  args: Record<string, unknown>,
  at: { address: Address; logIndex: number },
): ChainLog {
  const item = (nftxEventsAbi as Abi).find((i) => i.type === "event" && i.name === name) as {
    inputs: readonly { name: string; indexed?: boolean }[]
  }
  const topics = encodeEventTopics({
    abi: nftxEventsAbi as Abi,
    eventName: name,
    args: Object.fromEntries(
      item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]]),
    ),
  }) as Hex[]
  const data = encodeAbiParameters(
    NON_INDEXED(item as never) as never,
    NON_INDEXED(item).map((i) => args[i.name]) as never,
  )
  return { ...like, address: at.address, topics, data, logIndex: at.logIndex }
}

export { NFTX_LOCKER, NFTX_TOPICS }
