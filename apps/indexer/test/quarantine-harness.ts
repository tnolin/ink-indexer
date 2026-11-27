import type { Sql } from "@ink-indexer/db"
import type { IndexerEvent } from "@ink-indexer/events"
import type { ChainLog } from "@ink-indexer/sdk"
import { type Address, type Hash, type Hex, pad, toHex } from "viem"
import type { Reporter } from "../src/sentry"
import type { BackfillSource, Source, SourceBatch, SourceName, Tx } from "../src/sources/source"

/** The statement Postgres refuses: a value with 79 digits does not fit numeric(78,0) (SQLSTATE 22003). */
const OVERFLOW = "1".padEnd(79, "0")

/**
 * `source` with a step added after its own write, inside the batch transaction, when `when` holds
 * for the batch it is writing.
 */
export function afterWrite<B extends SourceBatch, R>(
  source: Source<B, R>,
  when: (batch: SourceBatch, toBlock: bigint) => boolean,
  step: (tx: Tx) => Promise<unknown>,
): Source<B, R> {
  let toBlock = 0n
  return {
    ...source,
    async process(logs, ctx) {
      toBlock = ctx.toBlock
      return source.process(logs, ctx)
    },
    async write(tx, batch) {
      await source.write(tx, batch)
      if (when(batch, toBlock)) await step(tx)
    },
  }
}

/**
 * `source` with its database write refused by Postgres whenever `when` holds for a batch. `numeric`
 * runs a statement with a value that does not fit numeric(78,0) after the source's own write, so
 * the write step itself fails. `json` adds an event whose payload holds a NUL to the batch, which
 * the combined events insert refuses outside every source's write step (SQLSTATE 22P05).
 */
export function refusing<B extends SourceBatch, R>(
  source: Source<B, R>,
  when: (batch: SourceBatch, toBlock: bigint) => boolean,
  kind: "numeric" | "json",
): Source<B, R> {
  if (kind === "numeric")
    return afterWrite(source, when, (tx) => tx`select ${OVERFLOW}::numeric(78,0)`)
  return {
    ...source,
    async process(logs, ctx) {
      const batch = await source.process(logs, ctx)
      if (!when(batch, ctx.toBlock)) return batch
      const event = {
        type: "launchpad.trade",
        token: "0x00000000000000000000000000000000000000aa",
        txHash: pad(toHex(0xbad000 + Number(ctx.toBlock % 1000n)), { size: 32 }),
        logIndex: 0,
        note: "\u0000",
      } as unknown as IndexerEvent
      const row = { event, block: ctx.toBlock, blockHash: pad("0x01", { size: 32 }) as Hash }
      return { ...batch, events: [...batch.events, row] }
    },
  }
}

/** A reporter that keeps what it is sent. */
export function recordingReporter() {
  const warns: { message: string; context?: Record<string, unknown> }[] = []
  const errors: { message: string; context?: Record<string, unknown> }[] = []
  const reporter: Pick<Reporter, "warn" | "error"> = {
    warn: (message, context) => void warns.push({ message, context }),
    error: (message, context) => void errors.push({ message, context }),
  }
  return { ...reporter, warns, errors }
}

/** The loop's logger, keeping each line by level. */
export function recordingLogger() {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = []
  const logger = (level: string, msg: string, fields?: Record<string, unknown>) =>
    void lines.push({ level, msg, fields })
  return { logger, lines, at: (level: string) => lines.filter((l) => l.level === level) }
}

export const createFakeWrites = (sql: Sql) =>
  sql`create table indexer.fake_writes (source text not null, block bigint not null)`

/**
 * A source that reads every log of `address` and writes one event and one `fake_writes` row per
 * block, so a span it shares with another source shows what each wrote. `calls` records its
 * `process` and `reload` calls in order. `name` and `groups` are those of a real source.
 */
export function plainWriter(
  name: SourceName,
  groups: readonly BackfillSource[],
  address: Address,
  calls: string[] = [],
): Source<SourceBatch, null> {
  return {
    name,
    groups,
    filters: () => [{ address, topics: [] }],
    async process([logs = []]) {
      calls.push("process")
      return {
        events: logs.map((l) => ({
          event: {
            type: "launchpad.trade",
            token: address,
            txHash: l.transactionHash,
            logIndex: l.logIndex,
          } as unknown as IndexerEvent,
          block: l.blockNumber,
          blockHash: l.blockHash,
        })),
        blocks: [...new Map(logs.map((l) => [l.blockNumber, l.blockHash]))].map(
          ([number, hash]) => ({ number, hash }),
        ),
      }
    },
    async write(tx, batch) {
      for (const b of batch.blocks)
        await tx`insert into indexer.fake_writes values (${name}, ${b.number.toString()})`
    },
    async prepareRollback() {
      return null
    },
    async rollback(tx, fork) {
      await tx`delete from indexer.fake_writes where source = ${name} and block > ${fork.toString()}`
    },
    async reload() {
      calls.push("reload")
    },
  }
}

let writerTx = 0
/** A log of `address` in `block`, for a `plainWriter` to pick up. */
export function writerLog(address: Address, block: bigint): ChainLog {
  return {
    address,
    topics: ["0x01".padEnd(66, "0") as Hex],
    data: "0x",
    blockNumber: block,
    blockHash: "0x00",
    transactionHash: pad(toHex(0xfa0000 + ++writerTx), { size: 32 }) as Hash,
    logIndex: 0,
  }
}
