import type { Sql } from "@ink-indexer/db"
import type postgres from "postgres"
import type { Hash } from "viem"
import { entityOf, type SourceBatch, type Tx } from "./sources/source"

export type Cursor = { block: bigint; hash: Hash }

/** Runs inside the batch or rollback transaction. */
export type TxStep = (tx: Tx) => Promise<void>

// shortcut: the shared cursor keeps its historical name, 'inkypump', for every source. Renaming it
// needs a migration and a coordinated deploy.
const CURSOR_ROW = "inkypump"
const RECENT_BLOCKS = 128
const s = (x: bigint) => x.toString()
/** Rows per multi-row insert: Postgres allows 65,534 parameters per statement, so 1,000 rows leaves room for 65 columns. */
const CHUNK = 1_000
function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK)
}

/**
 * The events table, recent block hashes, the shared cursor and confirmation. Source tables are
 * written by the sources' own steps inside the same transaction.
 */
export function createStore(sql: Sql) {
  let tail: Promise<unknown> = Promise.resolve()
  /**
   * In-process FIFO mutex over the store's writes. Not reentrant: calling a locked method from
   * inside `fn` waits forever. shortcut: one indexer process; several processes would need
   * `pg_advisory_xact_lock` in each transaction instead.
   */
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(() => fn())
    tail = run.catch(() => {})
    return run
  }

  return {
    withLock,

    async getCursor(): Promise<Cursor | null> {
      const [r] = await sql<{ block: bigint; block_hash: Hash }[]>`
        select block, block_hash from indexer.cursors where source = ${CURSOR_ROW}`
      return r ? { block: BigInt(r.block), hash: r.block_hash } : null
    },

    async recentBlocks(): Promise<{ number: bigint; hash: Hash }[]> {
      const rows = await sql<{ number: bigint; hash: Hash }[]>`
        select number, hash from indexer.recent_blocks order by number desc`
      return rows.map((r) => ({ number: BigInt(r.number), hash: r.hash }))
    },

    /**
     * One transaction for every source's batch: each `writers` step, then all events, block hashes
     * and the cursor. With `cursor: null` (backfill) the live cursor and recent hashes are left alone.
     */
    async writeBatch(
      batches: SourceBatch[],
      writers: TxStep[],
      opts: { cursor: Cursor | null; head: bigint },
    ) {
      await withLock(() =>
        sql.begin(async (tx) => {
          // Confirm older rows in the same commit that adds newer confirmed ones, so a reader of
          // `confirmed and id > $1` can never pass an unconfirmed row that is old enough to confirm.
          await tx`update indexer.events set confirmed = true where not confirmed and block <= ${s(opts.head - 1n)}`
          for (const write of writers) await write(tx)
          // Chain order across sources (the sort is stable), so ids never put a confirmed row after an unconfirmed one.
          const events = batches
            .flatMap((b) => b.events)
            .sort((a, b) =>
              a.block === b.block
                ? a.event.logIndex - b.event.logIndex
                : a.block < b.block
                  ? -1
                  : 1,
            )
          const rows = events.map((e) => ({
            type: e.event.type,
            entity: entityOf(e.event),
            payload: tx.json(e.event as unknown as postgres.JSONValue),
            block: s(e.block),
            block_hash: e.blockHash,
            tx_hash: e.event.txHash,
            log_index: e.event.logIndex,
            sub: e.sub ?? "",
            confirmed: e.block <= opts.head - 1n,
          }))
          for (const part of chunks(rows))
            await tx`insert into indexer.events ${tx(part)} on conflict (tx_hash, log_index, sub) do nothing`
          if (opts.cursor) {
            const blocks = new Map(batches.flatMap((b) => b.blocks).map((b) => [b.number, b.hash]))
            blocks.set(opts.cursor.block, opts.cursor.hash)
            const rows = [...blocks].map(([number, hash]) => ({ number: s(number), hash }))
            for (const part of chunks(rows))
              await tx`insert into indexer.recent_blocks ${tx(part)} on conflict (number) do update set hash = excluded.hash`
            await tx`
              delete from indexer.recent_blocks where number not in
                (select number from indexer.recent_blocks order by number desc limit ${RECENT_BLOCKS})`
            await tx`
              insert into indexer.cursors (source, block, block_hash)
              values (${CURSOR_ROW}, ${s(opts.cursor.block)}, ${opts.cursor.hash})
              on conflict (source) do update set block = excluded.block, block_hash = excluded.block_hash`
          }
        }),
      )
    },

    async confirm(head: bigint) {
      await sql`update indexer.events set confirmed = true where not confirmed and block <= ${s(head - 1n)}`
    },

    /** One transaction: events above `fork`, each source's `steps`, then block hashes and the cursor. */
    async rollback(fork: bigint, forkHash: Hash, steps: TxStep[]) {
      const f = s(fork)
      await withLock(() =>
        sql.begin(async (tx) => {
          await tx`delete from indexer.events where block > ${f}`
          for (const step of steps) await step(tx)
          await tx`delete from indexer.recent_blocks where number > ${f}`
          await tx`update indexer.cursors set block = ${f}, block_hash = ${forkHash} where source = ${CURSOR_ROW}`
        }),
      )
    },
  }
}

export type Store = ReturnType<typeof createStore>
