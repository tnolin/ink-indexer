import type { Sql } from "@ink-indexer/db"
import type { LaunchpadKey } from "@ink-indexer/events"
import type { Address, Hash } from "viem"

export type PoolEntry = {
  poolId: Hash
  poolManager: Address
  token: Address
  /** The launch's id on its launchpad, carried on every swap event. */
  launchId: Hash
  launchpad: LaunchpadKey
  quoteAsset: Address
  tokenIsCurrency0: boolean
  createdBlock: bigint
  /** The pool's hook, when it is one the source follows (a Hookit pool's swaps by it are its own buybacks). */
  hook?: Address
  /** The pool's liquidity range; absent for a full-range pool. */
  tickLower?: number
  tickUpper?: number
}

export type TokenMarks = {
  /** Null only for a token seen through a curve trade and not yet bonded. */
  totalSupply: bigint | null
  ath: bigint
  athBlock: bigint | null
  deadBalance: bigint | null
  deadBalanceBlock: bigint | null
  /** The block `totalSupply` was read at, for burns that must not be counted twice. */
  supplyBlock: bigint | null
}

/** The ath of one pool, kept for tokens with more than one market. */
export type PoolMarks = { ath: bigint; athBlock: bigint | null }

type PoolRow = {
  pool_id: Hash
  pool_manager: Address
  token: Address
  launch_id: Hash
  launchpad: LaunchpadKey
  quote_asset: Address
  token_is_currency0: boolean
  created_block: bigint
  hook: Address | null
  tick_lower: number | null
  tick_upper: number | null
  ath_market_cap: string | null
  ath_block: bigint | null
}

type MarkRow = {
  address: Address
  total_supply: string
  ath_market_cap: string | null
  ath_block: bigint | null
  dead_balance: string | null
  dead_balance_block: bigint | null
  total_supply_block: bigint | null
}

const big = (v: string | null) => (v === null ? null : BigInt(v))

/** Pools and per-token marks shared by the sources that write and read pool trades. */
export class PoolRegistry {
  private pools = new Map<Hash, PoolEntry>()
  private marksByToken = new Map<Address, TokenMarks>()
  private marksByPool = new Map<Hash, PoolMarks>()
  private poolsOfToken = new Map<Address, Set<Hash>>()
  private traderByTx = new Map<Hash, Address>()

  byId(poolId: Hash): PoolEntry | undefined {
    return this.pools.get(poolId)
  }

  poolIds(): Hash[] {
    return [...this.pools.keys()]
  }

  tokens(): Address[] {
    return [...new Set([...this.pools.values()].map((p) => p.token))]
  }

  /** `supplyBlock` is the block `totalSupply` was read at, for a token whose burns are followed. */
  add(p: PoolEntry, totalSupply: bigint, supplyBlock?: bigint): void {
    this.pools.set(p.poolId, p)
    this.indexPool(p)
    const m = this.marksByToken.get(p.token)
    if (m) {
      m.totalSupply = totalSupply
      if (supplyBlock !== undefined) m.supplyBlock = supplyBlock
    } else
      this.marksByToken.set(p.token, {
        ...emptyMarks(),
        totalSupply,
        supplyBlock: supplyBlock ?? null,
      })
  }

  /** The launchpad of a token's pools. */
  launchpadOf(token: Address): LaunchpadKey | undefined {
    const id = this.poolsOfToken.get(token)?.values().next().value
    return id === undefined ? undefined : this.pools.get(id)?.launchpad
  }

  /** How many pools the token trades in. */
  marketCount(token: Address): number {
    return this.poolsOfToken.get(token)?.size ?? 0
  }

  /**
   * Makes `trader` the trader of the pool swaps in a transaction, in place of the transaction's
   * sender. A source that learns the real trader from another log of the transaction (a launch's
   * dev buy, made by a factory on the creator's behalf) sets it before the swaps are processed.
   */
  setTraderOf(txHash: Hash, trader: Address): void {
    this.traderByTx.set(txHash, trader)
  }

  traderOf(txHash: Hash): Address | undefined {
    return this.traderByTx.get(txHash)
  }

  forgetTraderOf(txHash: Hash): void {
    this.traderByTx.delete(txHash)
  }

  marks(token: Address): TokenMarks | undefined {
    return this.marksByToken.get(token)
  }

  /** The ath of one pool of a token with more than one market. */
  poolMarks(poolId: Hash): PoolMarks | undefined {
    return this.marksByPool.get(poolId)
  }

  /**
   * Raises an ath to `marketCap` when it is higher, and returns the ath after the bump. A token with
   * more than one market keeps an ath per pool, because each pool's market cap is in its own quote
   * units; every other token keeps one ath.
   */
  bumpAth(token: Address, marketCap: bigint, block: bigint, poolId?: Hash): bigint {
    if (poolId !== undefined && (this.poolsOfToken.get(token)?.size ?? 0) > 1) {
      let pm = this.marksByPool.get(poolId)
      if (!pm) {
        pm = { ath: 0n, athBlock: null }
        this.marksByPool.set(poolId, pm)
      }
      if (marketCap > pm.ath) {
        pm.ath = marketCap
        pm.athBlock = block
      }
      return pm.ath
    }
    let m = this.marksByToken.get(token)
    if (!m) {
      m = emptyMarks()
      this.marksByToken.set(token, m)
    }
    if (marketCap > m.ath) {
      m.ath = marketCap
      m.athBlock = block
    }
    return m.ath
  }

  setDead(token: Address, balance: bigint, block: bigint): void {
    const m = this.marksByToken.get(token)
    if (!m) return
    m.deadBalance = balance
    m.deadBalanceBlock = block
  }

  /** Sets a total supply read at `block`. */
  setSupply(token: Address, supply: bigint, block: bigint): void {
    const m = this.marksByToken.get(token)
    if (!m) return
    m.totalSupply = supply
    m.supplyBlock = block
  }

  /** Lowers a supply that has been read by a burn at `block`; the supply never goes below zero. */
  burnSupply(token: Address, value: bigint, block: bigint): void {
    const m = this.marksByToken.get(token)
    if (!m || m.totalSupply === null) return
    m.totalSupply = m.totalSupply > value ? m.totalSupply - value : 0n
    m.supplyBlock = block
  }

  /** Adds a transfer to the dead address to a balance that has been read. */
  addBurn(token: Address, value: bigint, block: bigint): void {
    const m = this.marksByToken.get(token)
    if (!m || m.deadBalance === null) return
    m.deadBalance += value
    m.deadBalanceBlock = block
  }

  private indexPool(p: PoolEntry): void {
    const ids = this.poolsOfToken.get(p.token)
    if (ids) ids.add(p.poolId)
    else this.poolsOfToken.set(p.token, new Set([p.poolId]))
  }

  /**
   * Rebuilds pools and marks from the database. With `athAsOf`, each ath is the highest market cap
   * of its trades and swaps at or below that block (zero with none), the ath a run that reached that
   * block would hold; without it, the stored ath. A token with more than one market takes the ath
   * of each pool from that pool's own swaps.
   */
  async load(sql: Sql, opts: { athAsOf?: bigint } = {}): Promise<void> {
    const pools = await sql<PoolRow[]>`
      select p.pool_id, p.pool_manager, p.token, t.launch_id, p.launchpad, p.quote_asset,
             p.token_is_currency0, p.created_block, p.hook, p.tick_lower, p.tick_upper,
             p.ath_market_cap::text as ath_market_cap, p.ath_block
      from indexer.pools p join indexer.tokens t on t.address = p.token`
    const marks = await sql<MarkRow[]>`
      select t.address, t.total_supply::text, t.ath_market_cap::text as ath_market_cap, t.ath_block,
             t.dead_balance::text as dead_balance, t.dead_balance_block, t.total_supply_block
      from indexer.tokens t
      where t.ath_market_cap is not null
         or exists (select 1 from indexer.pools p where p.token = t.address)`
    const asOf = opts.athAsOf
    const aths =
      asOf === undefined
        ? []
        : await sql<{ address: Address; mc: string | null; block: bigint | null }[]>`
          select t.address, best.mc::text as mc, best.block
          from indexer.tokens t
          left join lateral (
            select (e.payload->>'marketCap')::numeric as mc, e.block
            from indexer.events e
            where e.entity = t.address and e.type in ('launchpad.trade', 'launchpad.swap')
              and e.block <= ${asOf.toString()}
            order by (e.payload->>'marketCap')::numeric desc, e.block
            limit 1
          ) best on true
          where t.ath_block > ${asOf.toString()}
            and (select count(*) from indexer.pools p where p.token = t.address) <= 1`
    const poolAths =
      asOf === undefined
        ? []
        : await sql<{ pool_id: Hash; mc: string | null; block: bigint | null }[]>`
          select p.pool_id, best.mc::text as mc, best.block
          from indexer.pools p
          left join lateral (
            select (e.payload->>'marketCap')::numeric as mc, e.block
            from indexer.events e
            where e.entity = p.token and e.type = 'launchpad.swap'
              and e.payload->>'poolId' = p.pool_id
              and e.block <= ${asOf.toString()}
            order by (e.payload->>'marketCap')::numeric desc, e.block
            limit 1
          ) best on true
          where p.ath_block > ${asOf.toString()}`
    const athOf = new Map(aths.map((r) => [r.address, r]))
    const poolAthOf = new Map(poolAths.map((r) => [r.pool_id, r]))
    this.pools = new Map(
      pools.map((r) => [
        r.pool_id,
        {
          poolId: r.pool_id,
          poolManager: r.pool_manager,
          token: r.token,
          launchId: r.launch_id,
          launchpad: r.launchpad,
          quoteAsset: r.quote_asset,
          tokenIsCurrency0: r.token_is_currency0,
          createdBlock: BigInt(r.created_block),
          ...(r.hook !== null && { hook: r.hook }),
          ...(r.tick_lower !== null && { tickLower: r.tick_lower }),
          ...(r.tick_upper !== null && { tickUpper: r.tick_upper }),
        },
      ]),
    )
    this.poolsOfToken = new Map()
    for (const p of this.pools.values()) this.indexPool(p)
    this.marksByPool = new Map()
    for (const r of pools) {
      const multi = (this.poolsOfToken.get(r.token)?.size ?? 0) > 1
      if (!multi) continue
      // A pool whose ath was set at or below the block is already the ath as of that block.
      const best = poolAthOf.get(r.pool_id)
      const mc = best ? best.mc : r.ath_market_cap
      const block = best ? best.block : r.ath_block
      this.marksByPool.set(r.pool_id, {
        ath: big(mc) ?? 0n,
        athBlock: block === null ? null : BigInt(block),
      })
    }
    const athFor = (r: MarkRow): Pick<TokenMarks, "ath" | "athBlock"> => {
      if (asOf === undefined)
        return {
          ath: big(r.ath_market_cap) ?? 0n,
          athBlock: r.ath_block === null ? null : BigInt(r.ath_block),
        }
      // An ath set at or below the block is already the ath as of that block.
      const best = athOf.get(r.address)
      if (!best)
        return {
          ath: big(r.ath_market_cap) ?? 0n,
          athBlock: r.ath_block === null ? null : BigInt(r.ath_block),
        }
      return {
        ath: big(best?.mc ?? null) ?? 0n,
        athBlock: best?.block == null ? null : BigInt(best.block),
      }
    }
    this.marksByToken = new Map(
      marks.map((r) => [
        r.address,
        {
          totalSupply: BigInt(r.total_supply),
          ...athFor(r),
          deadBalance: big(r.dead_balance),
          deadBalanceBlock: r.dead_balance_block === null ? null : BigInt(r.dead_balance_block),
          supplyBlock: r.total_supply_block === null ? null : BigInt(r.total_supply_block),
        },
      ]),
    )
  }
}

const emptyMarks = (): TokenMarks => ({
  totalSupply: null,
  ath: 0n,
  athBlock: null,
  deadBalance: null,
  deadBalanceBlock: null,
  supplyBlock: null,
})
