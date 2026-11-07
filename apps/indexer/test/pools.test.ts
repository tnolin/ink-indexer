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
      supplyBlock: null,
    })
  })

  describe("with several markets", () => {
    const WAAPLX: Address = "0x00000000000000000000000000000000000000c1"
    const WNVDAX: Address = "0x00000000000000000000000000000000000000c2"
    const P1: Hash = `0x${"01".repeat(32)}`
    const P2: Hash = `0x${"02".repeat(32)}`
    const hookEntry = (poolId: Hash, quoteAsset: Address): PoolEntry => ({
      ...entry(T1),
      poolId,
      launchpad: "hookit",
      quoteAsset,
      hook: HOOK,
      tickLower: -230_400,
      tickUpper: 887_220,
    })

    it("keeps one ath per pool for a token with two markets and the token ath for a single market", () => {
      const r = new PoolRegistry()
      r.add(hookEntry(P1, WAAPLX), 1000n)
      r.add(hookEntry(P2, WNVDAX), 1000n)
      r.add(entry(T2), 1000n)
      expect(r.bumpAth(T1, 900n, 5n, P1)).toBe(900n)
      expect(r.bumpAth(T1, 40n, 6n, P2)).toBe(40n)
      expect(r.bumpAth(T1, 30n, 7n, P2)).toBe(40n)
      expect(r.bumpAth(T1, 50n, 8n, P2)).toBe(50n)
      expect(r.poolMarks(P1)).toEqual({ ath: 900n, athBlock: 5n })
      expect(r.poolMarks(P2)).toEqual({ ath: 50n, athBlock: 8n })
      expect(r.marks(T1)).toMatchObject({ ath: 0n, athBlock: null })
      expect(r.bumpAth(T2, 70n, 9n, POOL)).toBe(70n)
      expect(r.bumpAth(T2, 60n, 10n, POOL)).toBe(70n)
      expect(r.marks(T2)).toMatchObject({ ath: 70n, athBlock: 9n })
      expect(r.poolMarks(POOL)).toBeUndefined()
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
      supplyBlock: null,
    })
    expect(r.marks(T2)).toEqual({
      totalSupply: 1000n,
      ath: 40n,
      athBlock: 3n,
      deadBalance: null,
      deadBalanceBlock: null,
      supplyBlock: null,
    })
    expect(r.tokens()).toEqual([T1])
  })

  it("with athAsOf, takes each token's ath from trades and swaps at or below that block", async () => {
    const p = entry(T1)
    await sql`insert into indexer.pools (pool_id, pool_manager, token, launchpad, quote_asset, token_is_currency0, created_block)
      values (${p.poolId}, ${p.poolManager}, ${p.token}, ${p.launchpad}, ${p.quoteAsset}, ${p.tokenIsCurrency0}, ${p.createdBlock})`
    const event = (n: number, type: string, token: Address, block: number, marketCap: string) =>
      sql`insert into indexer.events (type, entity, payload, block, block_hash, tx_hash, log_index, confirmed)
        values (${type}, ${token}, ${sql.json({ marketCap })}, ${block}, ${`0x${"0".repeat(63)}1`}, ${`0x${n.toString(16).padStart(64, "0")}`}, 0, true)`
    await event(1, "launchpad.trade", T1, 100, "5")
    await event(2, "launchpad.swap", T1, 150, "3")
    await event(3, "launchpad.swap", T1, 300, "9")
    await event(4, "launchpad.swap", T2, 250, "40")
    await sql`update indexer.tokens set ath_market_cap = 9, ath_block = 300 where address = ${T1}`
    await sql`update indexer.tokens set ath_market_cap = 40, ath_block = 250 where address = ${T2}`

    const asOf = new PoolRegistry()
    await asOf.load(sql, { athAsOf: 200n })
    expect(asOf.marks(T1)).toMatchObject({ ath: 5n, athBlock: 100n })
    expect(asOf.marks(T2)).toMatchObject({ ath: 0n, athBlock: null })

    const now = new PoolRegistry()
    await now.load(sql)
    expect(now.marks(T1)).toMatchObject({ ath: 9n, athBlock: 300n })
    expect(now.marks(T2)).toMatchObject({ ath: 40n, athBlock: 250n })
  })

  describe("with several markets", () => {
    const WAAPLX: Address = "0x00000000000000000000000000000000000000c1"
    const WNVDAX: Address = "0x00000000000000000000000000000000000000c2"
    const P1: Hash = `0x${"01".repeat(32)}`
    const P2: Hash = `0x${"02".repeat(32)}`
    const insertPool = (poolId: Hash, quote: Address, ath: [bigint, bigint] | null) =>
      sql`insert into indexer.pools (pool_id, pool_manager, token, launchpad, quote_asset, token_is_currency0,
          created_block, hook, tick_lower, tick_upper, ath_market_cap, ath_block)
        values (${poolId}, ${entry(T1).poolManager}, ${T1}, 'inkypump', ${quote}, false, 7, ${HOOK}, -230400, 887220,
          ${ath ? ath[0].toString() : null}, ${ath ? ath[1].toString() : null})`

    it("reload restores ticks, hook and per-pool ath", async () => {
      await insertPool(P1, WAAPLX, [900n, 5n])
      await insertPool(P2, WNVDAX, [40n, 6n])
      await insertPool(POOL, NATIVE, null)
      await sql`update indexer.tokens set total_supply_block = 4 where address = ${T1}`
      const r = new PoolRegistry()
      await r.load(sql)
      expect(r.byId(P1)).toMatchObject({ hook: HOOK, tickLower: -230_400, tickUpper: 887_220 })
      expect(r.byId(POOL)).toMatchObject({ hook: HOOK, tickLower: -230_400, tickUpper: 887_220 })
      expect(r.poolMarks(P1)).toEqual({ ath: 900n, athBlock: 5n })
      expect(r.poolMarks(P2)).toEqual({ ath: 40n, athBlock: 6n })
      expect(r.marks(T1)).toMatchObject({ supplyBlock: 4n })
      // A bump after the reload continues from each pool's own stored ath.
      expect(r.bumpAth(T1, 100n, 8n, P2)).toBe(100n)
      expect(r.bumpAth(T1, 100n, 8n, P1)).toBe(900n)
    })

    it("a single-market token keeps no per-pool mark after a reload", async () => {
      await insertPool(POOL, NATIVE, [50n, 5n])
      const r = new PoolRegistry()
      await r.load(sql)
      expect(r.poolMarks(POOL)).toBeUndefined()
    })

    it("a multi-market token's ath as of a block is not derived from its mixed-unit swaps", async () => {
      await insertPool(P1, WAAPLX, [4_000_000n, 300n])
      await insertPool(P2, WNVDAX, [9_000_000_000_000_000_000n, 310n])
      await sql`update indexer.tokens set ath_market_cap = 9000000000000000000, ath_block = 310 where address = ${T1}`
      await sql`insert into indexer.events (type, entity, payload, block, block_hash, tx_hash, log_index, confirmed)
        values ('launchpad.swap', ${T1}, ${sql.json({ marketCap: "7000000000000000000", poolId: P2 })}, 110, ${`0x${"0".repeat(63)}1`}, ${`0x${"1".padStart(64, "0")}`}, 0, true)`
      const r = new PoolRegistry()
      await r.load(sql, { athAsOf: 200n })
      // Its pools hold the ath of each market; the token-level ath keeps the stored value.
      expect(r.marks(T1)).toMatchObject({ ath: 9_000_000_000_000_000_000n, athBlock: 310n })
    })

    it("a pool without a hook or ticks reloads without them", async () => {
      const p = entry(T1)
      await sql`insert into indexer.pools (pool_id, pool_manager, token, launchpad, quote_asset, token_is_currency0, created_block)
        values (${p.poolId}, ${p.poolManager}, ${p.token}, ${p.launchpad}, ${p.quoteAsset}, ${p.tokenIsCurrency0}, ${p.createdBlock})`
      const r = new PoolRegistry()
      await r.load(sql)
      expect(r.byId(POOL)).toEqual(p)
    })

    it("with athAsOf, gives each pool its own ath from its own swaps at or below that block", async () => {
      // The WAAPLX market is quoted in USDG (6 decimals) and WNVDAX in an 18-decimal asset, so the larger raw number belongs to the other pool.
      await insertPool(P1, WAAPLX, [4_000_000n, 300n])
      await insertPool(P2, WNVDAX, [9_000_000_000_000_000_000n, 310n])
      const swap = (n: number, poolId: Hash, block: number, marketCap: string) =>
        sql`insert into indexer.events (type, entity, payload, block, block_hash, tx_hash, log_index, confirmed)
          values ('launchpad.swap', ${T1}, ${sql.json({ marketCap, poolId })}, ${block}, ${`0x${"0".repeat(63)}1`}, ${`0x${n.toString(16).padStart(64, "0")}`}, 0, true)`
      await swap(1, P1, 100, "2000000")
      await swap(2, P2, 110, "7000000000000000000")
      await swap(3, P1, 150, "3000000")
      await swap(4, P2, 160, "1000000000000000000")
      await swap(5, P1, 300, "4000000")
      await swap(6, P2, 310, "9000000000000000000")
      const r = new PoolRegistry()
      await r.load(sql, { athAsOf: 200n })
      expect(r.poolMarks(P1)).toEqual({ ath: 3_000_000n, athBlock: 150n })
      expect(r.poolMarks(P2)).toEqual({ ath: 7_000_000_000_000_000_000n, athBlock: 110n })

      const early = new PoolRegistry()
      await early.load(sql, { athAsOf: 105n })
      expect(early.poolMarks(P1)).toEqual({ ath: 2_000_000n, athBlock: 100n })
      expect(early.poolMarks(P2)).toEqual({ ath: 0n, athBlock: null })

      const now = new PoolRegistry()
      await now.load(sql)
      expect(now.poolMarks(P1)).toEqual({ ath: 4_000_000n, athBlock: 300n })
    })
  })

  it("with athAsOf, keeps the stored ath of a token whose ath was set at or below that block", async () => {
    await sql`update indexer.tokens set ath_market_cap = 40, ath_block = 150 where address = ${T2}`
    await sql`update indexer.tokens set ath_market_cap = 90, ath_block = 300 where address = ${T1}`
    const r = new PoolRegistry()
    await r.load(sql, { athAsOf: 200n })
    expect(r.marks(T2)).toMatchObject({ ath: 40n, athBlock: 150n })
    expect(r.marks(T1)).toMatchObject({ ath: 0n, athBlock: null })
  })
})
