import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
    "0016_inkfun.sql",
    "0017_tsunami.sql",
    "0018_hookit.sql",
    "0019_nftx.sql",
    "0020_quarantine.sql",
  ])
  expect(await migrate(sql)).toEqual([])
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'indexer' order by 1`
  expect(tables.map((t) => t.table_name)).toEqual([
    "cursors",
    "curve_state",
    "events",
    "hookit_curves",
    "hooks",
    "inkfun_curves",
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
    "nftx_auction_bids",
    "nftx_auctions",
    "nftx_collections",
    "nftx_prices",
    "opensea_budget",
    "pools",
    "quarantine",
    "recent_blocks",
    "tokens",
    "trades",
  ])
})

const INKFUN_HOOK = "0x735458d31dcf29dc204109430b1f7f96738568cc"

it("0016 seeds the ink.fun hook", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const rows =
    await sql`select launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block
    from indexer.hooks where address = ${INKFUN_HOOK}`
  expect(rows).toEqual([
    {
      launchpad: "inkfun",
      kind: "inkfun",
      abi_family: "inkfun",
      quote_asset: "0x0000000000000000000000000000000000000000",
      quote_decimals: 18,
      discovered_block: 57_611_992n,
    },
  ])
})

it("an inkfun hook row is accepted and an unknown kind is refused", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const hook = (address: string, kind: string) => sql`
    insert into indexer.hooks (address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block)
    values (${address}, 'inkfun', ${kind}, 'inkfun', ${"0x0000000000000000000000000000000000000000"}, 18, 1)`
  await hook("0x00000000000000000000000000000000000000f1", "inkfun")
  await expect(hook("0x00000000000000000000000000000000000000f2", "bogus")).rejects.toThrow(
    /hooks_kind_check/,
  )
})

it("0016 lets a token have no gain_bps and keeps one curve per token", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const token = tokenAt(1)
  await sql`insert into indexer.tokens (address, launchpad, hook, launch_id, creator, created_block, created_at,
      quote_asset, total_supply, target_raise, sale_supply, gain_bps)
    values (${token}, 'inkfun', ${INKFUN_HOOK}, ${tokenAt(2)}, ${HOOK}, 1, now(), ${NATIVE}, 1000, 1, 1, null)`
  const curve = (n: number) => sql`insert into indexer.inkfun_curves
    (token, curve, virtual_quote, virtual_tokens, curve_supply, lp_supply, graduation_target)
    values (${token}, ${tokenAt(n)}, 1, 2, 3, 4, 5)`
  await curve(2)
  await expect(curve(3)).rejects.toThrow(/duplicate key/)
  await sql`delete from indexer.tokens where address = ${token}`
  expect(await sql`select token from indexer.inkfun_curves`).toEqual([])
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

const TSUNAMI_HOOKS = [
  // Creation blocks of the three hooks Tsunami's Calamari pools use, from the explorer.
  ["0x110aac8ee9cd4853fb2c12f4f73937996ecfa8cc", 54_686_019n],
  ["0xba7286377d0369f566256770dbe2fc59d13128cc", 55_055_393n],
  ["0x5dc5426a33c1d095b9fd0449ac16f6aaebeee8cc", 55_742_827n],
] as const

it("0017 seeds the three Tsunami hooks", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const rows =
    await sql`select address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block
    from indexer.hooks where launchpad = 'tsunami' order by discovered_block`
  expect(rows).toEqual(
    TSUNAMI_HOOKS.map(([address, discovered_block]) => ({
      address,
      launchpad: "tsunami",
      kind: "tsunami",
      abi_family: "tsunami",
      quote_asset: "0x0000000000000000000000000000000000000000",
      quote_decimals: 18,
      discovered_block,
    })),
  )
})

it("a tsunami hook row is accepted and an unknown kind is still refused", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const hook = (address: string, kind: string) => sql`insert into indexer.hooks
    (address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block)
    values (${address}, 'tsunami', ${kind}, 'tsunami', ${"0x0000000000000000000000000000000000000000"}, 18, 1)`
  await hook("0x00000000000000000000000000000000000000f2", "tsunami")
  await expect(hook("0x00000000000000000000000000000000000000f3", "other")).rejects.toThrow()
  expect(
    await sql`select kind from indexer.hooks where address = '0x00000000000000000000000000000000000000f2'`,
  ).toEqual([{ kind: "tsunami" }])
})

const HOOKIT_HOOKS = [
  // Creation blocks of the six Master hooks and the Classic graduation hook, from the explorer.
  ["0xbd7e7815c640a67cabd9a93a15d1f250aaeeaac8", 56_517_960n],
  ["0x7c629422e9ac982ce72323d48ead94fcc092aac8", 56_618_517n],
  ["0x33200d9521ed99afbda8575f05348a583c7aaac8", 56_759_989n],
  ["0x4b533c432516fc1be4b0baefe6bff0942ad87fff", 57_556_983n],
  ["0x8a29b2c508007707bbff1814386aa968bbecbfff", 58_683_272n],
  ["0x1eee7628d070280da1b676c04d358d68b36f3fff", 59_883_877n],
  ["0xaac738f140d529bc0662bddd812964d843362088", 56_517_988n],
] as const

it("0018 seeds the seven Hookit hooks", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const rows =
    await sql`select address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block
    from indexer.hooks where launchpad = 'hookit' order by address`
  expect(rows).toEqual(
    [...HOOKIT_HOOKS]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([address, discovered_block]) => ({
        address,
        launchpad: "hookit",
        kind: "hookit",
        abi_family: "hookit",
        quote_asset: "0x0000000000000000000000000000000000000000",
        quote_decimals: 18,
        discovered_block,
      })),
  )
})

it("a Master token row with null target_raise and sale_supply is accepted", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const [hook] = HOOKIT_HOOKS[0]
  const insert = (address: string, targetRaise: number | null) => sql`
    insert into indexer.tokens (address, launchpad, hook, launch_id, creator, created_block, created_at,
      quote_asset, total_supply, target_raise, sale_supply, gain_bps)
    values (${address}, 'hookit', ${hook}, ${address}, ${hook}, 1, now(), ${QUOTE}, 1000, ${targetRaise}, ${targetRaise}, 0)`
  await insert(tokenAt(1), null)
  await insert(tokenAt(2), 5)
  expect(
    await sql`select target_raise::text, sale_supply::text, total_supply_block from indexer.tokens order by address`,
  ).toEqual([
    { target_raise: null, sale_supply: null, total_supply_block: null },
    { target_raise: "5", sale_supply: "5", total_supply_block: null },
  ])
})

it("a hookit hook row is accepted and an unknown kind is still refused", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const hook = (address: string, kind: string) => sql`insert into indexer.hooks
    (address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block)
    values (${address}, 'hookit', ${kind}, 'hookit', ${NATIVE}, 18, 1)`
  await hook("0x00000000000000000000000000000000000000f4", "hookit")
  await expect(hook("0x00000000000000000000000000000000000000f5", "other")).rejects.toThrow()
})

it("tokens.phase accepts pool and still refuses another value", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const [hook] = HOOKIT_HOOKS[0]
  const insert = (address: string, phase: string) => sql`
    insert into indexer.tokens (address, launchpad, hook, launch_id, creator, created_block, created_at,
      quote_asset, total_supply, target_raise, sale_supply, gain_bps, phase)
    values (${address}, 'hookit', ${hook}, ${address}, ${hook}, 1, now(), ${QUOTE}, 1000, null, null, 0, ${phase})`
  await insert(tokenAt(1), "pool")
  await insert(tokenAt(2), "curve")
  await insert(tokenAt(3), "bonded")
  await expect(insert(tokenAt(4), "other")).rejects.toThrow()
  expect(
    (await sql`select phase from indexer.tokens order by address`).map((r) => r.phase),
  ).toEqual(["pool", "curve", "bonded"])
})

it("pools gain nullable hook, tick range and ath columns", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const rows = await sql<{ column_name: string; is_nullable: string }[]>`
    select column_name, is_nullable from information_schema.columns
    where table_schema = 'indexer' and table_name = 'pools'
      and column_name in ('hook', 'tick_lower', 'tick_upper', 'ath_market_cap', 'ath_block')
    order by column_name`
  expect(rows.map((r) => [r.column_name, r.is_nullable])).toEqual([
    ["ath_block", "YES"],
    ["ath_market_cap", "YES"],
    ["hook", "YES"],
    ["tick_lower", "YES"],
    ["tick_upper", "YES"],
  ])
})

const COLLECTION = "0x00000000000000000000000000000000000000c1"

/** Applies every migration before `last` and records them, as a database that has not seen `last` yet. */
async function migrateBefore(last: string) {
  await sql`drop schema if exists indexer cascade`
  await sql`create schema indexer`
  await sql`create table indexer.migrations (name text primary key, applied_at timestamptz not null default now())`
  const dir = join(import.meta.dirname, "../migrations")
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < last)
    .sort()) {
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(dir, name), "utf8"))
      await tx`insert into indexer.migrations (name) values (${name})`
    })
  }
}

it("0019 applies on a database at 0018 and keeps existing rows", async () => {
  await migrateBefore("0019")
  await sql`insert into indexer.nft_collections (contract, launchpad, launch_token) values (${COLLECTION}, 'chimera', '0xd1')`
  await sql`insert into indexer.nft_launches (collection, launchpad, campaign_id, token, core, pool_id, rewards, vault, creator, block)
    values (${COLLECTION}, 'chimera', 5, '0xd1', '0xc0', '0xp0', '0xr0', '0xv0', '0xcr', 10)`
  await sql`insert into indexer.nft_sales (tx_hash, log_index, token_id, contract, qty, price_wei, currency, buyer, seller, order_hash, block)
    values ('0xaa', 1, 7, ${COLLECTION}, 1, 100, 'ETH', '0xb', '0xs', '0xo', 10)`
  await sql`insert into indexer.nft_stats (contract, at, floor_wei, owners, volume_24h_wei, sales_24h)
    values (${COLLECTION}, now(), 5, 1, 2, 3)`
  await sql`insert into indexer.nft_overrides (contract, verdict) values (${COLLECTION}, 'real')`
  expect(await migrate(sql)).toEqual(["0019_nftx.sql", "0020_quarantine.sql"])
  expect(await sql`select launchpad, campaign_id::text from indexer.nft_launches`).toEqual([
    { launchpad: "chimera", campaign_id: "5" },
  ])
  expect(await sql`select market, price_wei::text from indexer.nft_sales`).toEqual([
    { market: null, price_wei: "100" },
  ])
  expect(
    await sql`select floor_market, os_floor_wei, nftx_floor_wei, pool_count, block, floor_wei::text from indexer.nft_stats`,
  ).toEqual([
    {
      floor_market: null,
      os_floor_wei: null,
      nftx_floor_wei: null,
      pool_count: null,
      block: null,
      floor_wei: "5",
    },
  ])
  expect(await sql`select verdict, max_supply from indexer.nft_overrides`).toEqual([
    { verdict: "real", max_supply: null },
  ])
  expect(await sql`select nftx_slug from indexer.nft_collections`).toEqual([{ nftx_slug: null }])
})

it("a Chimera and an NFTX launch of one collection both fit nft_launches", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  await sql`insert into indexer.nft_launches (collection, launchpad, campaign_id, token, core, pool_id, rewards, vault, creator, block)
    values (${COLLECTION}, 'chimera', 5, '0xd1', '0xc0', '0xp0', '0xr0', '0xv0', '0xcr', 10)`
  await sql`insert into indexer.nft_launches (collection, launchpad, token, pool_id, creator, block)
    values (${COLLECTION}, 'nftx', '0xf1', '0xp1', '0xcr', 11)`
  expect(
    await sql`select launchpad, campaign_id::text, core from indexer.nft_launches order by launchpad`,
  ).toEqual([
    { launchpad: "chimera", campaign_id: "5", core: "0xc0" },
    { launchpad: "nftx", campaign_id: null, core: null },
  ])
  await expect(
    sql`insert into indexer.nft_launches (collection, launchpad, token, pool_id, creator, block)
      values (${COLLECTION}, 'nftx', '0xf2', '0xp2', '0xcr', 12)`,
  ).rejects.toThrow(/duplicate key/)
})

it("an nft_sales row with market 'x' is refused", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const sale = (market: string) => sql`insert into indexer.nft_sales
    (tx_hash, log_index, token_id, contract, qty, price_wei, currency, buyer, seller, order_hash, block, market)
    values (${`0x${market}`}, 1, 7, ${COLLECTION}, 1, 100, 'ETH', '0xb', '0xs', '0xo', 10, ${market})`
  await sale("nftx")
  await sale("opensea")
  await expect(sale("x")).rejects.toThrow(/nft_sales_market_check/)
})

it("an nft_stats row without block still inserts, and one with a market and block is checked", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  await sql`insert into indexer.nft_stats (contract, at, floor_wei) values (${COLLECTION}, now(), 1)`
  await sql`insert into indexer.nft_stats (contract, at, floor_wei, floor_market, os_floor_wei, nftx_floor_wei, pool_count, block)
    values (${COLLECTION}, now() + interval '1 second', 1, 'nftx', 3, 1, 60, 99)`
  await expect(
    sql`insert into indexer.nft_stats (contract, at, floor_market) values (${COLLECTION}, now() + interval '2 second', 'x')`,
  ).rejects.toThrow(/nft_stats_floor_market_check/)
})

it("an NFTX auction keeps one row per auction and its bids refuse an unknown kind", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const auction = "0x00000000000000000000000000000000000000a0"
  await sql`insert into indexer.nftx_auctions (auction, token, currency, start_block, end_block, claim_block, floor_price_q96, required_raise, amount, sender, tx_to, created_block, created_log_index)
    values (${auction}, '0xt', '0x0', 1, 2, 3, 4, 0, 5, '0xs', '0xto', 1, 0)`
  expect(await sql`select kept, manual, collection from indexer.nftx_auctions`).toEqual([
    { kept: false, manual: false, collection: null },
  ])
  const bid = (
    kind: string,
    log: number,
  ) => sql`insert into indexer.nftx_auction_bids (auction, block, log_index, kind, bid_id, owner)
    values (${auction}, 1, ${log}, ${kind}, 0, '0xo')`
  await bid("bid", 1)
  await bid("exit", 2)
  await bid("claim", 3)
  await expect(bid("other", 4)).rejects.toThrow(/nftx_auction_bids_kind_check/)
})

const quarantine = (row: {
  source?: string
  kind?: string
  mode?: string
  from?: number
  to?: number | null
  message?: string
  cleared?: boolean
}) => {
  const { source = "nft", kind = "skip", mode = "live", from = 10, to = 12 } = row
  const { message = "refused write", cleared = false } = row
  return sql`insert into indexer.quarantine
    (source, kind, mode, from_block, to_block, replay_sources, sqlstate, message, cleared_at)
    values (${source}, ${kind}, ${mode}, ${from}, ${to ?? null}, 'nft-mints,nft-sales,nft-launches',
      '23505', ${message}, ${cleared ? sql`now()` : null})`
}

it("0020 applies on a database at 0019 and keeps existing rows", async () => {
  await migrateBefore("0020")
  await sql`insert into indexer.nft_collections (contract, launchpad, launch_token) values (${COLLECTION}, 'nftx', '0xf1')`
  expect(await migrate(sql)).toEqual(["0020_quarantine.sql"])
  expect(await sql`select contract, launchpad from indexer.nft_collections`).toEqual([
    { contract: COLLECTION, launchpad: "nftx" },
  ])
  expect(await sql`select count(*)::int as n from indexer.quarantine`).toEqual([{ n: 0 }])
})

it("a second open live pause for one source is refused with 23505, and one after a clear is accepted", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  const pause = (cleared = false) =>
    quarantine({ kind: "pause", to: null, source: "inkfun", cleared })
  await pause()
  const error = await pause().catch((e: unknown) => e)
  expect(error).toMatchObject({ code: "23505" })
  expect(String(error)).toMatch(/quarantine_open_live_pause/)
  await sql`update indexer.quarantine set cleared_at = now() where source = 'inkfun'`
  await pause()
  await quarantine({ kind: "pause", to: null, source: "nft" })
  expect(
    await sql`select source, cleared_at is null as open from indexer.quarantine order by id`,
  ).toEqual([
    { source: "inkfun", open: false },
    { source: "inkfun", open: true },
    { source: "nft", open: true },
  ])
})

it("a skip and a backfill pause for a source with an open live pause are accepted", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  await quarantine({ kind: "pause", to: null })
  await quarantine({ kind: "skip" })
  await quarantine({ kind: "skip", mode: "backfill" })
  await quarantine({ kind: "pause", mode: "backfill", to: 20 })
  await quarantine({ kind: "pause", mode: "backfill", to: 30 })
  expect(await sql`select count(*)::int as n from indexer.quarantine`).toEqual([{ n: 5 }])
})

it("a message of 501 characters is refused", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  await quarantine({ message: "x".repeat(500) })
  await expect(quarantine({ message: "x".repeat(501) })).rejects.toMatchObject({ code: "23514" })
})

it("a kind other than skip or pause is refused", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  await expect(quarantine({ kind: "other" })).rejects.toThrow(/quarantine_kind_check/)
  await expect(quarantine({ mode: "other" })).rejects.toThrow(/quarantine_mode_check/)
})

it("a live skip or a backfill row without to_block is refused, and a live pause with one is refused", async () => {
  await sql`drop schema if exists indexer cascade`
  await migrate(sql)
  await expect(quarantine({ kind: "skip", to: null })).rejects.toMatchObject({ code: "23514" })
  await expect(quarantine({ kind: "skip", mode: "backfill", to: null })).rejects.toMatchObject({
    code: "23514",
  })
  await expect(quarantine({ kind: "pause", mode: "backfill", to: null })).rejects.toMatchObject({
    code: "23514",
  })
  await expect(quarantine({ kind: "pause", to: 12 })).rejects.toMatchObject({ code: "23514" })
  expect(await sql`select count(*)::int as n from indexer.quarantine`).toEqual([{ n: 0 }])
})
