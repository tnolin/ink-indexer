import { type ChainLog, INKYPUMP_START_BLOCK } from "@ink-indexer/sdk"
import type { Hash } from "viem"
import type { Chain } from "./chain"
import { BlockNotServedError } from "./errors"
import type { Logger } from "./log"
import type { Source, SourceBatch } from "./sources/source"
import type { Cursor, Store } from "./store"

export class Indexer {
  private running: Promise<void> | null = null
  private again = false
  /** The chain head the last tick started from; undefined before the first tick. */
  lastHead: bigint | undefined
  /** How many head fetches have succeeded. */
  headFetches = 0
  /** How many ticks have completed without error, for the stall watchdog. */
  tickSuccesses = 0
  /** The stored cursor block, kept in memory so liveness checks never wait on the database. */
  cursorBlock: bigint | null | undefined

  constructor(
    private readonly deps: { chain: Chain; store: Store; logger: Logger; sources: Source[] },
  ) {}

  async init() {
    await this.reloadSources()
    this.cursorBlock = (await this.deps.store.getCursor())?.block ?? null
  }

  /** Single-flight: triggers during a running tick fold into one more tick. */
  trigger(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    const run = async () => {
      try {
        do {
          this.again = false
          await this.tick()
        } while (this.again)
      } finally {
        this.running = null
      }
    }
    this.running = run()
    return this.running
  }

  async tick() {
    const { chain, store } = this.deps
    const head = await chain.getBlockNumber()
    this.lastHead = head
    this.headFetches++
    try {
      await this.checkReorg()
      const cursor = await store.getCursor()
      // shortcut: a fresh database starts every source at InkyPump's start block. A source with
      // older history needs a per-source start block, and a backfill for the range it missed.
      let from = cursor ? cursor.block + 1n : INKYPUMP_START_BLOCK
      while (from <= head) from = (await this.ingest(from, head, head, true)) + 1n
      await store.confirm(head)
      this.tickSuccesses++
    } catch (err) {
      if (!(err instanceof BlockNotServedError)) throw err
      this.deps.logger("warn", "block not yet served; retrying on next head", { block: err.block })
    }
  }

  /** Re-scans [from, to] idempotently without moving the live cursor. Stop `start` before running it. */
  async backfill(from: bigint, to?: bigint) {
    const end = to ?? (await this.deps.chain.getBlockNumber())
    for (let next = from; next <= end; ) next = (await this.ingest(next, end, end, false)) + 1n
  }

  private async ingest(
    from: bigint,
    to: bigint,
    head: bigint,
    moveCursor: boolean,
  ): Promise<bigint> {
    const { chain, store, logger, sources } = this.deps
    // Every filter covers the same range. A transport may serve less than asked, so each call asks
    // up to the lowest end returned so far, and logs above the final end are dropped.
    let toBlock = to
    const fetched: ChainLog[][][] = []
    for (const source of sources) {
      const perFilter: ChainLog[][] = []
      for (const filter of source.filters()) {
        const r = await chain.getLogs(from, toBlock, filter)
        if (r.toBlock < toBlock) toBlock = r.toBlock
        perFilter.push(r.logs)
      }
      fetched.push(perFilter)
    }
    const logs = fetched.map((perFilter) =>
      perFilter.map((ls) => ls.filter((l) => l.blockNumber <= toBlock)),
    )
    let events = 0
    try {
      const batches: SourceBatch[] = []
      for (const [i, source] of sources.entries())
        batches.push(await source.process(logs[i]!, { toBlock }))
      let cursor: Cursor | null = null
      if (moveCursor) {
        const end = await chain.getBlock(toBlock)
        if (!end) throw new BlockNotServedError(toBlock)
        // The logs and the block hash may come from different endpoints. If the newest log block
        // no longer has the hash its logs reported, a reorg landed between the two calls.
        const newest = batches
          .flatMap((b) => b.blocks)
          .reduce<SourceBatch["blocks"][number] | undefined>(
            (a, b) => (!a || b.number > a.number ? b : a),
            undefined,
          )
        if (newest && (await this.blockHash(newest.number)) !== newest.hash)
          throw new BlockNotServedError(newest.number)
        cursor = { block: toBlock, hash: end.hash }
      }
      await store.writeBatch(
        batches,
        sources.map((source, i) => (tx) => source.write(tx, batches[i]!)),
        { cursor, head },
      )
      if (cursor) this.cursorBlock = cursor.block
      events = batches.reduce((n, b) => n + b.events.length, 0)
    } catch (err) {
      // Sources may hold in-memory state (new hooks) for rows that were never written; drop it.
      await this.reloadSources()
      throw err
    }
    if (events > 0) logger("info", "ingested", { from, to: toBlock, events })
    return toBlock
  }

  private async checkReorg() {
    const { store } = this.deps
    const cursor = await store.getCursor()
    if (!cursor) return
    if ((await this.blockHash(cursor.block)) === cursor.hash) return
    for (const b of await store.recentBlocks()) {
      if ((await this.blockHash(b.number)) === b.hash) {
        await this.rollback(b.number, b.hash)
        return
      }
    }
    throw new Error(
      `reorg below every stored block hash (cursor ${cursor.block}); refusing to guess the fork point`,
    )
  }

  /** The endpoint's hash for a block. A null block is unknown, never a mismatch. */
  private async blockHash(n: bigint): Promise<Hash> {
    const block = await this.deps.chain.getBlock(n)
    if (!block) throw new BlockNotServedError(n)
    return block.hash
  }

  private async rollback(fork: bigint, forkHash: Hash) {
    const { store, logger, sources } = this.deps
    // Network reads first, so the transaction holds no locks while waiting on the chain.
    const prepared: unknown[] = []
    for (const source of sources) prepared.push(await source.prepareRollback(fork))
    await store.rollback(
      fork,
      forkHash,
      sources.map((source, i) => (tx) => source.rollback(tx, fork, prepared[i])),
    )
    this.cursorBlock = fork
    await this.reloadSources()
    logger("warn", "reorg: rolled back to fork block", { fork })
  }

  private async reloadSources() {
    for (const source of this.deps.sources) await source.reload()
  }
}
