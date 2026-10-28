import type { Sql } from "@ink-indexer/db"
import type { Address } from "viem"
import { chunks, writeAth } from "../inkypump/store"
import type { Tx } from "../source"
import type { DeadRow, V4Batch } from "./index"

// The v4 source's writes inside the loop's transaction, and its reads for rollback.

const s = (x: bigint) => x.toString()

/** Pool trades, ath and dead balances. Events, block hashes and the cursor are the store's. */
export async function writeRows(tx: Tx, batch: V4Batch) {
  const rows = batch.trades.map((t) => ({
    tx_hash: t.txHash,
    log_index: t.logIndex,
    token: t.token,
    side: t.side,
    trader: t.trader,
    amount_in: s(t.amountIn),
    amount_out: s(t.amountOut),
    block: s(t.block),
    venue: "pool",
    pool_id: t.poolId,
  }))
  // A backfill can cover blocks the live loop already wrote.
  for (const part of chunks(rows))
    await tx`insert into indexer.trades ${tx(part)} on conflict do nothing`
  await writeAth(tx, batch.ath)
  await writeDead(tx, batch.dead)
}

export async function writeDead(tx: Tx, dead: DeadRow[]) {
  for (const d of dead) {
    await tx`
      update indexer.tokens set dead_balance = ${s(d.balance)}, dead_balance_block = ${s(d.block)}
      where address = ${d.token}`
  }
}

/** Tokens whose dead balance was read or raised above `fork`. */
export async function deadAbove(sql: Sql, fork: bigint): Promise<Address[]> {
  const rows = await sql<{ address: Address }[]>`
    select address from indexer.tokens where dead_balance_block > ${s(fork)} order by address`
  return rows.map((r) => r.address)
}
