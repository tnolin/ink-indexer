import { parseArgs } from "node:util"

export const USAGE = "usage: main.ts start | backfill --from <block> [--to <block>]"

export type Cli =
  | { ok: true; command: "start" }
  | { ok: true; command: "backfill"; from: bigint; to: bigint | undefined }
  | { ok: false; usage: string; reason: string }

const bad = (reason: string): Cli => ({ ok: false, usage: USAGE, reason })

/** A non-negative decimal integer, as a bigint; undefined for anything else. */
const block = (v: string): bigint | undefined => (/^\d+$/.test(v) ? BigInt(v) : undefined)

/** Parses the command line without touching the environment, the database or the network. */
export function parseCli(argv: string[]): Cli {
  let parsed: { positionals: string[]; values: { from?: string; to?: string } }
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { from: { type: "string" }, to: { type: "string" } },
    })
  } catch (err) {
    return bad(err instanceof Error ? err.message : String(err))
  }
  const { positionals, values } = parsed
  const [command] = positionals
  if (command === "start") return { ok: true, command }
  if (command !== "backfill") return bad("unknown or missing command")
  if (values.from === undefined) return bad("backfill needs --from")
  const from = block(values.from)
  if (from === undefined) return bad("--from must be a non-negative integer")
  if (values.to === undefined) return { ok: true, command, from, to: undefined }
  const to = block(values.to)
  if (to === undefined) return bad("--to must be a non-negative integer")
  return { ok: true, command, from, to }
}
