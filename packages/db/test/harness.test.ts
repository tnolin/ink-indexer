import { afterAll, expect, inject, it } from "vitest"
import { connect } from "../src/index"
import { testDatabaseUrl } from "../src/testing"

const sql = connect(inject("databaseUrl"))
afterAll(() => sql.end())

it("gives tests a reachable Postgres", async () => {
  const [row] = await sql`select 1::int8 as one`
  expect(row?.one).toBe(1n)
})

it("takes the test database from TEST_DATABASE_URL only, never from DATABASE_URL", () => {
  expect(testDatabaseUrl({ DATABASE_URL: "postgres://prod/ink" })).toBeUndefined()
  expect(testDatabaseUrl({ TEST_DATABASE_URL: "postgres://t/ink_test" })).toBe(
    "postgres://t/ink_test",
  )
  expect(
    testDatabaseUrl({ DATABASE_URL: "postgres://prod/ink", TEST_DATABASE_URL: "postgres://t/x" }),
  ).toBe("postgres://t/x")
  expect(testDatabaseUrl({ TEST_DATABASE_URL: "" })).toBeUndefined()
})
