import { afterAll, beforeEach, expect, inject, it } from "vitest"
import { connect, type Sql } from "../src/index"
import { resetDb } from "../src/testing"

let sql: Sql
const other = connect(inject("databaseUrl"))
afterAll(async () => {
  await sql.end()
  await other.end()
})

/** Puts the budget in a known state. Refill is off unless given, so counts do not depend on timing. */
async function setBudget(
  tokens: number,
  capacity = tokens,
  refillPerS = 0,
  extra: { idleSeconds?: number } = {},
) {
  await sql`
    update indexer.opensea_budget set
      tokens = ${tokens}, capacity = ${capacity}, refill_per_s = ${refillPerS},
      updated_at = now() - ${extra.idleSeconds ?? 0} * interval '1 second',
      blocked_until = 'epoch'`
}
const take = async (db: Sql, c: number) =>
  (await db<{ w: number }[]>`select indexer.opensea_take(${c}) as w`)[0]!.w
const tokens = async () =>
  (await sql<{ tokens: number }[]>`select tokens from indexer.opensea_budget`)[0]!.tokens

beforeEach(async () => {
  if (sql) await sql.end()
  sql = await resetDb(inject("databaseUrl"))
})

it("starts with one row at 500 an hour so a reader can take before the indexer configures it", async () => {
  const rows = await sql`select * from indexer.opensea_budget`
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 1, tokens: 500, capacity: 500 })
  expect(rows[0]!.refill_per_s).toBeCloseTo(500 / 3600, 9)
  await expect(
    sql`insert into indexer.opensea_budget (id, tokens, capacity, refill_per_s) values (2, 1, 1, 1)`,
  ).rejects.toThrow(/check constraint|violates/)
  expect(await take(sql, 0)).toBe(0)
})

it("two concurrent clients never take more than capacity", async () => {
  await setBudget(20)
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => take(i % 2 === 0 ? sql : other, 0)),
  )
  expect(results.filter((w) => w === 0)).toHaveLength(20)
  for (const w of results.filter((w) => w !== 0)) expect(w).toBeGreaterThanOrEqual(50)
  expect(await tokens()).toBeCloseTo(0, 6)
})

it("class 4 stops at 50%, class 0 drains to 0", async () => {
  await setBudget(100)
  let n4 = 0
  while ((await take(sql, 4)) === 0) n4++
  expect(n4).toBe(50)
  expect(await take(sql, 4)).toBeGreaterThanOrEqual(50)
  let n0 = 0
  while ((await take(sql, 0)) === 0) n0++
  expect(n0).toBe(50)
  expect(await tokens()).toBeCloseTo(0, 6)
})

it("opensea_block never blocks for more than an hour", async () => {
  await setBudget(100)
  await sql`select indexer.opensea_block(2147483647)`
  const [row] = await sql<{ left: number }[]>`
    select extract(epoch from blocked_until - now())::float8 as left from indexer.opensea_budget`
  expect(row!.left).toBeGreaterThan(3500)
  expect(row!.left).toBeLessThanOrEqual(3600)
  await sql`select indexer.opensea_block(-5)` // negative is no block
  expect(await take(sql, 0)).toBeLessThanOrEqual(3_600_000)
})

it("the budget starts unblocked, with a finite blocked_until", async () => {
  const [row] = await sql<
    { b: string }[]
  >`select blocked_until::text as b from indexer.opensea_budget`
  expect(row!.b).toMatch(/1970-01-01/)
})

it("each class stops at its own floor", async () => {
  const floors = [0, 5, 10, 25, 50]
  for (const [c, floor] of floors.entries()) {
    await setBudget(100)
    let n = 0
    while ((await take(sql, c)) === 0) n++
    expect(n, `class ${c}`).toBe(100 - floor)
  }
})

it("reports how long to wait for the tokens to refill, at least 50 ms", async () => {
  await setBudget(10, 100, 1)
  // class 4 needs tokens - 1 >= 50, so 41 tokens more at 1 a second.
  const wait = await take(sql, 4)
  expect(wait).toBeGreaterThan(40_000)
  expect(wait).toBeLessThanOrEqual(41_100)
  await setBudget(10)
  await sql`select indexer.opensea_block(5)`
  expect(await take(sql, 0)).toBe(50)
})

it("tells a caller to wait an hour, not 50 ms, when nothing will ever refill", async () => {
  await setBudget(10, 100, 0)
  expect(await take(sql, 4)).toBe(3_600_000)
})

it("rejects a class outside 0 to 4", async () => {
  await expect(take(sql, 5)).rejects.toThrow(/class/)
  await expect(take(sql, -1)).rejects.toThrow(/class/)
})

it("blocked_until stops every class", async () => {
  await setBudget(100)
  await sql`select indexer.opensea_block(60000)`
  for (const c of [0, 1, 2, 3, 4]) {
    const wait = await take(sql, c)
    expect(wait).toBeGreaterThan(50_000)
    expect(wait).toBeLessThanOrEqual(60_000)
  }
  expect(await tokens()).toBe(100)
  await sql`select indexer.opensea_block(1000)`
  const [row] = await sql<{ left: number }[]>`
    select extract(epoch from blocked_until - now())::float8 as left from indexer.opensea_budget`
  expect(row!.left).toBeGreaterThan(50) // block never shortens an earlier one
  await sql`update indexer.opensea_budget set blocked_until = now() - interval '1 second'`
  expect(await take(sql, 0)).toBe(0)
})

it("refill after idle is capped at capacity", async () => {
  await setBudget(0, 500, 500 / 3600, { idleSeconds: 36_000 })
  expect(await take(sql, 0)).toBe(0)
  const t = await tokens()
  expect(t).toBeGreaterThan(498.9)
  expect(t).toBeLessThanOrEqual(499)
})

it("refills while idle", async () => {
  await setBudget(0, 500, 500 / 3600, { idleSeconds: 3600 / 2 })
  expect(await take(sql, 0)).toBe(0)
  expect(await tokens()).toBeCloseTo(249, 0)
})

it("configure sets capacity and refill and caps tokens", async () => {
  await sql`select indexer.opensea_configure(7200)`
  const [row] = await sql`select tokens, capacity, refill_per_s from indexer.opensea_budget`
  expect(row).toMatchObject({ capacity: 7200, refill_per_s: 2 })
  expect(row!.tokens).toBeLessThanOrEqual(7200)
  await setBudget(500, 500)
  await sql`select indexer.opensea_configure(100)`
  const [after] = await sql`select tokens, capacity from indexer.opensea_budget`
  expect(after).toMatchObject({ tokens: 100, capacity: 100 })
  await expect(sql`select indexer.opensea_configure(0)`).rejects.toThrow(/per_hour/)
})

it("a role with only EXECUTE can take and block", async () => {
  const role = "opensea_budget_test_role"
  await sql.unsafe(`drop role if exists ${role}`)
  await sql.unsafe(`create role ${role}`)
  try {
    await sql.unsafe(`grant usage on schema indexer to ${role}`)
    // Not granted yet: the functions are not open to everyone.
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`)
        await tx`select indexer.opensea_take(0)`
      }),
    ).rejects.toThrow(/permission denied/)
    await sql.unsafe(
      `grant execute on function indexer.opensea_take(int), indexer.opensea_block(int) to ${role}`,
    )
    await setBudget(10)
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`)
      const [r] = await tx<{ w: number }[]>`select indexer.opensea_take(0) as w`
      expect(r!.w).toBe(0)
      await tx`select indexer.opensea_block(5000)`
    })
    expect(await tokens()).toBeCloseTo(9, 3)
    expect(await take(sql, 0)).toBeGreaterThan(0) // the block landed
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`)
        await tx`select * from indexer.opensea_budget`
      }),
    ).rejects.toThrow(/permission denied/)
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`)
        await tx`select indexer.opensea_configure(1)`
      }),
    ).rejects.toThrow(/permission denied/)
  } finally {
    await sql.unsafe(`drop owned by ${role}`)
    await sql.unsafe(`drop role ${role}`)
  }
})
