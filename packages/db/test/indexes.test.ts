import { afterAll, beforeAll, expect, inject, it } from "vitest"
import { connect, migrate } from "../src/index"

const sql = connect(inject("databaseUrl"))
beforeAll(async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  // Planner statistics for a populated table: mostly trades, few launches, rare bonds.
  await sql`
    insert into indexer.events (type, entity, payload, block, block_hash, tx_hash, log_index, confirmed)
    select case when i % 500 = 0 then 'launchpad.bond' when i % 50 = 0 then 'launchpad.launch'
                when i % 5 = 0 then 'nft.sale' else 'launchpad.trade' end,
           '0x' || lpad(to_hex(i % 200), 40, '0'),
           jsonb_build_object('creator', '0x' || lpad(to_hex(i % 50), 40, '0')),
           i, '0x00', '0x' || lpad(to_hex(i), 64, '0'), 0, true
    from generate_series(1, 20000) i`
  await sql`analyze indexer.events`
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

it("per-collection read uses events_type_entity_id", async () => {
  expect(
    await plan(
      `select payload from indexer.events where type = 'nft.sale' and entity = '0x00000000000000000000000000000000000000c0' order by id desc limit 10`,
    ),
  ).toContain("events_type_entity_id")
})
