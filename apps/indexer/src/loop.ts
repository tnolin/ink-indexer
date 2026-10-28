import { INKYPUMP_START_BLOCK } from "@ink-indexer/sdk"
import type { Hash } from "viem"
import type { Chain } from "./chain"
import { BlockNotServedError } from "./errors"
import type { Level, Logger } from "./log"
import { readLogs } from "./log-plan"
import type { BackfillSource, Source, SourceBatch } from "./sources/source"
import type { Cursor, Store } from "./store"

/** A condition warns at most once in this long, and its stretch ends after this long without it. */
const QUIET_MS = 10 * 60_000

/**
 * A condition that comes and goes (a lagging endpoint). Each occurrence of it in a row is one episode.
 * An episode that starts when no warning for this condition was logged in the last QUIET_MS logs at
 * warn; every other line, including an episode's end, logs at debug. A stretch is the run of episodes
 * with no QUIET_MS gap between them; when one ends and some of its episodes were not warned about,
 * a single info line sums it up.
 */
class Condition {
  private since: number | null = null
  private hits = 0
  private lastWarn: number | null = null
  private stretch: {
    start: number
    last: number
    episodes: number
    suppressed: number
    hosts: Set<string>
  } | null = null

  constructor(
    private readonly name: string,
    private readonly logger: Logger,
  ) {}

  /** The level for this occurrence's line: warn only for the first one of an episode that is due. */
  hit(host?: string): Level {
    const now = Date.now()
    this.flush(now)
    this.hits++
    const stretch = this.stretch ?? {
      start: now,
      last: now,
      episodes: 0,
      suppressed: 0,
      hosts: new Set<string>(),
    }
    this.stretch = stretch
    stretch.last = now
    if (host) stretch.hosts.add(host)
    if (this.since !== null) return "debug"
    this.since = now
    stretch.episodes++
    if (this.lastWarn === null || now - this.lastWarn >= QUIET_MS) {
      this.lastWarn = now
      return "warn"
    }
    stretch.suppressed++
    return "debug"
  }

  /** Closes the open episode, if any, and returns how long it lasted and how many occurrences it had. */
  end(): { durationMs: number; hits: number } | null {
    if (this.since === null) return null
    const now = Date.now()
    const ended = { durationMs: now - this.since, hits: this.hits }
    this.since = null
    this.hits = 0
    if (this.stretch) this.stretch.last = now
    return ended
  }

  /** Closes a stretch that has had no episode for QUIET_MS. Called on every tick, so it needs no timer. */
  flush(now = Date.now()) {
    const s = this.stretch
    if (!s || this.since !== null || now - s.last < QUIET_MS) return
    this.stretch = null
    if (s.suppressed === 0) return
    this.logger("info", `${this.name}; stretch ended`, {
      condition: this.name,
      start: new Date(s.start).toISOString(),
      end: new Date(s.last).toISOString(),
      episodes: s.episodes,
      ...(s.hosts.size > 0 && { hosts: [...s.hosts].sort() }),
    })
  }
}

export class Indexer {
  private running: Promise<void> | null = null
  private again = false
  /** When the last tick started, in `Date.now()` ms; only kept when `tickMinIntervalMs` is set. */
  private lastStart = 0
  /** The deferred-tick timer, and what ends its wait early. A trigger while it waits joins that tick. */
  private wait: { timer: ReturnType<typeof setTimeout>; done: () => void } | null = null
  private stopped = false
  /** The chain head the last tick started from; undefined before the first tick. */
  lastHead: bigint | undefined
  /** How many head fetches have succeeded. */
  headFetches = 0
  /** How many ticks have completed without error, for the stall watchdog. */
  tickSuccesses = 0
  /** From the tick that found the fallback head stale until one finds it caught up. */
  private readonly staleHead: Condition
  /** From the first tick that could not read a block until a tick that served it. */
  private readonly notServed: Condition
  /** The stored cursor block, kept in memory so liveness checks never wait on the database. */
  cursorBlock: bigint | null | undefined

  constructor(
    private readonly deps: {
      chain: Chain
      store: Store
      logger: Logger
      sources: Source[]
      /** The filter groups the live tick reads (see `Source.filters`); undefined reads all. */
      only?: readonly BackfillSource[]
      /** False asks for each logical filter on its own, the reference the merged requests are tested against. Default true. */
      mergeRequests?: boolean
      /** The least time between the starts of two live ticks; 0 or unset starts one on every trigger. */
      tickMinIntervalMs?: number
    },
  ) {
    this.staleHead = new Condition("stale head", deps.logger)
    this.notServed = new Condition("block not yet served", deps.logger)
  }

  async init() {
    await this.reloadSources()
    this.cursorBlock = (await this.deps.store.getCursor())?.block ?? null
  }

  /**
   * Single-flight: triggers during a running tick fold into one more tick. With `tickMinIntervalMs`,
   * a tick that would start sooner than that after the last one waits on one timer, and every
   * trigger meanwhile joins it. The promise settles when the tick covering the trigger is done.
   */
  trigger(): Promise<void> {
    if (this.running) {
      if (!this.wait) this.again = true
      return this.running
    }
    const run = async () => {
      try {
        do {
          this.again = false
          await this.untilDue()
          if (this.stopped) return
          this.lastStart = Date.now()
          await this.tick()
        } while (this.again)
      } finally {
        this.running = null
      }
    }
    this.running = run()
    return this.running
  }

  /** Cancels a deferred tick: its timer is cleared, the triggers waiting on it settle and it never runs. */
  stop() {
    this.stopped = true
    if (!this.wait) return
    clearTimeout(this.wait.timer)
    this.wait.done()
  }

  /** Resolves when the minimum interval since the last tick start has passed (at once when it has, or is 0). */
  private async untilDue() {
    const delay = this.lastStart + (this.deps.tickMinIntervalMs ?? 0) - Date.now()
    if (!(delay > 0)) return
    await new Promise<void>((resolve) => {
      const done = () => {
        this.wait = null
        resolve()
      }
      this.wait = { timer: setTimeout(done, delay), done }
    })
  }

  async tick() {
    const { chain, store } = this.deps
    this.staleHead.flush()
    this.notServed.flush()
    let head = await chain.getBlockNumber()
    this.lastHead = head
    this.headFetches++
    try {
      await this.checkReorg()
      const cursor = await store.getCursor()
      // shortcut: a fresh database starts every source at InkyPump's start block. A source with
      // older history needs a per-source start block, and a backfill for the range it missed.
      let from = cursor ? cursor.block + 1n : INKYPUMP_START_BLOCK
      head = await this.headFor(head, from)
      this.lastHead = head
      while (from <= head) from = (await this.ingest(from, head, head, true, this.deps.only)) + 1n
      await store.confirm(head)
      this.tickSuccesses++
      const ended = this.notServed.end()
      if (ended)
        this.deps.logger("debug", "block served after retrying", {
          block: head,
          retries: ended.hits,
          durationMs: ended.durationMs,
        })
    } catch (err) {
      if (!(err instanceof BlockNotServedError)) throw err
      this.deps.logger(this.notServed.hit(), "block not yet served; retrying on next head", {
        block: err.block,
      })
    }
  }

  /**
   * The head this tick works from. A head the fallback transport reports below `from` may be stale
   * (one endpoint can keep answering eth_blockNumber with an old block while it serves the chain),
   * so then every endpoint's own head is read and the highest one is used. A head above `from` is
   * returned as is, with no extra calls.
   */
  private async headFor(head: bigint, from: bigint): Promise<bigint> {
    if (head >= from) {
      this.headRecovered()
      return head
    }
    const heads = await this.deps.chain.getTransportHeads(from)
    const highest = heads.reduce((a, h) => (h.head > a ? h.head : a), head)
    if (highest === head) {
      this.headRecovered()
      return head
    }
    const lowest = heads.reduce((a, h) => (h.head < a.head ? h : a))
    this.deps.logger(this.staleHead.hit(lowest.name), `stale head from ${lowest.name}`, {
      host: lowest.name,
      staleHead: head,
      highestHead: highest,
    })
    return highest
  }

  private headRecovered() {
    const ended = this.staleHead.end()
    if (ended)
      this.deps.logger("debug", "head source recovered", {
        durationMs: ended.durationMs,
        ticks: ended.hits,
      })
  }

  /**
   * Re-scans [from, to] idempotently without moving the live cursor. Stop `start` before running it.
   * `only` limits it to some sources' filters (see `Source.filters`); a source with none of its
   * filters picked is left out.
   */
  async backfill(from: bigint, to?: bigint, only?: readonly BackfillSource[]) {
    const end = to ?? (await this.deps.chain.getBlockNumber())
    for (let next = from; next <= end; )
      next = (await this.ingest(next, end, end, false, only)) + 1n
  }

  private async ingest(
    from: bigint,
    to: bigint,
    head: bigint,
    moveCursor: boolean,
    only?: readonly BackfillSource[],
  ): Promise<bigint> {
    const { chain, store, logger } = this.deps
    const picked = this.deps.sources
      .map((source) => ({ source, filters: source.filters(only) }))
      .filter((s) => s.filters.some((f) => f !== null))
    const sources = picked.map((s) => s.source)
    // Every request covers the same range. A transport may serve less than asked, so each call asks
    // up to the lowest end returned so far, and logs above the final end are dropped.
    const { logs, toBlock } = await readLogs(
      chain,
      picked.map((p) => p.filters),
      from,
      to,
      this.deps.mergeRequests ?? true,
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
