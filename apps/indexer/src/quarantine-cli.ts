import type { Sql } from "@ink-indexer/db"
import type { Logger } from "./log"
import { clearLivePause } from "./quarantine"
import { SOURCE_GROUPS, type SourceName } from "./sources/source"

// `quarantine clear <source>` lifts a source's open live pause once the fixed release is deployed
// and its blocks are replayed. The process entry point is `main.ts quarantine`.

export const QUARANTINE_USAGE = "usage: quarantine clear <source>"

const SOURCE_NAMES = Object.keys(SOURCE_GROUPS) as SourceName[]

/** Parses the arguments without touching the database. The name must match a source exactly. */
export function parseQuarantine(
  args: string[],
): { ok: true; source: SourceName } | { ok: false; usage: string; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, usage: QUARANTINE_USAGE, reason })
  if (args.length !== 2 || args[0] !== "clear") return bad("expected clear and a source")
  const name = args[1] as string
  const source = SOURCE_NAMES.find((s) => s === name)
  if (!source) return bad(`unknown source: ${name} (expected ${SOURCE_NAMES.join(", ")})`)
  return { ok: true, source }
}

/** Lifts the source's open live pause and logs what was lifted, or that there was none. */
export async function runQuarantineClear(sql: Sql, log: Logger, source: SourceName): Promise<void> {
  const cleared = await clearLivePause(sql, source)
  if (cleared)
    log("info", "quarantine cleared", {
      source,
      fromBlock: cleared.fromBlock,
      createdAt: cleared.createdAt,
    })
  else log("info", "no open pause", { source })
}
