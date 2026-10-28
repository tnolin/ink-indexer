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
    "0013_nft_gate1_links.sql",
    "0014_nft_job_failures.sql",
    "0015_v4_pools.sql",
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
    "nft_job_failures",
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
    "pools",
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

const HOOK = "0x00000000000000000000000000000000000000a1"
const QUOTE = "0x00000000000000000000000000000000000000b2"
const NATIVE = "0x0000000000000000000000000000000000000000"
const tokenAt = (n: number) => `0x${n.toString(16).padStart(40, "0")}`

/** Migrates, then undoes 0015 so its seed statements can be run over existing rows. */
async function beforeSeed() {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  await sql`drop table indexer.pools`
  await sql`alter table indexer.tokens drop column ath_market_cap, drop column ath_block,
    drop column dead_balance, drop column dead_balance_block`
  await sql`alter table indexer.trades drop column pool_id`
  await sql`delete from indexer.migrations where name = '0015_v4_pools.sql'`
  await sql`insert into indexer.hooks (address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block)
    values (${HOOK}, 'inkypump', 'native', 'x', ${NATIVE}, 18, 1)`
}

async function token(n: number, quote: string) {
  await sql`insert into indexer.tokens (address, launchpad, hook, launch_id, creator, created_block, created_at,
      quote_asset, total_supply, target_raise, sale_supply, gain_bps)
    values (${tokenAt(n)}, 'inkypump', ${HOOK}, ${String(n)}, ${HOOK}, 1, now(), ${quote}, 1000, 1, 1, 0)`
}

async function event(type: string, entity: string, payload: object, block: number, log: number) {
  await sql`insert into indexer.events (type, entity, payload, block, block_hash, tx_hash, log_index, confirmed)
    values (${type}, ${entity}, ${sql.json(payload as never)}, ${block}, '0x01', ${`0x${log}`}, ${log}, true)`
}

it("seeds pools from bond events with currency order", async () => {
  await beforeSeed()
  await token(1, NATIVE)
  await token(2, QUOTE)
  await event("launchpad.bond", tokenAt(1), { poolId: "0xAB", quoteAsset: NATIVE }, 10, 1)
  await event("launchpad.bond", tokenAt(2), { poolId: "0xCD", quoteAsset: QUOTE }, 11, 2)
  expect(await migrate(sql)).toEqual(["0015_v4_pools.sql"])
  const rows = await sql`select pool_id, pool_manager, token, token_is_currency0, created_block
    from indexer.pools order by token`
  expect(rows.map((r) => [r.pool_id, r.token_is_currency0, r.created_block])).toEqual([
    ["0xab", false, 10n],
    ["0xcd", true, 11n],
  ])
  expect(rows[0]!.pool_manager).toBe("0x360e68faccca8ca495c1b759fd9eee466db9fb32")
})

it("seeds ath from the highest curve trade", async () => {
  await beforeSeed()
  await token(1, NATIVE)
  await token(2, NATIVE)
  await event("launchpad.trade", tokenAt(1), { marketCap: "500" }, 10, 1)
  await event("launchpad.trade", tokenAt(1), { marketCap: "900" }, 11, 2)
  await event("launchpad.trade", tokenAt(1), { marketCap: "700" }, 12, 3)
  await migrate(sql)
  const rows =
    await sql`select address, ath_market_cap, ath_block from indexer.tokens order by address`
  expect(rows.map((r) => [r.ath_market_cap, r.ath_block])).toEqual([
    ["900", 11n],
    [null, null],
  ])
})
