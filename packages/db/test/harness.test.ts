import { afterAll, expect, inject, it } from "vitest"
import { connect } from "../src/index"

const sql = connect(inject("databaseUrl"))
afterAll(() => sql.end())

it("gives tests a reachable Postgres", async () => {
  const [row] = await sql`select 1::int8 as one`
  expect(row?.one).toBe(1n)
})
