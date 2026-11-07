import type { Sql } from "@ink-indexer/db"
import type { Address, Hash } from "viem"
import { chunks, curveRecord, s, writeAth, writePools } from "../inkypump/store"
import type { Tx } from "../source"
import type { KnownCurve, Supply, TsunamiBatch } from "./index"

// Tsunami's rows: reads for processing and rollback, and writes inside the loop's transaction.
// A Tsunami token needs no table of its own: every curve field the source uses arrives in each
// event, and the rest is on the token's row.

type CurveRecord = {
  token: Address
  launch_id: Hash
  quote_asset: Address
  total_supply: string
  target_raise: string
  progress_bps: number | null
}

/** The curve contract is the left-padded address in `launch_id`. */
const curveOf = (launchId: Hash) => `0x${launchId.slice(-40)}` as Address

const toKnown = (r: CurveRecord): KnownCurve => ({
  token: r.token,
  curve: curveOf(r.launch_id),
  launchId: r.launch_id,
  quote: r.quote_asset,
  targetRaise: BigInt(r.target_raise),
  supply: BigInt(r.total_supply),
  progressBps: r.progress_bps ?? 0,
})

/** Every Tsunami curve with its token's supply, raise target and quote, and the progress last written. */
export async function loadCurves(sql: Sql): Promise<KnownCurve[]> {
  const rows = await sql<CurveRecord[]>`
    select t.address as token, t.launch_id, t.quote_asset, t.total_supply::text, t.target_raise::text,
           s.progress_bps
    from indexer.tokens t
    left join indexer.curve_state s on s.token = t.address
    where t.launchpad = 'tsunami'`
  return rows.map(toKnown)
}

/** Curves of tokens created at or before `fork` whose curve state was written above it. */
export async function curvesToRefresh(sql: Sql, fork: bigint): Promise<KnownCurve[]> {
  const rows = await sql<CurveRecord[]>`
    select t.address as token, t.launch_id, t.quote_asset, t.total_supply::text, t.target_raise::text,
           s.progress_bps
    from indexer.tokens t
    join indexer.curve_state s on s.token = t.address
    where t.launchpad = 'tsunami' and t.created_block <= ${s(fork)} and s.updated_block > ${s(fork)}`
  return rows.map(toKnown)
}

/** Tokens of Tsunami that were bonded above `fork`. */
export async function bondedAbove(sql: Sql, fork: bigint): Promise<Address[]> {
  const rows = await sql<{ address: Address }[]>`
    select address from indexer.tokens
    where launchpad = 'tsunami' and created_block <= ${s(fork)} and bonded_block > ${s(fork)}`
  return rows.map((r) => r.address)
}

/**
 * Tokens, bonds, pools, curve state, trades and ath. Rows are inserted `on conflict do nothing`
 * so a backfill can overlap rows the live loop wrote. Events, block hashes and the cursor are the
 * store's.
 */
export async function writeRows(tx: Tx, batch: TsunamiBatch) {
  {
    const rows = batch.tokens.map((t) => ({
      address: t.address,
      launchpad: "tsunami",
      hook: t.hook,
      launch_id: t.launchId,
      name: t.name,
      ticker: t.ticker,
      creator: t.creator,
      created_block: s(t.createdBlock),
      created_at: t.createdAt,
      quote_asset: t.quoteAsset,
      total_supply: s(t.totalSupply),
      target_raise: s(t.targetRaise),
      sale_supply: s(t.saleSupply),
      gain_bps: null,
    }))
    for (const part of chunks(rows))
      await tx`insert into indexer.tokens ${tx(part)} on conflict (address) do nothing`
  }
  for (const b of batch.bonds) {
    await tx`
      update indexer.tokens set phase = 'bonded', bonded_block = ${s(b.block)},
        total_supply = ${s(b.totalSupply)}
      where address = ${b.token}`
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

/** Writes the curve state and supplies read at the fork block. */
export async function rollbackRows(
  tx: Tx,
  prepared: { curve: Parameters<typeof curveRecord>[0][]; supplies: Supply[] },
) {
  for (const c of prepared.curve) {
    await tx`
      update indexer.curve_state set progress_bps = ${c.progressBps}, curve_value = ${s(c.curveValue)},
        market_cap = ${s(c.marketCap)}, updated_block = ${s(c.updatedBlock)}
      where token = ${c.token}`
  }
  for (const x of prepared.supplies) {
    await tx`update indexer.tokens set total_supply = ${s(x.totalSupply)} where address = ${x.token}`
  }
}
