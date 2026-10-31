import type { Sql } from "@ink-indexer/db"
import type { InkfunCurve } from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import { chunks, curveRecord, s, writeAth } from "../inkypump/store"
import type { Tx } from "../source"
import type { InkfunBatch, KnownCurve, Supply } from "./index"

// ink.fun's tables: reads for processing and rollback, and writes inside the loop's transaction.

type CurveRecord = {
  token: Address
  curve: Address
  launch_id: Hash
  total_supply: string
  virtual_quote: string
  virtual_tokens: string
  curve_supply: string
  graduation_target: string
  progress_bps: number | null
}

const toKnown = (r: CurveRecord): KnownCurve => ({
  token: r.token,
  curve: r.curve,
  launchId: r.launch_id,
  totalSupply: BigInt(r.total_supply),
  params: {
    virtualQuote: BigInt(r.virtual_quote),
    virtualTokens: BigInt(r.virtual_tokens),
    curveSupply: BigInt(r.curve_supply),
    graduationTarget: BigInt(r.graduation_target),
  } satisfies InkfunCurve,
  progressBps: r.progress_bps ?? 0,
})

const COLUMNS = `t.address as token, c.curve, t.launch_id, t.total_supply::text, c.virtual_quote::text,
  c.virtual_tokens::text, c.curve_supply::text, c.graduation_target::text`

/** Every ink.fun curve with its token's launch id and supply, and the progress last written. */
export async function loadCurves(sql: Sql): Promise<KnownCurve[]> {
  const rows = await sql<CurveRecord[]>`
    select ${sql.unsafe(COLUMNS)}, s.progress_bps
    from indexer.inkfun_curves c
    join indexer.tokens t on t.address = c.token
    left join indexer.curve_state s on s.token = t.address`
  return rows.map(toKnown)
}

/** Curves of tokens created at or before `fork` whose curve state was written above it. */
export async function curvesToRefresh(sql: Sql, fork: bigint): Promise<KnownCurve[]> {
  const rows = await sql<CurveRecord[]>`
    select ${sql.unsafe(COLUMNS)}, s.progress_bps
    from indexer.inkfun_curves c
    join indexer.tokens t on t.address = c.token
    join indexer.curve_state s on s.token = t.address
    where t.launchpad = 'inkfun' and t.created_block <= ${s(fork)} and s.updated_block > ${s(fork)}`
  return rows.map(toKnown)
}

/** Tokens of ink.fun that were bonded above `fork`. */
export async function bondedAbove(sql: Sql, fork: bigint): Promise<Address[]> {
  const rows = await sql<{ address: Address }[]>`
    select address from indexer.tokens
    where launchpad = 'inkfun' and created_block <= ${s(fork)} and bonded_block > ${s(fork)}`
  return rows.map((r) => r.address)
}

/**
 * Tokens, curves, bonds, pools, curve state, trades and ath. Rows are inserted `on conflict do
 * nothing` so a backfill can overlap rows the live loop wrote. Events, block hashes and the cursor
 * are the store's.
 */
export async function writeRows(tx: Tx, batch: InkfunBatch) {
  {
    const rows = batch.tokens.map((t) => ({
      address: t.address,
      launchpad: "inkfun",
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
  {
    const rows = batch.tokens.map((t) => ({
      token: t.address,
      curve: t.curve,
      virtual_quote: s(t.params.virtualQuote),
      virtual_tokens: s(t.params.virtualTokens),
      curve_supply: s(t.params.curveSupply),
      lp_supply: s(t.lpSupply),
      graduation_target: s(t.params.graduationTarget),
    }))
    for (const part of chunks(rows))
      await tx`insert into indexer.inkfun_curves ${tx(part)} on conflict do nothing`
  }
  for (const b of batch.bonds) {
    await tx`
      update indexer.tokens set phase = 'bonded', bonded_block = ${s(b.block)},
        total_supply = ${s(b.totalSupply)}
      where address = ${b.token}`
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
