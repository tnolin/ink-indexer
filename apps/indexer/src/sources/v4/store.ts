import type { Sql } from "@ink-indexer/db"
import type { Address } from "viem"
import { chunks, writeAth } from "../inkypump/store"
import type { Tx } from "../source"
import type { DeadRow, SupplyRow, V4Batch } from "./index"

// The v4 source's writes inside the loop's transaction, and its reads for rollback.

const s = (x: bigint) => x.toString()

/** Pool trades, ath, dead balances and total supplies. Events, block hashes and the cursor are the store's. */
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
  await writeSupply(tx, batch.supply)
}

/**
 * Stores dead balances read or raised at a block. A balance at an older block than the stored one
 * is left out: a backfill and the live tick write the same token in either order.
 */
export async function writeDead(tx: Tx, dead: DeadRow[]) {
  for (const d of dead) {
    await tx`
      update indexer.tokens set dead_balance = ${s(d.balance)}, dead_balance_block = ${s(d.block)}
      where address = ${d.token}
        and (dead_balance_block is null or dead_balance_block <= ${s(d.block)})`
  }
}

/** Sets dead balances read at the fork block after a rollback, whatever block was stored. */
export async function resetDead(tx: Tx, dead: DeadRow[]) {
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

/**
 * Stores total supplies read or lowered by burns at a block. A supply at an older block than the
 * stored one is left out: a backfill and the live tick write the same token in either order, and
 * the newer supply already holds the burns the older write would add.
 */
export async function writeSupply(tx: Tx, supply: SupplyRow[]) {
  for (const x of supply) {
    await tx`
      update indexer.tokens set total_supply = ${s(x.totalSupply)}, total_supply_block = ${s(x.block)}
      where address = ${x.token}
        and (total_supply_block is null or total_supply_block <= ${s(x.block)})`
  }
}

/** Sets total supplies read at the fork block after a rollback, whatever block was stored. */
export async function resetSupply(tx: Tx, supply: SupplyRow[]) {
  for (const x of supply) {
    await tx`
      update indexer.tokens set total_supply = ${s(x.totalSupply)}, total_supply_block = ${s(x.block)}
      where address = ${x.token}`
  }
}

/** Tokens that exist at `fork` and whose supply was read or lowered above it. */
export async function supplyAbove(sql: Sql, fork: bigint): Promise<Address[]> {
  const rows = await sql<{ address: Address }[]>`
    select address from indexer.tokens
    where total_supply_block > ${s(fork)} and created_block <= ${s(fork)} order by address`
  return rows.map((r) => r.address)
}
