import type { Sql } from "@ink-indexer/db"
import type { NftEvent } from "@ink-indexer/events"
import type postgres from "postgres"
import type { Hash } from "viem"
import { entityOf, type SourceBatch, type Tx } from "./sources/source"

export type Cursor = { block: bigint; hash: Hash }

/** Runs inside the batch or rollback transaction. */
export type TxStep = (tx: Tx) => Promise<void>

// shortcut: the shared cursor keeps its historical name, 'inkypump', for every source. Renaming it
// needs a migration and a coordinated deploy.
export const CURSOR_ROW = "inkypump"
const RECENT_BLOCKS = 128
/**
 * `pg_advisory_xact_lock` key that serialises every store write across processes (the indexer and
 * CLI commands). Any fixed value; nothing else on the database may take it.
 */
const WRITE_LOCK = 570_730_001
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
   * In-process FIFO mutex over the store's writes, so callers in one process queue here rather than
   * each holding a pool connection while they wait on the database lock. Not reentrant: calling a
   * locked method from inside `fn` waits forever.
   */
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(() => fn())
    tail = run.catch(() => {})
    return run
  }

  /**
   * One write transaction under both locks. The advisory lock is the first statement, so writers in
   * other processes allocate event ids and commit one at a time with this one: a reader of
   * `confirmed and id > $1` relies on ids committing in order.
   */
  function locked(fn: TxStep): Promise<void> {
    return withLock(async () => {
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${WRITE_LOCK}::bigint)`
        await fn(tx)
      })
    })
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
      await locked(async (tx) => {
        // Confirm older rows in the same commit that adds newer confirmed ones, so a reader of
        // `confirmed and id > $1` can never pass an unconfirmed row that is old enough to confirm.
        await tx`update indexer.events set confirmed = true where not confirmed and block <= ${s(opts.head - 1n)}`
        for (const write of writers) await write(tx)
        // Chain order across sources (the sort is stable), so ids never put a confirmed row after an unconfirmed one.
        const events = batches
          .flatMap((b) => b.events)
          .sort((a, b) =>
            a.block === b.block ? a.event.logIndex - b.event.logIndex : a.block < b.block ? -1 : 1,
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
      })
    },

    /**
     * Events with no transaction (synthetic `os:` or `nft:` ids), stamped with the chain cursor's
     * block and hash and left unconfirmed, so the next `confirm` or `writeBatch` confirms them with
     * the chain rows at that block. Every later chain row is for a higher block, so no confirmed row
     * ever gets a higher id than one of these while it is unconfirmed. `extra` writes state rows in
     * the same transaction: database writes only, no network reads (fetch first), since it holds
     * the store lock. The payload's `blockNumber` is set to the stamped block.
     *
     * Must not run concurrently with `Indexer.backfill`: a backfill writes old blocks, already
     * confirmed, with ids above any unconfirmed row at its head block, chain or off-chain. Off-chain
     * writers run only beside `start`, and a backfill runs while `start` is stopped.
     */
    async writeOffchain(rows: { event: NftEvent; sub?: string }[], extra?: TxStep) {
      await locked(async (tx) => {
        const [cursor] = await tx<{ block: bigint; block_hash: Hash }[]>`
          select block, block_hash from indexer.cursors where source = ${CURSOR_ROW}`
        if (!cursor) throw new Error("no chain cursor yet: off-chain events need an ingested block")
        const block = s(BigInt(cursor.block))
        const values = rows.map(({ event, sub }) => ({
          type: event.type,
          entity: entityOf(event),
          payload: tx.json({ ...event, blockNumber: block } as unknown as postgres.JSONValue),
          block,
          block_hash: cursor.block_hash,
          tx_hash: event.txHash,
          log_index: event.logIndex,
          sub: sub ?? "",
          confirmed: false,
        }))
        for (const part of chunks(values))
          await tx`insert into indexer.events ${tx(part)} on conflict (tx_hash, log_index, sub) do nothing`
        if (extra) await extra(tx)
      })
    },

    async confirm(head: bigint) {
      await locked(async (tx) => {
        await tx`update indexer.events set confirmed = true where not confirmed and block <= ${s(head - 1n)}`
      })
    },

    /**
     * One transaction: events above `fork`, each source's `steps`, then block hashes and the cursor.
     * Off-chain rows above the fork cannot be emitted again, so they move to the fork block,
     * unconfirmed and with the payload's `blockNumber` rewritten, instead of being deleted; chain
     * rows above the fork are deleted.
     */
    async rollback(fork: bigint, forkHash: Hash, steps: TxStep[]) {
      const f = s(fork)
      await locked(async (tx) => {
        await tx`
          update indexer.events
          set block = ${f}, block_hash = ${forkHash}, confirmed = false,
            payload = jsonb_set(payload, '{blockNumber}', to_jsonb(${f}::text))
          where block > ${f} and (tx_hash like 'os:%' or tx_hash like 'nft:%')`
        await tx`delete from indexer.events where block > ${f}`
        for (const step of steps) await step(tx)
        await tx`delete from indexer.recent_blocks where number > ${f}`
        await tx`update indexer.cursors set block = ${f}, block_hash = ${forkHash} where source = ${CURSOR_ROW}`
      })
    },
  }
}

export type Store = ReturnType<typeof createStore>
