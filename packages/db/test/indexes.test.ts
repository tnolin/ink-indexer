import { afterAll, beforeAll, expect, inject, it } from "vitest"
import { connect, migrate } from "../src/index"

const sql = connect(inject("databaseUrl"))
beforeAll(async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
})
afterAll(() => sql.end())

async function plan(query: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`set local enable_seqscan = off`
    const rows = await tx.unsafe(`explain ${query}`)
    return rows.map((r) => r["QUERY PLAN"]).join("\n")
  })
}

it("serves a creator's launches from events_launch_creator", async () => {
  expect(
    await plan(
      `select entity from indexer.events where type = 'launchpad.launch' and payload->>'creator' = '0x00000000000000000000000000000000000000c1' and id <= 100`,
    ),
  ).toContain("events_launch_creator")
})

it("serves the latest bonds from events_type_id", async () => {
  expect(
    await plan(
      `select payload from indexer.events where type = 'launchpad.bond' order by id desc limit 5`,
    ),
  ).toContain("events_type_id")
})
