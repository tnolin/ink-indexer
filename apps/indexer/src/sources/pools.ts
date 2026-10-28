import type { Sql } from "@ink-indexer/db"
import type { LaunchpadKey } from "@ink-indexer/events"
import type { Address, Hash } from "viem"

export type PoolEntry = {
  poolId: Hash
  poolManager: Address
  token: Address
  launchpad: LaunchpadKey
  quoteAsset: Address
  tokenIsCurrency0: boolean
  createdBlock: bigint
}

export type TokenMarks = {
  /** Null only for a token seen through a curve trade and not yet bonded. */
  totalSupply: bigint | null
  ath: bigint
  athBlock: bigint | null
  deadBalance: bigint | null
  deadBalanceBlock: bigint | null
}

type PoolRow = {
  pool_id: Hash
  pool_manager: Address
  token: Address
  launchpad: LaunchpadKey
  quote_asset: Address
  token_is_currency0: boolean
  created_block: bigint
}

type MarkRow = {
  address: Address
  total_supply: string
  ath_market_cap: string | null
  ath_block: bigint | null
  dead_balance: string | null
  dead_balance_block: bigint | null
}

const big = (v: string | null) => (v === null ? null : BigInt(v))

/** Pools and per-token marks shared by the sources that write and read pool trades. */
export class PoolRegistry {
  private pools = new Map<Hash, PoolEntry>()
  private marksByToken = new Map<Address, TokenMarks>()

  byId(poolId: Hash): PoolEntry | undefined {
    return this.pools.get(poolId)
  }

  poolIds(): Hash[] {
    return [...this.pools.keys()]
  }

  tokens(): Address[] {
    return [...new Set([...this.pools.values()].map((p) => p.token))]
  }

  add(p: PoolEntry, totalSupply: bigint): void {
    this.pools.set(p.poolId, p)
    const m = this.marksByToken.get(p.token)
    if (m) m.totalSupply = totalSupply
    else this.marksByToken.set(p.token, { ...emptyMarks(), totalSupply })
  }

  marks(token: Address): TokenMarks | undefined {
    return this.marksByToken.get(token)
  }

  /** Raises the token's ath to `marketCap` when it is higher, and returns the ath after the bump. */
  bumpAth(token: Address, marketCap: bigint, block: bigint): bigint {
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

  /** Adds a transfer to the dead address to a balance that has been read. */
  addBurn(token: Address, value: bigint, block: bigint): void {
    const m = this.marksByToken.get(token)
    if (!m || m.deadBalance === null) return
    m.deadBalance += value
    m.deadBalanceBlock = block
  }

  async load(sql: Sql): Promise<void> {
    const pools = await sql<PoolRow[]>`
      select pool_id, pool_manager, token, launchpad, quote_asset, token_is_currency0, created_block
      from indexer.pools`
    const marks = await sql<MarkRow[]>`
      select t.address, t.total_supply::text, t.ath_market_cap::text as ath_market_cap, t.ath_block,
             t.dead_balance::text as dead_balance, t.dead_balance_block
      from indexer.tokens t
      where t.ath_market_cap is not null
         or exists (select 1 from indexer.pools p where p.token = t.address)`
    this.pools = new Map(
      pools.map((r) => [
        r.pool_id,
        {
          poolId: r.pool_id,
          poolManager: r.pool_manager,
          token: r.token,
          launchpad: r.launchpad,
          quoteAsset: r.quote_asset,
          tokenIsCurrency0: r.token_is_currency0,
          createdBlock: BigInt(r.created_block),
        },
      ]),
    )
    this.marksByToken = new Map(
      marks.map((r) => [
        r.address,
        {
          totalSupply: BigInt(r.total_supply),
          ath: big(r.ath_market_cap) ?? 0n,
          athBlock: r.ath_block === null ? null : BigInt(r.ath_block),
          deadBalance: big(r.dead_balance),
          deadBalanceBlock: r.dead_balance_block === null ? null : BigInt(r.dead_balance_block),
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
})
