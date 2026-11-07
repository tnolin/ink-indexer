import type { Sql } from "@ink-indexer/db"
import { type ClassicCurve, ZERO_ADDRESS } from "@ink-indexer/sdk"
import type { Address } from "viem"
import { chunks, curveRecord, s, writeAth, writePools } from "../inkypump/store"
import type { Tx } from "../source"
import type { HookitBatch, KnownClassic, Sold } from "./index"

// Hookit's rows: reads for processing and rollback, and writes inside the loop's transaction.

type CurveRecord = {
  token: Address
  launch_number: string
  virtual_quote: string
  virtual_tokens: string
  curve_supply: string
  tokens_sold: string
  updated_block: string
  quote_asset: Address
  total_supply: string
  target_raise: string
  progress_bps: number | null
}

const COLUMNS = `t.address as token, h.launch_number::text, h.virtual_quote::text, h.virtual_tokens::text,
  h.curve_supply::text, h.tokens_sold::text, h.updated_block::text, t.quote_asset, t.total_supply::text, t.target_raise::text`

const toKnown = (r: CurveRecord): KnownClassic => ({
  token: r.token,
  launchNumber: BigInt(r.launch_number),
  quote: r.quote_asset,
  curve: {
    vQ0: BigInt(r.virtual_quote),
    vT0: BigInt(r.virtual_tokens),
    curveSupply: BigInt(r.curve_supply),
    graduationQuote: BigInt(r.target_raise),
  } satisfies ClassicCurve,
  supply: BigInt(r.total_supply),
  sold: BigInt(r.tokens_sold),
  progressBps: r.progress_bps ?? 0,
  appliedThrough: BigInt(r.updated_block),
})

/** Every Classic launch still on its curve, with the progress last written. */
export async function loadCurves(sql: Sql): Promise<KnownClassic[]> {
  const rows = await sql<CurveRecord[]>`
    select ${sql.unsafe(COLUMNS)}, c.progress_bps
    from indexer.hookit_curves h
    join indexer.tokens t on t.address = h.token
    left join indexer.curve_state c on c.token = t.address
    where t.phase = 'curve'`
  return rows.map(toKnown)
}

/** Curves of tokens created at or before `fork` whose curve state was written above it. */
export async function curvesToRefresh(sql: Sql, fork: bigint): Promise<KnownClassic[]> {
  const rows = await sql<CurveRecord[]>`
    select ${sql.unsafe(COLUMNS)}, c.progress_bps
    from indexer.hookit_curves h
    join indexer.tokens t on t.address = h.token
    join indexer.curve_state c on c.token = t.address
    where t.created_block <= ${s(fork)} and c.updated_block > ${s(fork)}`
  return rows.map(toKnown)
}

/** Addresses of the hooks the database already holds a row for. */
export async function loadHooks(sql: Sql): Promise<Address[]> {
  const rows = await sql<{ address: Address }[]>`
    select address from indexer.hooks where kind = 'hookit'`
  return rows.map((r) => r.address)
}

/**
 * Hooks, tokens, curves, pools, curve state, trades and ath. Rows are inserted `on conflict do
 * nothing` so a backfill can overlap rows the live loop wrote. Events, block hashes and the cursor
 * are the store's.
 */
export async function writeRows(tx: Tx, batch: HookitBatch) {
  {
    const rows = batch.hooks.map((h) => ({
      address: h.address,
      launchpad: "hookit",
      kind: "hookit",
      abi_family: "hookit",
      quote_asset: ZERO_ADDRESS,
      quote_decimals: 18,
      discovered_block: s(h.discoveredBlock),
    }))
    for (const part of chunks(rows))
      await tx`insert into indexer.hooks ${tx(part)} on conflict (address) do nothing`
  }
  {
    const rows = batch.tokens.map((t) => ({
      address: t.address,
      launchpad: "hookit",
      hook: t.hook,
      launch_id: t.launchId,
      name: t.name,
      ticker: t.ticker,
      creator: t.creator,
      created_block: s(t.createdBlock),
      created_at: t.createdAt,
      quote_asset: t.quoteAsset,
      total_supply: s(t.totalSupply),
      total_supply_block: s(t.createdBlock),
      target_raise: t.targetRaise === null ? null : s(t.targetRaise),
      sale_supply: t.saleSupply === null ? null : s(t.saleSupply),
      gain_bps: null,
    }))
    for (const part of chunks(rows))
      await tx`insert into indexer.tokens ${tx(part)} on conflict (address) do nothing`
  }
  {
    const rows = batch.classic.map((c) => ({
      token: c.token,
      launch_number: s(c.launchNumber),
      virtual_quote: s(c.curve.vQ0),
      virtual_tokens: s(c.curve.vT0),
      curve_supply: s(c.curve.curveSupply),
      tokens_sold: s(c.sold),
      updated_block: s(c.block),
    }))
    for (const part of chunks(rows))
      await tx`
        insert into indexer.hookit_curves ${tx(part)}
        on conflict (token) do update set
          tokens_sold = excluded.tokens_sold, updated_block = excluded.updated_block
        where indexer.hookit_curves.updated_block <= excluded.updated_block`
  }
  for (const b of batch.bonds) {
    await tx`
      update indexer.tokens set phase = 'bonded', bonded_block = ${s(b.block)}
      where address = ${b.token}`
    // A supply read at an older block than the stored one is left out: the newer one already holds
    // the burns after this graduation, which a replayed span would otherwise undo.
    await tx`
      update indexer.tokens set total_supply = ${s(b.totalSupply)}, total_supply_block = ${s(b.block)}
      where address = ${b.token}
        and (total_supply_block is null or total_supply_block <= ${s(b.block)})`
  }
  await writePools(tx, batch.pools)
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

/** Writes the curve state and tokens sold read at the fork block. */
export async function rollbackRows(
  tx: Tx,
  prepared: { curve: Parameters<typeof curveRecord>[0][]; sold: Sold[] },
) {
  for (const c of prepared.curve) {
    await tx`
      update indexer.curve_state set progress_bps = ${c.progressBps}, curve_value = ${s(c.curveValue)},
        market_cap = ${s(c.marketCap)}, updated_block = ${s(c.updatedBlock)}
      where token = ${c.token}`
  }
  for (const x of prepared.sold) {
    await tx`
      update indexer.hookit_curves set tokens_sold = ${s(x.sold)}, updated_block = ${s(x.block)}
      where token = ${x.token}`
  }
}
