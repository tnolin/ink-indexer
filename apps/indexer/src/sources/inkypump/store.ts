import type { Sql } from "@ink-indexer/db"
import type { AbiFamily, LaunchKey } from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Tx } from "../source"
import type { HookRow } from "./hooks"
import type { AthRow, Batch, CurveRow, KnownLaunch } from "./index"

// InkyPump's tables: reads for processing and rollback, and writes inside the loop's transaction.

const LAUNCHPAD = "inkypump"
const s = (x: bigint) => x.toString()
/** Rows per multi-row insert: Postgres allows 65,534 parameters per statement, so 1,000 rows leaves room for 65 columns. */
const CHUNK = 1_000
function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK)
}

type HookRecord = {
  address: Address
  kind: "native" | "xstocks"
  abi_family: AbiFamily
  quote_asset: Address
  quote_decimals: number
  quote_symbol: string | null
  asset_id: Hash | null
  discovered_block: bigint
}
type LaunchRecord = {
  address: Address
  hook: Address
  launch_id: Hash
  quote_asset: Address
  total_supply: string
  target_raise: string
  sale_supply: string
  gain_bps: number
  progress_bps: number
}

const hookRecord = (r: HookRow) => ({
  address: r.address,
  launchpad: LAUNCHPAD,
  kind: r.kind,
  abi_family: r.abiFamily,
  quote_asset: r.quoteAsset,
  quote_decimals: r.quoteDecimals,
  quote_symbol: r.quoteSymbol,
  asset_id: r.assetId,
  discovered_block: s(r.discoveredBlock),
})

const curveRecord = (c: CurveRow) => ({
  token: c.token,
  progress_bps: c.progressBps,
  curve_value: s(c.curveValue),
  target: s(c.target),
  market_cap: s(c.marketCap),
  updated_block: s(c.updatedBlock),
})

const toKnownLaunch = (r: LaunchRecord): KnownLaunch => ({
  token: r.address,
  hook: r.hook,
  launchId: r.launch_id,
  quoteAsset: r.quote_asset,
  params: {
    targetRaise: BigInt(r.target_raise),
    saleSupply: BigInt(r.sale_supply),
    gainBps: r.gain_bps,
  },
  totalSupply: BigInt(r.total_supply),
  progressBps: r.progress_bps,
})

export async function seedHooks(sql: Sql, rows: HookRow[]) {
  if (rows.length > 0)
    await sql`insert into indexer.hooks ${sql(rows.map(hookRecord))} on conflict (address) do nothing`
}

export async function loadHooks(sql: Sql): Promise<HookRow[]> {
  const rows = await sql<HookRecord[]>`select * from indexer.hooks`
  return rows.map((r) => ({
    address: r.address,
    kind: r.kind,
    abiFamily: r.abi_family,
    quoteAsset: r.quote_asset,
    quoteDecimals: r.quote_decimals,
    quoteSymbol: r.quote_symbol,
    assetId: r.asset_id,
    discoveredBlock: BigInt(r.discovered_block),
  }))
}

export async function loadLaunches(sql: Sql, keys: LaunchKey[]): Promise<KnownLaunch[]> {
  if (keys.length === 0) return []
  const rows = await sql<LaunchRecord[]>`
    select t.address, t.hook, t.launch_id, t.quote_asset, t.total_supply, t.target_raise, t.sale_supply,
           t.gain_bps, coalesce(c.progress_bps, 0) as progress_bps
    from indexer.tokens t left join indexer.curve_state c on c.token = t.address
    where t.hook || ':' || t.launch_id in ${sql(keys.map((k) => `${k.hook}:${k.launchId}`))}`
  return rows.map(toKnownLaunch)
}

/** Launches created at or before `fork` whose curve state changed after it. */
export async function launchesToRefresh(sql: Sql, fork: bigint): Promise<KnownLaunch[]> {
  const rows = await sql<LaunchRecord[]>`
    select t.address, t.hook, t.launch_id, t.quote_asset, t.total_supply, t.target_raise, t.sale_supply,
           t.gain_bps, c.progress_bps
    from indexer.tokens t join indexer.curve_state c on c.token = t.address
    where t.created_block <= ${s(fork)} and c.updated_block > ${s(fork)}`
  return rows.map(toKnownLaunch)
}

/** Hooks, tokens, bonds, pools, curve state, trades and ath. Events, block hashes and the cursor are the store's. */
export async function writeRows(tx: Tx, batch: Batch) {
  for (const part of chunks(batch.hooks.map(hookRecord))) {
    await tx`insert into indexer.hooks ${tx(part)} on conflict (address) do nothing`
  }
  {
    const rows = batch.tokens.map((t) => ({
      address: t.address,
      launchpad: LAUNCHPAD,
      hook: t.hook,
      launch_id: t.launchId,
      name: t.name,
      ticker: t.ticker,
      creator: t.creator,
      created_block: s(t.createdBlock),
      created_at: t.createdAt,
      quote_asset: t.quoteAsset,
      paired_stock: t.pairedStock,
      total_supply: s(t.totalSupply),
      target_raise: s(t.targetRaise),
      sale_supply: s(t.saleSupply),
      gain_bps: t.gainBps,
    }))
    for (const part of chunks(rows))
      await tx`insert into indexer.tokens ${tx(part)} on conflict (address) do nothing`
  }
  for (const b of batch.bonds) {
    await tx`update indexer.tokens set phase = 'bonded', bonded_block = ${s(b.block)} where address = ${b.token}`
  }
  {
    const rows = batch.pools.map((p) => ({
      pool_id: p.poolId,
      pool_manager: p.poolManager,
      token: p.token,
      launchpad: p.launchpad,
      quote_asset: p.quoteAsset,
      token_is_currency0: p.tokenIsCurrency0,
      created_block: s(p.createdBlock),
    }))
    for (const part of chunks(rows))
      await tx`insert into indexer.pools ${tx(part)} on conflict do nothing`
  }
  await writeAth(tx, batch.ath)
  for (const part of chunks(batch.curve.map(curveRecord))) {
    await tx`
      insert into indexer.curve_state ${tx(part)}
      on conflict (token) do update set
        progress_bps = excluded.progress_bps, curve_value = excluded.curve_value, target = excluded.target,
        market_cap = excluded.market_cap, updated_block = excluded.updated_block
      where indexer.curve_state.updated_block <= excluded.updated_block`
  }
  {
    const rows = batch.trades.map((t) => ({
      tx_hash: t.txHash,
      log_index: t.logIndex,
      token: t.token,
      side: t.side,
      trader: t.trader,
      amount_in: s(t.amountIn),
      amount_out: s(t.amountOut),
      block: s(t.block),
      venue: "curve",
    }))
    for (const part of chunks(rows))
      await tx`insert into indexer.trades ${tx(part)} on conflict do nothing`
  }
}

/** Raises each token's ath, moving `ath_block` only when the ath rises. */
export async function writeAth(tx: Tx, ath: AthRow[]) {
  for (const a of ath) {
    await tx`
      update indexer.tokens set
        ath_block = case when ${s(a.marketCap)}::numeric > coalesce(ath_market_cap, 0)
                         then ${s(a.block)}::bigint else ath_block end,
        ath_market_cap = greatest(coalesce(ath_market_cap, 0), ${s(a.marketCap)}::numeric)
      where address = ${a.token}`
  }
}

/**
 * Deletes rows above `fork` (curve and pool trades alike), un-bonds, removes pools bonded above it,
 * recomputes ath from the trade and swap events that remain, and restores curve state read at the
 * fork block. The store has already deleted the events above the fork in this transaction.
 */
export async function rollbackRows(tx: Tx, fork: bigint, refreshed: CurveRow[]) {
  const f = s(fork)
  await tx`delete from indexer.trades where block > ${f}`
  await tx`delete from indexer.pools where created_block > ${f}`
  await tx`
    update indexer.tokens t set ath_market_cap = m.mc, ath_block = m.block
    from (
      select t2.address, best.mc, best.block
      from indexer.tokens t2
      left join lateral (
        select (e.payload->>'marketCap')::numeric as mc, e.block
        from indexer.events e
        where e.entity = t2.address and e.type in ('launchpad.trade', 'launchpad.swap')
          and e.block <= ${f}
        order by (e.payload->>'marketCap')::numeric desc, e.block
        limit 1
      ) best on true
      where t2.ath_block > ${f}
    ) m
    where m.address = t.address`
  await tx`delete from indexer.tokens where created_block > ${f}`
  await tx`delete from indexer.hooks where kind = 'xstocks' and discovered_block > ${f}`
  await tx`update indexer.tokens set phase = 'curve', bonded_block = null where bonded_block > ${f}`
  for (const c of refreshed) {
    await tx`
      update indexer.curve_state set progress_bps = ${c.progressBps}, curve_value = ${s(c.curveValue)},
        market_cap = ${s(c.marketCap)}, updated_block = ${s(c.updatedBlock)}
      where token = ${c.token}`
  }
}
