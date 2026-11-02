import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { afterEach, beforeEach, expect, inject, it } from "vitest"
import { createBudget } from "../src/sources/opensea/budget"

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

it("take returns true while the bucket has tokens above the class floor", async () => {
  await sql`update indexer.opensea_budget set tokens = 3, capacity = 10, refill_per_s = 0, min_interval_ms = 0`
  const budget = createBudget(sql)
  expect(await budget.take(0, 0)).toBe(true)
  expect(await budget.take(0, 0)).toBe(true)
  expect(await budget.take(0, 0)).toBe(true)
  expect(await budget.take(0, 0)).toBe(false)
})

it("take waits for a short block to end, and gives up when the wait would pass maxWaitMs", async () => {
  const budget = createBudget(sql)
  await budget.block(150)
  const t0 = Date.now()
  expect(await budget.take(0, 3000)).toBe(true)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(100)
  expect(Date.now() - t0).toBeLessThan(2000)
  await budget.block(60_000)
  const t1 = Date.now()
  expect(await budget.take(0, 500)).toBe(false)
  expect(Date.now() - t1).toBeLessThan(400) // no point sleeping through a wait that cannot fit
})

it("take waits for a refill when the bucket is empty", async () => {
  // One token at 0.5 a second takes 2 s to refill. The sleep records its length and moves the
  // bucket's clock by that much, so the test runs in no time and does not depend on its own speed.
  await sql`update indexer.opensea_budget set tokens = 0, capacity = 100, refill_per_s = 0.5, min_interval_ms = 0,
    updated_at = clock_timestamp()`
  const slept: number[] = []
  const budget = createBudget(sql, {
    sleep: async (ms) => {
      slept.push(ms)
      await sql`update indexer.opensea_budget set updated_at = updated_at - ${ms} * interval '1 millisecond'`
    },
  })
  expect(await budget.take(0, 3000)).toBe(true)
  expect(slept).toHaveLength(1)
  expect(slept[0]).toBeGreaterThanOrEqual(1000)
  expect(slept[0]).toBeLessThanOrEqual(2000)
  // The refilled token was spent, so a second take with no time to wait is refused.
  expect(await createBudget(sql).take(0, 0)).toBe(false)
})

it("block does not shorten an earlier block", async () => {
  const budget = createBudget(sql)
  await budget.block(60_000)
  await budget.block(10)
  expect(await budget.take(0, 100)).toBe(false)
})

it("take waits out the spacing between requests when maxWaitMs allows it", async () => {
  await sql`update indexer.opensea_budget set min_interval_ms = 200`
  const budget = createBudget(sql)
  expect(await budget.take(0, 0)).toBe(true)
  expect(await budget.take(0, 0)).toBe(false)
  const t0 = Date.now()
  expect(await budget.take(0, 1000)).toBe(true)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(100)
})
