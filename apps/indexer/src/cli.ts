import { parseArgs } from "node:util"
import { type MarkValue, parseMark } from "./mark-cli"

export const USAGE =
  "usage: main.ts start | backfill --from <block> [--to <block>] [--sources <names>] | mark <contract> <mark>"

/**
 * The names `backfill --sources` takes. `inkypump` is the InkyPump source; the NFT source's filters
 * come in three groups: `nft-mints` (mints, burns and SeaDrop logs), `nft-sales` (Seaport) and
 * `nft-launches` (the Chimera factory).
 */
export const BACKFILL_SOURCES = ["inkypump", "nft-mints", "nft-sales", "nft-launches"] as const

export type Cli =
  | { ok: true; command: "start" }
  | {
      ok: true
      command: "backfill"
      from: bigint
      to: bigint | undefined
      /** Undefined: every source. */
      sources?: string[]
    }
  | { ok: true; command: "mark"; contract: string; value: MarkValue }
  | { ok: false; usage: string; reason: string }

const bad = (reason: string): Cli => ({ ok: false, usage: USAGE, reason })

/** A non-negative decimal integer, as a bigint; undefined for anything else. */
const block = (v: string): bigint | undefined => (/^\d+$/.test(v) ? BigInt(v) : undefined)

/** A comma-separated list of `BACKFILL_SOURCES`, without duplicates; a string says what is wrong. */
function sourceList(v: string): string[] | string {
  const names = v.split(",").map((s) => s.trim())
  const known: readonly string[] = BACKFILL_SOURCES
  for (const name of names) {
    if (name === "") return "--sources needs comma-separated source names"
    if (!known.includes(name))
      return `unknown source: ${name} (expected ${BACKFILL_SOURCES.join(", ")})`
  }
  return [...new Set(names)]
}

/** Parses the command line without touching the environment, the database or the network. */
export function parseCli(argv: string[]): Cli {
  if (argv[0] === "mark") {
    const mark = parseMark(argv.slice(1))
    return mark.ok
      ? { ok: true, command: "mark", contract: mark.contract, value: mark.value }
      : mark
  }
  let parsed: {
    positionals: string[]
    values: { from?: string; to?: string; sources?: string }
  }
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        sources: { type: "string" },
      },
    })
  } catch (err) {
    return bad(err instanceof Error ? err.message : String(err))
  }
  const { positionals, values } = parsed
  const [command] = positionals
  if (command === "start") {
    if (values.from !== undefined || values.to !== undefined || values.sources !== undefined)
      return bad("start takes no options")
    return { ok: true, command }
  }
  if (command !== "backfill") return bad("unknown or missing command")
  if (values.from === undefined) return bad("backfill needs --from")
  const from = block(values.from)
  if (from === undefined) return bad("--from must be a non-negative integer")
  let sources: string[] | undefined
  if (values.sources !== undefined) {
    const list = sourceList(values.sources)
    if (typeof list === "string") return bad(list)
    sources = list
  }
  if (values.to === undefined) return { ok: true, command, from, to: undefined, sources }
  const to = block(values.to)
  if (to === undefined) return bad("--to must be a non-negative integer")
  return { ok: true, command, from, to, sources }
}
