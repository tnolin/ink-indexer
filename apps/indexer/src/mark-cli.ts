import type { Sql } from "@ink-indexer/db"
import type { Job } from "./sources/opensea/scheduler"

// The manual mark: `nft:mark <contract> <real|filtered|continuous|drop|clear>`. `real` and `filtered` set
// the verdict, `continuous` and `drop` the kind, `clear` removes both. The process entry point is
// `main.ts mark` (the `nft:mark` script).

export const MARK_USAGE = "usage: nft:mark <contract> <real|filtered|continuous|drop|clear>"

const VALUES = ["real", "filtered", "continuous", "drop", "clear"] as const
export type MarkValue = (typeof VALUES)[number]
export type Mark = { contract: string; value: MarkValue; note?: string }

/** Parses the arguments without touching the database. The contract comes back lowercase. */
export function parseMark(
  args: string[],
): ({ ok: true } & Mark) | { ok: false; usage: string; reason: string } {
  const [contract, value] = args
  const bad = (reason: string) => ({ ok: false as const, usage: MARK_USAGE, reason })
  if (args.length !== 2 || contract === undefined || value === undefined)
    return bad("expected a contract and a mark")
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return bad("the contract must be a 0x address")
  const mark = VALUES.find((v) => v === value)
  if (!mark) return bad(`unknown mark: ${value}`)
  return { ok: true, contract: contract.toLowerCase(), value: mark }
}

/**
 * Writes the mark to `nft_overrides`, marks the collection's verdict dirty and runs the verdict job
 * for it, which re-emits the collection snapshot when it changed. A mark on a contract with no
 * collection row yet is kept and applies once the row exists.
 */
export async function applyMark(deps: { sql: Sql; verdict: Job }, mark: Mark): Promise<void> {
  const { sql } = deps
  const { contract, value } = mark
  await sql.begin(async (tx) => {
    if (value === "clear") {
      await tx`delete from indexer.nft_overrides where contract = ${contract}`
    } else {
      const column = value === "real" || value === "filtered" ? "verdict" : "kind"
      await tx`
        insert into indexer.nft_overrides ${tx({ contract, [column]: value, note: mark.note ?? null, set_at: new Date() })}
        on conflict (contract) do update set
          ${tx({ [column]: value, note: mark.note ?? null, set_at: new Date() })}`
    }
    await tx`update indexer.nft_collections set verdict_dirty = true where contract = ${contract}`
  })
  await deps.verdict.run(contract)
}
