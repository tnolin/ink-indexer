import type { Sql } from "@ink-indexer/db"
import {
  type ChainLog,
  DEAD_ADDRESS,
  decodeSwap,
  decodeTransfer,
  HOOKIT_BUYBACK,
  poolMarketCap,
  SWAP_TOPIC,
  swapEvent,
  swapLegs,
  TRANSFER_TOPIC,
  type V4Swap,
  ZERO_ADDRESS,
} from "@ink-indexer/sdk"
import { type Address, type Hash, pad } from "viem"
import type { Chain } from "../../chain"
import { BlockNotServedError } from "../../errors"
import type { Logger } from "../../log"
import type { LogFilter } from "../../rpc"
import type { AthRow, TradeRow } from "../inkypump/index"
import type { PoolEntry, PoolRegistry } from "../pools"
import { blockSendersFor, servedAt } from "../senders"
import { type EventRow, pick, type Source } from "../source"
import { deadAbove, resetDead, resetSupply, supplyAbove, writeRows } from "./store"

export type PoolTradeRow = TradeRow & { poolId: Hash }
export type DeadRow = { token: Address; balance: bigint; block: bigint }
export type SupplyRow = { token: Address; totalSupply: bigint; block: bigint }
export type RollbackReads = { dead: DeadRow[]; supply: SupplyRow[] }
export type V4Batch = {
  trades: PoolTradeRow[]
  events: EventRow[]
  /** Tokens (or, with several markets, pools) whose ath rose in this span, with the ath at the span's end. */
  ath: AthRow[]
  /** Dead balances read or raised in this span, as they stand at its end. */
  dead: DeadRow[]
  /** Total supplies of Hookit tokens read or lowered by burns in this span, as they stand at its end. */
  supply: SupplyRow[]
  blocks: { number: bigint; hash: Hash }[]
}

type V4Chain = Pick<
  Chain,
  "getBlockNumber" | "getBlockSenders" | "readBalances" | "readTotalSupplies" | "getLogs"
>

type Kept =
  | { kind: "swap"; log: ChainLog; swap: V4Swap; pool: PoolEntry }
  | { kind: "burn"; log: ChainLog; token: Address; value: bigint }
  | { kind: "supplyBurn"; log: ChainLog; token: Address; value: bigint }

const DEAD_TOPIC = pad(DEAD_ADDRESS)
const ZERO_TOPIC = pad(ZERO_ADDRESS)

/** One request for the swaps of `poolIds`, whichever PoolManager holds each pool. */
const swapFilter = (managers: Address[], poolIds: Hash[]): LogFilter => ({
  address: managers,
  topics: [SWAP_TOPIC, poolIds],
})

/** Transfers of `tokens` to the dead address, and to the zero address, which only a Hookit token's burns use. */
const burnFilter = (tokens: Address[]): LogFilter => ({
  address: tokens,
  topics: [TRANSFER_TOPIC, null, [DEAD_TOPIC, ZERO_TOPIC]],
})

const managersOf = (pools: PoolRegistry, poolIds: Hash[]): Address[] => [
  ...new Set(poolIds.map((id) => pools.byId(id)!.poolManager)),
]

const byPosition = (a: Kept, b: Kept) =>
  a.log.blockNumber === b.log.blockNumber
    ? a.log.logIndex - b.log.logIndex
    : a.log.blockNumber < b.log.blockNumber
      ? -1
      : 1

/**
 * Swaps in the Uniswap v4 pools of the shared registry, whether the pool sits in Uniswap's or in
 * Calamari's PoolManager, and transfers of their tokens to the dead address. Each swap becomes a
 * `launchpad.swap` event and a pool trade, valued at the pool price on the supply outside the dead
 * address. A Hookit pool's own hook also buys from it; those swaps are not trades, and the next
 * swap's state already includes them. Transfers of a Hookit token to the zero address are
 * burns and lower its total supply. The InkyPump source owns the registry's lifecycle: it registers
 * pools, rolls back pool trades and ath, and reloads the registry.
 */
export function v4Source(deps: {
  sql: Sql
  chain: V4Chain
  logger: Logger
  pools: PoolRegistry
  /** Block-sender reads a backfill span keeps in flight; tests lower it. */
  blockReads?: number
}): Source<V4Batch, RollbackReads> {
  const { sql, chain, pools } = deps
  // The pool ids the last `filters` call asked for; null when the v4 group was not picked.
  let asked: Set<Hash> | null = null
  // The tokens whose burns that call asked for.
  let askedTokens = new Set<Address>()
  // Tokens this process started following at a reload. Burns between their stored balance's block
  // and the first span it sees were not seen, so the balance (and a Hookit token's total supply) is
  // read again. A reload that leaves the registry as it was adds none.
  const followed = new Set<Address>()
  const refresh = new Set<Address>()
  // Tokens read since the last write: a span that fails after its reads loses them, so a reload puts them back.
  const readSinceWrite = new Set<Address>()
  return {
    name: "v4",
    filters(only) {
      const poolIds = pools.poolIds()
      const tokens = pools.tokens()
      asked = only === undefined || only.includes("v4-swaps") ? new Set(poolIds) : null
      askedTokens = new Set(tokens)
      // Topic filters keep each response to tracked swaps and burns. Their topics past position 0
      // differ from every other filter's, so each is its own request.
      // With no pool registered a filter would match nothing useful, so none is sent; `readsLate` keeps `process` running so the pools other sources register in the span are read by `logsOfNewPools`.
      // shortcut: the poolId list grows with every bonded token and is sent on every request. Split it into several requests if an endpoint rejects the list's length.
      return [
        poolIds.length > 0
          ? pick(only, "v4-swaps", swapFilter(managersOf(pools, poolIds), poolIds))
          : null,
        tokens.length > 0 ? pick(only, "v4-swaps", burnFilter(tokens)) : null,
      ]
    },
    readsLate: (only) => only === undefined || only.includes("v4-swaps"),
    async process([swapLogs = [], burnLogs = []], { toBlock, live, readStateAt }) {
      const late = await logsOfNewPools(toBlock)
      const batch = await processLogs([...swapLogs, ...late.swaps], [...burnLogs, ...late.burns], {
        chain,
        pools,
        readDeadAt: readStateAt ?? (live ? toBlock : null),
        refresh,
        readSinceWrite,
        live,
        blockReads: deps.blockReads,
      })
      // Tokens registered in this process (by a launch source) have their state from their own
      // block, so a later reload must not read them again as if another process had added them.
      for (const t of pools.tokens()) followed.add(t)
      return batch
    },
    write: async (tx, batch) => {
      await writeRows(tx, batch)
      readSinceWrite.clear()
    },
    async prepareRollback(fork) {
      const tokens = await deadAbove(sql, fork)
      const balances =
        tokens.length === 0
          ? []
          : await chain.readBalances(
              tokens.map((token) => ({ token, holder: DEAD_ADDRESS })),
              fork,
            )
      const burned = await supplyAbove(sql, fork)
      const supplies = burned.length === 0 ? [] : await chain.readTotalSupplies(burned, fork)
      return {
        dead: tokens.map((token, i) => ({ token, balance: balances[i]!, block: fork })),
        supply: burned.map((token, i) => ({ token, totalSupply: supplies[i]!, block: fork })),
      }
    },
    async rollback(tx, _fork, reads) {
      await resetDead(tx, reads.dead)
      await resetSupply(tx, reads.supply)
    },
    // The InkyPump source's reload loads the registry, dead balances included.
    async reload() {
      const now = new Set(pools.tokens())
      for (const t of now)
        if (
          !followed.has(t) &&
          (pools.marks(t)?.deadBalance != null || pools.launchpadOf(t) === "hookit")
        )
          refresh.add(t)
      for (const t of readSinceWrite) if (now.has(t)) refresh.add(t)
      readSinceWrite.clear()
      for (const t of [...refresh]) if (!now.has(t)) refresh.delete(t)
      followed.clear()
      for (const t of now) followed.add(t)
    },
  }

  /**
   * Swaps of pools registered after `filters` ran, and transfers to the dead and zero addresses of
   * their tokens: a bond and the first swaps in its pool can fall in one span, and the span's
   * requests were built before the bond was processed.
   */
  async function logsOfNewPools(
    toBlock: bigint,
  ): Promise<{ swaps: ChainLog[]; burns: ChainLog[] }> {
    if (asked === null) return { swaps: [], burns: [] }
    const seen = asked
    const fresh = pools
      .poolIds()
      .map((id) => pools.byId(id)!)
      .filter((p) => !seen.has(p.poolId) && p.createdBlock <= toBlock)
    if (fresh.length === 0) return { swaps: [], burns: [] }
    const freshIds = fresh.map((p) => p.poolId)
    const freshTokens = [...new Set(fresh.map((p) => p.token))].filter((t) => !askedTokens.has(t))
    const read = async (filter: LogFilter) => {
      const logs: ChainLog[] = []
      let from = fresh.reduce((m, p) => (p.createdBlock < m ? p.createdBlock : m), toBlock)
      while (from <= toBlock) {
        const res = await chain.getLogs(from, toBlock, filter)
        if (res.toBlock < from) throw new BlockNotServedError(from)
        logs.push(...res.logs.filter((l) => l.blockNumber <= toBlock))
        from = res.toBlock + 1n
      }
      return logs
    }
    const swaps = await read(swapFilter(managersOf(pools, freshIds), freshIds))
    const burns = freshTokens.length === 0 ? [] : await read(burnFilter(freshTokens))
    for (const p of fresh) seen.add(p.poolId)
    for (const t of freshTokens) askedTokens.add(t)
    return { swaps, burns }
  }
}

/**
 * Turns one span of swap and burn logs into rows. Reads the dead balance of tokens that have none,
 * at `readDeadAt` or else at the head, and the senders of each block holding a kept swap. The total
 * supply of a Hookit token that has no read block, or that this process has just started following,
 * is read at the same block.
 */
export async function processLogs(
  swapLogs: ChainLog[],
  burnLogs: ChainLog[],
  deps: {
    chain: Pick<
      V4Chain,
      "getBlockNumber" | "getBlockSenders" | "readBalances" | "readTotalSupplies"
    >
    pools: PoolRegistry
    /** A block the endpoints already serve: the live tick's span end, or a backfill's live cursor block. Null reads at the head. */
    readDeadAt: bigint | null
    /** The live tick reads each block's senders when it reaches it; a backfill span reads them up front. */
    live: boolean
    blockReads?: number
    /** Tokens with a stored dead balance to read again; the ones read are removed. */
    refresh?: Set<Address>
    /** Receives the tokens whose state this span read, until the batch is written. */
    readSinceWrite?: Set<Address>
  },
): Promise<V4Batch> {
  const { chain, pools } = deps
  const batch: V4Batch = { trades: [], events: [], ath: [], dead: [], supply: [], blocks: [] }
  const dead = new Map<Address, DeadRow>()
  const supplies = new Map<Address, SupplyRow>()
  const isHookit = (token: Address) => pools.launchpadOf(token) === "hookit"

  // shortcut: outside the live tick the dead balance is read at one recent block (the live cursor's, or the head with no cursor). That covers pools seeded before swaps were indexed and every pool bonded during a backfill, so their backfilled swaps use today's burned amount. Read it at each pool's bond block on an archive node if a token turns out to have burned before the backfill. A Hookit token this process starts following has its supply read at that block too, so its backfilled swaps use that supply and only the burns after it are replayed.
  const unread = pools
    .tokens()
    .filter((t) => pools.marks(t)?.deadBalance === null || deps.refresh?.has(t))
  const unreadSupply = pools
    .tokens()
    .filter((t) => isHookit(t) && (pools.marks(t)?.supplyBlock == null || deps.refresh?.has(t)))
  if (unread.length > 0 || unreadSupply.length > 0) {
    const at = deps.readDeadAt ?? (await chain.getBlockNumber())
    const [balances, totals] = await servedAt(at, () =>
      Promise.all([
        unread.length === 0
          ? []
          : chain.readBalances(
              unread.map((token) => ({ token, holder: DEAD_ADDRESS })),
              at,
            ),
        unreadSupply.length === 0 ? [] : chain.readTotalSupplies(unreadSupply, at),
      ]),
    )
    unread.forEach((token, i) => {
      pools.setDead(token, balances[i]!, at)
      dead.set(token, { token, balance: balances[i]!, block: at })
    })
    unreadSupply.forEach((token, i) => {
      pools.setSupply(token, totals[i]!, at)
      supplies.set(token, { token, totalSupply: totals[i]!, block: at })
    })
    for (const token of [...unread, ...unreadSupply]) {
      deps.refresh?.delete(token)
      deps.readSinceWrite?.add(token)
    }
  }
  // A burn at or below the block its balance or supply was read at is already in that value.
  const deadReadAt = new Map(
    pools.tokens().map((t) => [t, pools.marks(t)?.deadBalanceBlock ?? null]),
  )
  const supplyReadAt = new Map(
    pools
      .tokens()
      .filter(isHookit)
      .map((t) => [t, pools.marks(t)?.supplyBlock ?? null]),
  )

  const kept: Kept[] = []
  for (const log of swapLogs) {
    const swap = decodeSwap(log)
    const pool = swap && pools.byId(swap.poolId)
    // A pool's swaps count only when its own PoolManager emits them.
    if (!swap || !pool || log.address.toLowerCase() !== pool.poolManager) continue
    // A swap that moves no token is neither a buy nor a sell.
    if (swapLegs(swap, pool.tokenIsCurrency0).tokenAmount === 0n) continue
    // A Hookit pool's own hook buys from it. That moves the price, which every later swap carries in
    // its own post-swap state, and is not a trade.
    if (pool.launchpad === "hookit" && pool.hook !== undefined && swap.sender === pool.hook)
      continue
    kept.push({ kind: "swap", log, swap, pool })
  }
  for (const log of burnLogs) {
    const t = decodeTransfer(log)
    if (!t) continue
    const token = log.address.toLowerCase() as Address
    if (t.to === DEAD_ADDRESS && deadReadAt.has(token))
      kept.push({ kind: "burn", log, token, value: t.value })
    // Another launchpad's burn to the zero address is already in the supply it reads (ink.fun) or
    // is a vault balance it leaves out (Tsunami).
    else if (t.to === ZERO_ADDRESS && supplyReadAt.has(token))
      kept.push({ kind: "supplyBurn", log, token, value: t.value })
  }
  kept.sort(byPosition)

  const grouped = groupByBlock(kept)
  const swapBlocks = [...grouped]
    .filter(([, items]) => items.some((i) => i.kind === "swap"))
    .map(([blockNumber]) => blockNumber)
  const senders = await blockSendersFor(chain, swapBlocks, {
    live: deps.live,
    limit: deps.blockReads,
  })

  // The ath before this span, by token or, for a token with several markets, by pool.
  const athBefore = new Map<string, { token: Address; poolId?: Hash; ath: bigint }>()
  for (const [blockNumber, items] of grouped) {
    const blockHash = items[0]!.log.blockHash
    batch.blocks.push({ number: blockNumber, hash: blockHash })
    const block = items.some((i) => i.kind === "swap") ? await senders(blockNumber) : null
    // The logs and the block can come from different endpoints on either side of a reorg.
    if (block && block.hash !== blockHash) throw new BlockNotServedError(blockNumber)

    for (const item of items) {
      if (item.kind === "burn") {
        const at = deadReadAt.get(item.token)
        if (at === null || at === undefined || blockNumber <= at) continue
        pools.addBurn(item.token, item.value, blockNumber)
        const m = pools.marks(item.token)!
        dead.set(item.token, { token: item.token, balance: m.deadBalance!, block: blockNumber })
        continue
      }
      if (item.kind === "supplyBurn") {
        const at = supplyReadAt.get(item.token)
        if (at === null || at === undefined || blockNumber <= at) continue
        pools.burnSupply(item.token, item.value, blockNumber)
        const m = pools.marks(item.token)!
        supplies.set(item.token, {
          token: item.token,
          totalSupply: m.totalSupply!,
          block: blockNumber,
        })
        continue
      }
      const { log, swap, pool } = item
      const m = pools.marks(pool.token)!
      const supply = (m.totalSupply ?? 0n) - (m.deadBalance ?? 0n)
      if (!block) throw new BlockNotServedError(blockNumber)

      const multi = pools.marketCount(pool.token) > 1
      const athKey = multi ? pool.poolId : pool.token
      if (!athBefore.has(athKey))
        athBefore.set(athKey, {
          token: pool.token,
          ...(multi && { poolId: pool.poolId }),
          ath: multi ? (pools.poolMarks(pool.poolId)?.ath ?? 0n) : m.ath,
        })
      const athMarketCap = pools.bumpAth(
        pool.token,
        poolMarketCap(swap.sqrtPriceX96, pool.tokenIsCurrency0, supply),
        blockNumber,
        pool.poolId,
      )
      // shortcut: concentrated liquidity is valued with the launch's tick range only; positions the hook adds later (Deepen LPs) at other ranges are counted as if they shared it. Read positions from the PoolManager if a pool's figures drift from the launchpad's.
      const state = {
        launchpad: pool.launchpad,
        token: pool.token,
        launchId: pool.launchId,
        poolManager: pool.poolManager,
        tokenIsCurrency0: pool.tokenIsCurrency0,
        quoteAsset: pool.quoteAsset,
        supply,
        athMarketCap,
        tickLower: pool.tickLower,
        tickUpper: pool.tickUpper,
      }
      const trader =
        swap.sender === HOOKIT_BUYBACK
          ? HOOKIT_BUYBACK
          : (pools.traderOf(log.transactionHash, swap.sender) ??
            block.senders.get(log.transactionHash))
      if (!trader) throw new BlockNotServedError(blockNumber)
      const event = swapEvent(
        swap,
        { ...state, trader },
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

  for (const { token, poolId, ath } of athBefore.values()) {
    const cur = poolId === undefined ? pools.marks(token) : pools.poolMarks(poolId)
    if (cur && cur.ath > ath && cur.athBlock !== null)
      batch.ath.push({ token, marketCap: cur.ath, block: cur.athBlock, ...(poolId && { poolId }) })
  }
  batch.dead = [...dead.values()]
  batch.supply = [...supplies.values()]
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
