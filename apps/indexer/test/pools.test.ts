import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { Address, Hash } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { type PoolEntry, PoolRegistry } from "../src/sources/pools"

const HOOK: Address = "0x00000000000000000000000000000000000000a1"
const NATIVE: Address = "0x0000000000000000000000000000000000000000"
const T1: Address = "0x0000000000000000000000000000000000000011"
const T2: Address = "0x0000000000000000000000000000000000000022"
const POOL: Hash = `0x${"ab".repeat(32)}`
const launchIdOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash

const entry = (token: Address): PoolEntry => ({
  poolId: POOL,
  poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
  token,
  launchId: launchIdOf(Number.parseInt(token.slice(-1), 16)),
  launchpad: "inkypump",
  quoteAsset: NATIVE,
  tokenIsCurrency0: false,
  createdBlock: 7n,
})

describe("PoolRegistry", () => {
  it("bumpAth keeps the maximum", () => {
    const r = new PoolRegistry()
    r.add(entry(T1), 1000n)
    expect(r.bumpAth(T1, 50n, 1n)).toBe(50n)
    expect(r.bumpAth(T1, 30n, 2n)).toBe(50n)
    expect(r.bumpAth(T1, 80n, 3n)).toBe(80n)
    expect(r.marks(T1)).toMatchObject({ ath: 80n, athBlock: 3n })
  })

  it("bumpAth on an unknown token creates its marks", () => {
    const r = new PoolRegistry()
    expect(r.bumpAth(T1, 5n, 9n)).toBe(5n)
    expect(r.marks(T1)).toEqual({
      totalSupply: null,
      ath: 5n,
      athBlock: 9n,
      deadBalance: null,
      deadBalanceBlock: null,
    })
  })

  it("add records the pool and the supply, and burns raise a read dead balance", () => {
    const r = new PoolRegistry()
    r.add(entry(T1), 1000n)
    expect(r.byId(POOL)?.token).toBe(T1)
    expect(r.poolIds()).toEqual([POOL])
    expect(r.tokens()).toEqual([T1])
    r.addBurn(T1, 5n, 2n)
    expect(r.marks(T1)?.deadBalance).toBeNull()
    r.setDead(T1, 10n, 3n)
    r.addBurn(T1, 5n, 4n)
    expect(r.marks(T1)).toMatchObject({
      totalSupply: 1000n,
      deadBalance: 15n,
      deadBalanceBlock: 4n,
    })
  })
})

describe("PoolRegistry.load", () => {
  let sql: Sql
  beforeEach(async () => {
    sql = await resetDb(inject("databaseUrl"))
    await sql`insert into indexer.hooks (address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block)
      values (${HOOK}, 'inkypump', 'native', 'x', ${NATIVE}, 18, 1)`
    for (const [t, n] of [
      [T1, 1],
      [T2, 2],
    ] as const) {
      await sql`insert into indexer.tokens (address, launchpad, hook, launch_id, creator, created_block, created_at,
          quote_asset, total_supply, target_raise, sale_supply, gain_bps)
        values (${t}, 'inkypump', ${HOOK}, ${launchIdOf(n)}, ${HOOK}, 1, now(), ${NATIVE}, 1000, 1, 1, 0)`
    }
  })
  afterEach(() => sql.end())

  it("round-trips, including a token with an ath and no pool", async () => {
    const p = entry(T1)
    await sql`insert into indexer.pools (pool_id, pool_manager, token, launchpad, quote_asset, token_is_currency0, created_block)
      values (${p.poolId}, ${p.poolManager}, ${p.token}, ${p.launchpad}, ${p.quoteAsset}, ${p.tokenIsCurrency0}, ${p.createdBlock})`
    await sql`update indexer.tokens set ath_market_cap = 900, ath_block = 5, dead_balance = 12, dead_balance_block = 6
      where address = ${T1}`
    await sql`update indexer.tokens set ath_market_cap = 40, ath_block = 3 where address = ${T2}`
    const r = new PoolRegistry()
    await r.load(sql)
    expect(r.byId(POOL)).toEqual(p)
    expect(r.marks(T1)).toEqual({
      totalSupply: 1000n,
      ath: 900n,
      athBlock: 5n,
      deadBalance: 12n,
      deadBalanceBlock: 6n,
    })
    expect(r.marks(T2)).toEqual({
      totalSupply: 1000n,
      ath: 40n,
      athBlock: 3n,
      deadBalance: null,
      deadBalanceBlock: null,
    })
    expect(r.tokens()).toEqual([T1])
  })
})
