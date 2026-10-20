import { afterAll, expect, inject, it } from "vitest"
import { connect, migrate } from "../src/index"

const sql = connect(inject("databaseUrl"))
afterAll(() => sql.end())

it("applies migrations to an empty database, then does nothing on a second run", async () => {
  await sql`drop schema if exists indexer cascade`
  expect(await migrate(sql)).toEqual([
    "0001_init.sql",
    "0002_events_bot_indexes.sql",
    "0003_events_sub.sql",
    "0004_nft_chain.sql",
    "0005_nft_milestones.sql",
    "0006_opensea_budget.sql",
    "0007_nft_opensea_state.sql",
    "0008_nft_creators_launch.sql",
    "0009_nft_verdicts.sql",
    "0010_nft_stats.sql",
    "0011_nft_listings.sql",
    "0012_opensea_spacing.sql",
  ])
  expect(await migrate(sql)).toEqual([])
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'indexer' order by 1`
  expect(tables.map((t) => t.table_name)).toEqual([
    "cursors",
    "curve_state",
    "events",
    "hooks",
    "migrations",
    "nft_accounts",
    "nft_burns",
    "nft_collections",
    "nft_drops",
    "nft_items_seen",
    "nft_launches",
    "nft_listing_state",
    "nft_mints",
    "nft_overrides",
    "nft_ranks",
    "nft_sales",
    "nft_seadrop_config",
    "nft_seadrop_mints",
    "nft_stages",
    "nft_stats",
    "opensea_budget",
    "recent_blocks",
    "tokens",
    "trades",
  ])
})

it("0003 allows two events per log with different sub", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const row = (sub: string) => ({
    type: "nft.sale",
    entity: "0x00000000000000000000000000000000000000c0",
    payload: sql.json({}),
    block: "1",
    block_hash: "0x01",
    tx_hash: "0xaa",
    log_index: 0,
    confirmed: false,
    sub,
  })
  await sql`insert into indexer.events ${sql(row(""))}`
  await sql`insert into indexer.events ${sql(row("sale:1"))}`
  await expect(sql`insert into indexer.events ${sql(row(""))}`).rejects.toThrow(
    /duplicate key value violates unique constraint/,
  )
  const inserted = await sql`
    insert into indexer.events ${sql(row(""))} on conflict (tx_hash, log_index, sub) do nothing returning id`
  expect(inserted).toEqual([])
})
