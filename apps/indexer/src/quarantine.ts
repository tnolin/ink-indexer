import { PostgresError, type Sql } from "@ink-indexer/db"
import {
  type BackfillSource,
  LAUNCHPAD_SOURCES,
  SOURCE_GROUPS,
  type SourceName,
} from "./sources/source"

/** One `indexer.quarantine` row as the indexer writes it. */
export type QuarantineRow = {
  source: SourceName
  kind: "skip" | "pause"
  mode: "live" | "backfill"
  fromBlock: bigint
  /** A skip's last block or a backfill pause's `--to`; null for a live pause. */
  toBlock: bigint | null
  replaySources: readonly BackfillSource[]
  /** The SQLSTATE of the refused write, or `dependency` for a missing record. */
  sqlstate: string
  message: string
}

/**
 * The error when the database refused the data itself: class 22 (data exception) or 23 (integrity
 * constraint violation). Anything else, such as a lock timeout, a serialization failure or a lost
 * connection, may succeed on another try, so it is not bad data. Connection errors carry a `code`
 * too, so the class is checked as well.
 */
export function badDataError(err: unknown): PostgresError | null {
  return err instanceof PostgresError && /^2[23]/.test(err.code) ? err : null
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const MESSAGE_CODE_POINTS = 500

/**
 * A database error message as the `quarantine.message` column takes it: NULs removed (text columns
 * refuse them), lone surrogates replaced with U+FFFD (they do not encode as UTF-8), and at most 500
 * code points, so recording an error never fails on the data that caused it.
 */
export function cutMessage(s: string): string {
  return [...s.replaceAll("\u0000", "").replace(LONE_SURROGATE, "�")]
    .slice(0, MESSAGE_CODE_POINTS)
    .join("")
}

/** The sources whose skip replays up to the live cursor: they follow only what they loaded. */
export const CURSOR_REPLAY_SOURCES = ["inkfun", "tsunami", "hookit", "nftx"] as const

const isLaunchpad = (source: SourceName) =>
  (LAUNCHPAD_SOURCES as readonly SourceName[]).includes(source)
const replaysToCursor = (source: SourceName) =>
  (CURSOR_REPLAY_SOURCES as readonly SourceName[]).includes(source)

/**
 * The `--sources` value that replays `source`. A pause also replays `v4-swaps` for a launchpad
 * source, since swaps of its tokens were left out too; so does a skip of a source that replays to
 * the cursor.
 */
export function replaySources(source: SourceName, kind: "skip" | "pause"): BackfillSource[] {
  const own: BackfillSource[] = [...SOURCE_GROUPS[source]]
  const withSwaps = kind === "pause" || replaysToCursor(source)
  return withSwaps && isLaunchpad(source) ? [...own, "v4-swaps"] : own
}

const BELOW_CURSOR = "<a block at or below the live cursor>"
const TAIL_FROM = "<that --to + 1>"
const CURSOR_BLOCK = "<the cursor block>"

/** What a person runs to replay the blocks a record left out. */
export function replaySteps(row: QuarantineRow): string[] {
  const from = row.fromBlock.toString()
  const sources = row.replaySources.join(",")
  const backfill = (to: string, list = sources) =>
    `pnpm backfill --from ${from} --to ${to} --sources ${list}`
  const tail = (end: string) =>
    `stop start, then pnpm backfill --from ${TAIL_FROM} --to ${CURSOR_BLOCK} --sources ${sources}, ${end}`
  if (row.mode === "backfill") return [`resume with ${backfill(String(row.toBlock))}`]
  if (row.kind === "pause")
    return [
      `deploy the fixed release; ${row.source} stays paused through the restart`,
      `beside start: ${backfill(BELOW_CURSOR)}`,
      tail(`then pnpm quarantine clear ${row.source}, then start again`),
    ]
  if (replaysToCursor(row.source))
    return [`beside start: ${backfill(BELOW_CURSOR)}`, tail("then start again")]
  const steps = [`beside start: ${backfill(String(row.toBlock))}`]
  if (row.source === "inkypump") steps.push(`beside start: ${backfill(BELOW_CURSOR, "v4-swaps")}`)
  return steps
}

/** `groups` without the groups of each paused source, order kept. */
export function subtractPaused(
  groups: readonly BackfillSource[],
  paused: readonly SourceName[],
): BackfillSource[] {
  const left = new Set<BackfillSource>(paused.flatMap((name) => SOURCE_GROUPS[name]))
  return groups.filter((g) => !left.has(g))
}

/** Every source with an open live pause, oldest first. The names are the stored text. */
export async function openLivePauses(sql: Sql): Promise<{ source: string; fromBlock: bigint }[]> {
  const rows = await sql<{ source: string; from_block: bigint }[]>`
    select source, from_block from indexer.quarantine
    where kind = 'pause' and mode = 'live' and cleared_at is null
    order by id`
  return rows.map((r) => ({ source: r.source, fromBlock: BigInt(r.from_block) }))
}

/** Lifts the source's open live pause; null when there is none. Skips and backfill rows stay. */
export async function clearLivePause(
  sql: Sql,
  source: SourceName,
): Promise<{ fromBlock: bigint; createdAt: Date } | null> {
  const [r] = await sql<{ from_block: bigint; created_at: Date }[]>`
    update indexer.quarantine set cleared_at = now()
    where source = ${source} and kind = 'pause' and mode = 'live' and cleared_at is null
    returning from_block, created_at`
  return r ? { fromBlock: BigInt(r.from_block), createdAt: r.created_at } : null
}
