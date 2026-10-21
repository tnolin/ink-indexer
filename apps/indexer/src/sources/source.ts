import type { IndexerEvent } from "@ink-indexer/events"
import type { ChainLog } from "@ink-indexer/sdk"
import type postgres from "postgres"
import type { Hash } from "viem"
import type { LogFilter } from "../rpc"

export type Tx = postgres.TransactionSql

/** One `indexer.events` row. `sub` tells apart several events from one log; omitted means `''`. */
export type EventRow = { event: IndexerEvent; block: bigint; blockHash: Hash; sub?: string }

/** What a source turns one block range into. `blocks` are the hashes its logs reported. */
export type SourceBatch = { events: EventRow[]; blocks: { number: bigint; hash: Hash }[] }

/**
 * One protocol's ingestion. The loop runs every source over the same block range, writes all
 * their batches in one transaction with the shared cursor, and rolls them back together.
 */
export interface Source<B extends SourceBatch = SourceBatch, R = unknown> {
  name: string
  /**
   * The log filters, in the order `process` receives their logs. With `only` (backfill names such
   * as `nft-sales`), a filter the list does not pick is null: the loop reads nothing for it and
   * passes an empty array in its place.
   */
  filters(only?: readonly BackfillSource[]): (LogFilter | null)[]
  /** One log array per filter, same order. Network reads allowed; no DB writes. */
  process(logs: ChainLog[][], ctx: { toBlock: bigint }): Promise<B>
  write(tx: Tx, batch: B): Promise<void>
  /** Network reads before the rollback transaction. */
  prepareRollback(fork: bigint): Promise<R>
  rollback(tx: Tx, fork: bigint, prepared: R): Promise<void>
  /** Rebuilds in-memory state after a failed batch or a rollback. */
  reload(): Promise<void>
}

/**
 * The names `backfill --sources` takes. `inkypump` is the InkyPump source; the NFT source's filters
 * come in three groups: `nft-mints` (mints, burns and SeaDrop logs), `nft-sales` (Seaport) and
 * `nft-launches` (the Chimera factory).
 */
export const BACKFILL_SOURCES = ["inkypump", "nft-mints", "nft-sales", "nft-launches"] as const
export type BackfillSource = (typeof BACKFILL_SOURCES)[number]

/** `filter` when `only` is absent or names `group`, else null (see `Source.filters`). */
export const pick = (
  only: readonly BackfillSource[] | undefined,
  group: BackfillSource,
  filter: LogFilter,
) => (only === undefined || only.includes(group) ? filter : null)

/** The `entity` column: what readers look an event up by. Every event type has one case. */
export function entityOf(e: IndexerEvent): string {
  switch (e.type) {
    case "launchpad.launch":
    case "launchpad.trade":
    case "launchpad.bond":
      return e.token
    case "nft.collection":
    case "nft.drop":
    case "nft.mint":
    case "nft.listing":
    case "nft.sale":
    case "nft.stats":
    case "nft.launch":
      return e.contract
  }
}
