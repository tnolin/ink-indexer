import type { Sql } from "@ink-indexer/db"
import {
  type ChainLog,
  DEAD_ADDRESS,
  decodeSwap,
  decodeTransfer,
  poolMarketCap,
  SWAP_TOPIC,
  swapEvent,
  swapLegs,
  TRANSFER_TOPIC,
  UNISWAP_V4_POOL_MANAGER,
  type V4Swap,
} from "@ink-indexer/sdk"
import { type Address, type Hash, pad } from "viem"
import type { Chain } from "../../chain"
import { BlockNotServedError } from "../../errors"
import type { Logger } from "../../log"
import type { LogFilter } from "../../rpc"
import type { AthRow, TradeRow } from "../inkypump/index"
import type { PoolEntry, PoolRegistry } from "../pools"
import { type EventRow, pick, type Source } from "../source"
import { deadAbove, writeDead, writeRows } from "./store"

export type PoolTradeRow = TradeRow & { poolId: Hash }
export type DeadRow = { token: Address; balance: bigint; block: bigint }
export type DeadReads = DeadRow[]
export type V4Batch = {
  trades: PoolTradeRow[]
  events: EventRow[]
  /** Tokens whose ath rose in this span, with the ath at the span's end. */
  ath: AthRow[]
  /** Dead balances read or raised in this span, as they stand at its end. */
  dead: DeadRow[]
  blocks: { number: bigint; hash: Hash }[]
}

type V4Chain = Pick<Chain, "getBlockNumber" | "getBlockSenders" | "readBalances" | "getLogs">

type Kept =
  | { kind: "swap"; log: ChainLog; swap: V4Swap; pool: PoolEntry }
  | { kind: "burn"; log: ChainLog; token: Address; value: bigint }

const DEAD_TOPIC = pad(DEAD_ADDRESS)

const swapFilter = (poolIds: Hash[]): LogFilter => ({
  address: UNISWAP_V4_POOL_MANAGER,
  topics: [SWAP_TOPIC, poolIds],
})

const byPosition = (a: Kept, b: Kept) =>
  a.log.blockNumber === b.log.blockNumber
    ? a.log.logIndex - b.log.logIndex
    : a.log.blockNumber < b.log.blockNumber
      ? -1
      : 1

/**
 * Swaps in the Uniswap v4 pools of the shared registry, and transfers of their tokens to the dead
 * address. Each swap becomes a `launchpad.swap` event and a pool trade, valued at the pool price
 * on the supply outside the dead address. The InkyPump source owns the registry's lifecycle: it
 * registers pools, rolls back pool trades and ath, and reloads the registry.
 */
export function v4Source(deps: {
  sql: Sql
  chain: V4Chain
  logger: Logger
  pools: PoolRegistry
}): Source<V4Batch, DeadReads> {
  const { sql, chain, pools } = deps
  // The pool ids the last `filters` call asked for; null when the v4 group was not picked.
  let asked: Set<Hash> | null = null
  return {
    name: "v4",
    filters(only) {
      const poolIds = pools.poolIds()
      const tokens = pools.tokens()
      asked = only === undefined || only.includes("v4-swaps") ? new Set(poolIds) : null
      // Topic filters keep each response to tracked swaps and burns. Their topics past position 0
      // differ from every other filter's, so each is its own request.
      // shortcut: the poolId list grows with every bonded token and is sent on every request. Split it into several requests if an endpoint rejects the list's length.
      return [
        poolIds.length > 0 ? pick(only, "v4-swaps", swapFilter(poolIds)) : null,
        tokens.length > 0
          ? pick(only, "v4-swaps", {
              address: tokens,
              topics: [TRANSFER_TOPIC, null, DEAD_TOPIC],
            })
          : null,
      ]
    },
    async process([swapLogs = [], burnLogs = []], { toBlock }) {
      const late = await swapsOfNewPools(toBlock)
      return processLogs([...swapLogs, ...late], burnLogs, { chain, pools })
    },
    write: writeRows,
    async prepareRollback(fork) {
      const tokens = await deadAbove(sql, fork)
      if (tokens.length === 0) return []
      const balances = await chain.readBalances(
        tokens.map((token) => ({ token, holder: DEAD_ADDRESS })),
        fork,
      )
      return tokens.map((token, i) => ({ token, balance: balances[i]!, block: fork }))
    },
    rollback: (tx, _fork, reads) => writeDead(tx, reads),
    // The InkyPump source's reload loads the registry, dead balances included.
    async reload() {},
  }

  /**
   * Swaps of pools registered after `filters` ran: a bond and the first swaps in its pool can
   * fall in one span, and the span's requests were built before the bond was processed.
   */
  async function swapsOfNewPools(toBlock: bigint): Promise<ChainLog[]> {
    if (asked === null) return []
    const seen = asked
    const fresh = pools
      .poolIds()
      .map((id) => pools.byId(id)!)
      .filter((p) => !seen.has(p.poolId) && p.createdBlock <= toBlock)
    if (fresh.length === 0) return []
    const filter = swapFilter(fresh.map((p) => p.poolId))
    const logs: ChainLog[] = []
    let from = fresh.reduce((m, p) => (p.createdBlock < m ? p.createdBlock : m), toBlock)
    while (from <= toBlock) {
      const res = await chain.getLogs(from, toBlock, filter)
      if (res.toBlock < from) throw new BlockNotServedError(from)
      logs.push(...res.logs.filter((l) => l.blockNumber <= toBlock))
      from = res.toBlock + 1n
    }
    for (const p of fresh) seen.add(p.poolId)
    return logs
  }
}

/**
 * Turns one span of swap and burn logs into rows. Reads the dead balance of tokens that have none,
 * and the senders of each block holding a kept swap.
 */
export async function processLogs(
  swapLogs: ChainLog[],
  burnLogs: ChainLog[],
  deps: {
    chain: Pick<V4Chain, "getBlockNumber" | "getBlockSenders" | "readBalances">
    pools: PoolRegistry
  },
): Promise<V4Batch> {
  const { chain, pools } = deps
  const batch: V4Batch = { trades: [], events: [], ath: [], dead: [], blocks: [] }
  const dead = new Map<Address, DeadRow>()

  // shortcut: the dead balance is read at head for pools seeded before swaps were indexed, so backfilled swaps use today's burned amount. Read it at each pool's bond block on an archive node if a token turns out to have burned before the backfill.
  const unread = pools.tokens().filter((t) => pools.marks(t)?.deadBalance === null)
  if (unread.length > 0) {
    const head = await chain.getBlockNumber()
    const balances = await chain.readBalances(
      unread.map((token) => ({ token, holder: DEAD_ADDRESS })),
      head,
    )
    unread.forEach((token, i) => {
      pools.setDead(token, balances[i]!, head)
      dead.set(token, { token, balance: balances[i]!, block: head })
    })
  }
  // A burn at or below the block its balance was read at is already in that balance.
  const readAt = new Map(pools.tokens().map((t) => [t, pools.marks(t)?.deadBalanceBlock ?? null]))

  const kept: Kept[] = []
  for (const log of swapLogs) {
    if (log.address.toLowerCase() !== UNISWAP_V4_POOL_MANAGER) continue
    const swap = decodeSwap(log)
    const pool = swap && pools.byId(swap.poolId)
    if (swap && pool) kept.push({ kind: "swap", log, swap, pool })
  }
  for (const log of burnLogs) {
    const t = decodeTransfer(log)
    const token = log.address.toLowerCase() as Address
    if (t && t.to === DEAD_ADDRESS && readAt.has(token))
      kept.push({ kind: "burn", log, token, value: t.value })
  }
  kept.sort(byPosition)

  const athBefore = new Map<Address, bigint>()
  for (const [blockNumber, items] of groupByBlock(kept)) {
    const blockHash = items[0]!.log.blockHash
    batch.blocks.push({ number: blockNumber, hash: blockHash })
    const block = items.some((i) => i.kind === "swap")
      ? await chain.getBlockSenders(blockNumber)
      : null
    // The logs and the block can come from different endpoints on either side of a reorg.
    if (block && block.hash !== blockHash) throw new BlockNotServedError(blockNumber)

    for (const item of items) {
      if (item.kind === "burn") {
        const at = readAt.get(item.token)
        if (at === null || at === undefined || blockNumber <= at) continue
        pools.addBurn(item.token, item.value, blockNumber)
        const m = pools.marks(item.token)!
        dead.set(item.token, { token: item.token, balance: m.deadBalance!, block: blockNumber })
        continue
      }
      if (!block) throw new BlockNotServedError(blockNumber)
      const { log, swap, pool } = item
      const trader = block.senders.get(log.transactionHash)
      if (!trader) throw new BlockNotServedError(blockNumber)
      const m = pools.marks(pool.token)!
      const supply = (m.totalSupply ?? 0n) - (m.deadBalance ?? 0n)
      if (!athBefore.has(pool.token)) athBefore.set(pool.token, m.ath)
      const athMarketCap = pools.bumpAth(
        pool.token,
        poolMarketCap(swap.sqrtPriceX96, pool.tokenIsCurrency0, supply),
        blockNumber,
      )
      const event = swapEvent(
        swap,
        {
          launchpad: pool.launchpad,
          token: pool.token,
          launchId: pool.launchId,
          poolManager: pool.poolManager,
          tokenIsCurrency0: pool.tokenIsCurrency0,
          quoteAsset: pool.quoteAsset,
          trader,
          supply,
          athMarketCap,
        },
        {
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber,
          blockTimestamp: block.timestamp,
        },
      )
      batch.events.push({ event, block: blockNumber, blockHash })
      const legs = swapLegs(swap, pool.tokenIsCurrency0)
      const buy = legs.side === "buy"
      batch.trades.push({
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        token: pool.token,
        poolId: pool.poolId,
        side: legs.side,
        trader,
        amountIn: buy ? legs.quoteAmount : legs.tokenAmount,
        amountOut: buy ? legs.tokenAmount : legs.quoteAmount,
        block: blockNumber,
      })
    }
  }

  for (const [token, before] of athBefore) {
    const m = pools.marks(token)!
    if (m.ath > before && m.athBlock !== null)
      batch.ath.push({ token, marketCap: m.ath, block: m.athBlock })
  }
  batch.dead = [...dead.values()]
  return batch
}

function groupByBlock(items: Kept[]): Map<bigint, Kept[]> {
  const groups = new Map<bigint, Kept[]>()
  for (const i of items) {
    const g = groups.get(i.log.blockNumber)
    if (g) g.push(i)
    else groups.set(i.log.blockNumber, [i])
  }
  return groups
}
