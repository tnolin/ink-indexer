import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  CHIMERA_FACTORY,
  type ChainLog,
  DEAD_ADDRESS,
  LOG_TOPICS,
  NATIVE_QUOTE_ASSET,
  NFT_TOPICS,
  SEADROP_V1,
  SEAPORT_1_6,
  UNISWAP_V4_POOL_MANAGER,
  ZERO_TOPIC,
} from "@ink-indexer/sdk"
import type { Hash } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { swapLog, transferLog } from "../../../packages/sdk/test/builders"
import {
  loadChimeraCampaigns,
  loadNftFixture,
  NFT_FIXTURES,
} from "../../../packages/sdk/test/fixtures"
import type { Chain } from "../src/chain"
import { readLogs } from "../src/log-plan"
import { Indexer } from "../src/loop"
import type { LogFilter } from "../src/rpc"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { nftSource } from "../src/sources/nft/index"
import { PoolRegistry } from "../src/sources/pools"
import { BACKFILL_SOURCES, type BackfillSource } from "../src/sources/source"
import { v4Source } from "../src/sources/v4/index"
import { createStore } from "../src/store"
import { matchesFilter } from "./fake-chain"
import { loadCalls, ReplayChain } from "./replay-chain"

/**
 * Proof that merging the sources' log filters into fewer eth_getLogs requests changes nothing but
 * the request count: the same recorded logs go through the per-filter path (`mergeRequests: false`)
 * and the merged path, for every subset of the four filter groups.
 *
 * The pool is the recorded InkyPump range plus every recorded NFT log, moved into that range
 * (block order and transaction grouping kept), plus synthetic logs for what the merged requests
 * fetch beyond the old filters (see `OVERFETCH`).
 */

const calls = loadCalls()
const { from, to } = calls.range
const A1 = "0x00000000000000000000000000000000000000a1"
/** A token with a registered v4 pool, and that pool's id. */
const V4_TOKEN = "0x00000000000000000000000000000000000000a2"
const V4_POOL = `0x${"a2".repeat(32)}` as Hash
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash
const ADDR_WORD = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}` as Hash

function buildPool(): { logs: ChainLog[]; extra: ChainLog[] } {
  const nft = [...NFT_FIXTURES.flatMap((n) => loadNftFixture(n)), ...loadChimeraCampaigns()]
  const blocks = [...new Set(nft.map((l) => l.blockNumber))].sort((a, b) => Number(a - b))
  const slot = new Map(blocks.map((b, i) => [b, from + 1n + BigInt(i)]))
  const moved = nft.map((l) => ({ ...l, blockNumber: slot.get(l.blockNumber)! }))
  if (from + 1n + BigInt(blocks.length) >= to) throw new Error("pool does not fit the range")
  const at = (i: number) => from + 5n + BigInt(i)
  const mk = (i: number, address: string, topics: Hash[], logIndex = 9_000 + i): ChainLog => ({
    address: address as ChainLog["address"],
    topics,
    data: "0x",
    blockNumber: at(i),
    blockHash: word(Number(at(i))),
    transactionHash: word(0xbad000 + i),
    logIndex,
  })
  const T = NFT_TOPICS.transfer
  // Logs the old filters returned in two arrays, or that only a merged request fetches.
  const extra = [
    // ERC-20 burn (three topics): matches the 721 burn filter, decodes to nothing.
    mk(0, A1, [T, ADDR_WORD(A1), ZERO_TOPIC]),
    // A mint-and-burn in one log: matches the 721 mint and the 721 burn filter.
    mk(1, A1, [T, ZERO_TOPIC, ZERO_TOPIC, word(7)]),
    // 1155 operator 0x0: a TransferSingle with the zero address in topic1 only (matches no filter).
    mk(2, A1, [NFT_TOPICS.transferSingle, ZERO_TOPIC, ADDR_WORD(A1), ADDR_WORD(A1)]),
    // Over-fetch of the address request: Seaport events that are not OrderFulfilled.
    mk(3, SEAPORT_1_6, [word(0xca11ce1)]),
    mk(4, SEAPORT_1_6, [NFT_TOPICS.campaignCreated]),
    // The Chimera factory emitting an event of another type.
    mk(5, CHIMERA_FACTORY, [NFT_TOPICS.orderFulfilled, ADDR_WORD(A1), ADDR_WORD(A1)]),
    // SeaDrop's own events are all wanted by its filter.
    mk(6, SEADROP_V1, [word(0xd0d0)]),
    // The right topic0 from a contract the filters do not name.
    mk(7, A1, [NFT_TOPICS.orderFulfilled, ADDR_WORD(A1), ADDR_WORD(A1)]),
    mk(8, A1, [NFT_TOPICS.campaignCreated]),
    // An InkyPump topic0 from anywhere is wanted by the InkyPump filter.
    mk(9, A1, [LOG_TOPICS[0]!]),
    // ERC-1155 burns: the zero address in topic3.
    mk(10, A1, [NFT_TOPICS.transferSingle, ADDR_WORD(A1), ADDR_WORD(A1), ZERO_TOPIC]),
    mk(11, A1, [NFT_TOPICS.transferBatch, ADDR_WORD(A1), ADDR_WORD(A1), ZERO_TOPIC]),
  ]
  // v4 logs: the topic filters return only the first of each pair, so the per-filter and merged
  // paths read the same logs.
  const v4 = [
    swapLog(
      {
        poolId: V4_POOL,
        sender: A1,
        amount0: -1n,
        amount1: 1n,
        sqrtPriceX96: 1n << 96n,
        liquidity: 1n,
      },
      {
        blockNumber: at(12),
        blockHash: word(Number(at(12))),
        transactionHash: word(0xbad100),
        logIndex: 9_100,
      },
    ),
    swapLog(
      {
        poolId: word(0xa3),
        sender: A1,
        amount0: -1n,
        amount1: 1n,
        sqrtPriceX96: 1n << 96n,
        liquidity: 1n,
      },
      {
        blockNumber: at(12),
        blockHash: word(Number(at(12))),
        transactionHash: word(0xbad101),
        logIndex: 9_101,
      },
    ),
    transferLog(
      { from: A1, to: DEAD_ADDRESS, value: 1n },
      {
        address: V4_TOKEN,
        blockNumber: at(13),
        blockHash: word(Number(at(13))),
        transactionHash: word(0xbad102),
        logIndex: 9_102,
      },
    ),
    transferLog(
      { from: A1, to: CHIMERA_FACTORY, value: 1n },
      {
        address: V4_TOKEN,
        blockNumber: at(13),
        blockHash: word(Number(at(13))),
        transactionHash: word(0xbad103),
        logIndex: 9_103,
      },
    ),
  ]
  const logs = [...calls.logs, ...moved, ...extra, ...v4].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  )
  return { logs, extra }
}

/** The recorded InkyPump answers, and every other call answered as an empty chain would. */
class PoolChain implements Chain {
  readonly asked: LogFilter[] = []
  private readonly replay = new ReplayChain(calls)
  constructor(private readonly pool: ChainLog[]) {}
  getBlockNumber = () => this.replay.getBlockNumber()
  getTransportHeads = async () => []
  async getBlock(n: bigint) {
    return this.replay.getBlock(n).catch(() => ({ hash: word(Number(n)), timestamp: n }))
  }
  async getLogs(f: bigint, t: bigint, filter: LogFilter) {
    this.asked.push(filter)
    const toBlock = t < calls.head ? t : calls.head
    return {
      logs: this.pool.filter(
        (l) => l.blockNumber >= f && l.blockNumber <= toBlock && matchesFilter(l, filter),
      ),
      toBlock,
    }
  }
  readLaunchStates = (...a: Parameters<Chain["readLaunchStates"]>) =>
    this.replay.readLaunchStates(...a)
  readTotalSupplies = (...a: Parameters<Chain["readTotalSupplies"]>) =>
    this.replay.readTotalSupplies(...a)
  readErc20Meta = (...a: Parameters<Chain["readErc20Meta"]>) => this.replay.readErc20Meta(...a)
  readErc20Names = async (tokens: string[]) => tokens.map(() => ({ symbol: null, name: null }))
  getBlockSenders = async () => null
  readBalances = async (pairs: unknown[]) => pairs.map(() => 0n)
  readMintStats = async () => null
  readMaxSupply = async () => null
  readTotalSupplyAt = async () => null
  hasCodeAt = async () => false
}

/** Every subset of the names, in binary counting order (the first is empty). */
const subsets = (names: readonly BackfillSource[]): BackfillSource[][] =>
  Array.from({ length: 2 ** names.length }, (_, mask) => names.filter((_n, i) => mask & (1 << i)))
const ALL = subsets(BACKFILL_SOURCES)
const label = (s: BackfillSource[]) => (s.length ? s.join("+") : "(none)")

const quiet = () => {}
/** The sources as `main.ts` runs them. The registry holds one pool until a reload replaces it. */
function sourcesFor(chain: Chain, sql: Sql) {
  const pools = new PoolRegistry()
  pools.add(
    {
      poolId: V4_POOL,
      poolManager: UNISWAP_V4_POOL_MANAGER,
      token: V4_TOKEN,
      launchId: V4_POOL,
      launchpad: "inkypump",
      quoteAsset: NATIVE_QUOTE_ASSET,
      tokenIsCurrency0: false,
      createdBlock: from,
    },
    10n ** 27n,
  )
  return [
    inkypumpSource({ sql, chain, pools, logger: quiet }),
    v4Source({ sql, chain, pools, logger: quiet }),
    nftSource({ sql, chain, logger: quiet }),
  ]
}

describe("merged eth_getLogs requests, per-filter path against merged path", () => {
  const { logs: pool, extra } = buildPool()
  const stub = {} as Sql
  const sources = sourcesFor(new PoolChain(pool), stub)

  it("the pool covers every source with real logs and includes the over-fetch cases", () => {
    const chain = new PoolChain(pool)
    const hits = (f: LogFilter) => pool.filter((l) => matchesFilter(l, f)).length
    for (const s of sources)
      for (const f of s.filters())
        expect(hits(f!), `${s.name} ${JSON.stringify(f)}`).toBeGreaterThan(0)
    expect(extra).toHaveLength(12)
    expect(chain.asked).toEqual([])
  })

  const rows: string[] = []
  for (const only of ALL) {
    it(`logs per source are identical and requests drop: ${label(only)}`, async () => {
      const filters = sources.map((s) => s.filters(only))
      const old = new PoolChain(pool)
      const merged = new PoolChain(pool)
      const a = await readLogs(old, filters, from, to, false)
      const b = await readLogs(merged, filters, from, to, true)
      expect(b.logs).toEqual(a.logs)
      expect(b.toBlock).toBe(a.toBlock)
      // Each log array is in (block, log index) order.
      for (const ls of b.logs.flat())
        expect(ls.map((l) => [l.blockNumber, l.logIndex])).toEqual(
          [...ls]
            .sort((x, y) => Number(x.blockNumber - y.blockNumber) || x.logIndex - y.logIndex)
            .map((l) => [l.blockNumber, l.logIndex]),
        )
      const enabled = filters.flat().filter((f) => f !== null).length
      expect(old.asked).toHaveLength(enabled)
      expect(merged.asked.length).toBeLessThanOrEqual(enabled)
      rows.push(`${label(only).padEnd(46)} ${enabled} -> ${merged.asked.length}`)
    })
  }

  it("prints the calls per tick for every subset", () => {
    console.log(`getLogs calls per tick, per-filter -> merged\n${rows.join("\n")}`)
    expect(rows).toHaveLength(ALL.length)
  })

  it("asks 10 requests before and 7 after when every group is on", async () => {
    const chain = new PoolChain(pool)
    await readLogs(
      chain,
      sources.map((s) => s.filters()),
      from,
      to,
    )
    expect(chain.asked).toHaveLength(7)
  })
})

describe("merged eth_getLogs requests, events and rows", () => {
  let sql: Sql
  beforeEach(async () => {
    sql = await resetDb(inject("databaseUrl"))
  })
  afterEach(() => sql.end())

  /** Columns set from the wall clock when a row is first written differ between two runs. */
  const stripClock = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).filter(([k]) => !/^(created_at|updated_at|next_\w+_at)$/.test(k)),
    )

  async function dump(): Promise<Record<string, unknown[]>> {
    const tables = await sql<{ t: string }[]>`
      select table_name as t from information_schema.tables
      where table_schema = 'indexer' and table_type = 'BASE TABLE'
        and table_name not in ('opensea_budget', 'migrations') order by 1`
    const out: Record<string, unknown[]> = {}
    for (const { t } of tables)
      out[t] = (
        await sql.unsafe(`select to_jsonb(x) as j from indexer.${t} x order by 1::text`)
      ).map((r) => stripClock(r.j))
    return out
  }

  async function run(only: BackfillSource[], merge: boolean) {
    await sql.end()
    sql = await resetDb(inject("databaseUrl"))
    const chain = new PoolChain(buildPool().logs)
    const idx = new Indexer({
      chain,
      store: createStore(sql),
      logger: quiet,
      sources: sourcesFor(chain, sql),
      mergeRequests: merge,
    })
    await idx.init()
    await idx.backfill(from, to, only)
    return { rows: await dump(), requests: chain.asked.length }
  }

  for (const only of ALL.filter((s) => s.length > 0)) {
    it(`writes identical events and rows: ${label(only)}`, async () => {
      const old = await run(only, false)
      const merged = await run(only, true)
      expect(merged.rows).toEqual(old.rows)
      expect(merged.requests).toBeLessThanOrEqual(old.requests)
      expect(Object.values(merged.rows).some((r) => r.length > 0)).toBe(true)
    })
  }
})
