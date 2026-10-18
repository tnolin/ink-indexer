import { curveValue, INKYPUMP_START_BLOCK, LOG_TOPICS, progressBps } from "@ink-indexer/sdk"
import type { Hash } from "viem"
import type { Chain } from "./chain"
import { BlockNotServedError } from "./errors"
import type { Logger } from "./log"
import type { LogFilter } from "./rpc"
import { HookRegistry, nativeHookRows } from "./sources/inkypump/hooks"
import { type Batch, type CurveRow, curveMarketCap, processLogs } from "./sources/inkypump/index"
import type { Cursor, Store } from "./store"

/** Every InkyPump event: one topic0 position matching any of the event signatures. */
const INKYPUMP_LOG_FILTER: LogFilter = { topics: [LOG_TOPICS] }

export class Indexer {
  private registry = new HookRegistry([])
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

  constructor(private readonly deps: { chain: Chain; store: Store; logger: Logger }) {}

  async init() {
    await this.deps.store.seedHooks(nativeHookRows())
    await this.reloadHooks()
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
    const { chain, store, logger } = this.deps
    const { logs, toBlock } = await chain.getLogs(from, to, INKYPUMP_LOG_FILTER)
    let batch: Batch
    try {
      batch = await processLogs(logs, {
        chain,
        registry: this.registry,
        logger,
        loadLaunches: (keys) => store.loadLaunches(keys),
      })
      let cursor: Cursor | null = null
      if (moveCursor) {
        const end = await chain.getBlock(toBlock)
        if (!end) throw new BlockNotServedError(toBlock)
        // The logs and the block hash may come from different endpoints. If the newest log block
        // no longer has the hash its logs reported, a reorg landed between the two calls.
        const newest = batch.blocks.reduce<Batch["blocks"][number] | undefined>(
          (a, b) => (!a || b.number > a.number ? b : a),
          undefined,
        )
        if (newest && (await this.blockHash(newest.number)) !== newest.hash)
          throw new BlockNotServedError(newest.number)
        cursor = { block: toBlock, hash: end.hash }
      }
      await store.writeBatch(batch, { cursor, head })
      if (cursor) this.cursorBlock = cursor.block
    } catch (err) {
      // processLogs registers new hooks in memory before they are persisted; drop that state.
      await this.reloadHooks()
      throw err
    }
    if (batch.events.length > 0)
      logger("info", "ingested", { from, to: toBlock, events: batch.events.length })
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
    const { chain, store, logger } = this.deps
    const launches = await store.launchesToRefresh(fork)
    const states =
      launches.length > 0
        ? await chain.readLaunchStates(
            launches.map((l) => ({ hook: l.hook, launchId: l.launchId })),
            fork,
          )
        : []
    const refreshed: CurveRow[] = launches.map((l, i) => {
      const sold = states[i]!.sold
      const value = curveValue(l.params, sold)
      return {
        token: l.token,
        progressBps: progressBps(value, l.params.targetRaise),
        curveValue: value,
        target: l.params.targetRaise,
        marketCap: curveMarketCap(l, sold),
        updatedBlock: fork,
      }
    })
    await store.rollback(fork, forkHash, refreshed)
    this.cursorBlock = fork
    await this.reloadHooks()
    logger("warn", "reorg: rolled back to fork block", { fork, refreshed: refreshed.length })
  }

  private async reloadHooks() {
    this.registry = new HookRegistry(await this.deps.store.loadHooks(), this.deps.logger)
  }
}
