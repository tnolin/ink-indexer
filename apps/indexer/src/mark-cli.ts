import type { Sql } from "@ink-indexer/db"
import type { Job } from "./sources/opensea/scheduler"

// The manual mark: `nft:mark <contract> <real|filtered|continuous|drop|clear> [--max-supply <n>]`.
// `real` and `filtered` set the verdict, `continuous` and `drop` the kind, `clear` removes the marks.
// `--max-supply` sets the collection's max supply by hand, for a contract that does not report one.
// The process entry point is `main.ts mark` (the `nft:mark` script).

export const MARK_USAGE =
  "usage: nft:mark <contract> <real|filtered|continuous|drop|clear> [--max-supply <n>]"

const VALUES = ["real", "filtered", "continuous", "drop", "clear"] as const
export type MarkValue = (typeof VALUES)[number]
export type Mark = { contract: string; value: MarkValue; note?: string; maxSupply?: bigint }

/** The widest value a `numeric(78, 0)` column holds has 78 digits. */
const MAX_SUPPLY = /^\d{1,78}$/

/** Parses the arguments without touching the database. The contract comes back lowercase. */
export function parseMark(
  args: string[],
): ({ ok: true } & Mark) | { ok: false; usage: string; reason: string } {
  const [contract, value, ...rest] = args
  const bad = (reason: string) => ({ ok: false as const, usage: MARK_USAGE, reason })
  if (contract === undefined || value === undefined) return bad("expected a contract and a mark")
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return bad("the contract must be a 0x address")
  const mark = VALUES.find((v) => v === value)
  if (!mark) return bad(`unknown mark: ${value}`)
  const parsed = { ok: true as const, contract: contract.toLowerCase(), value: mark }
  if (rest.length === 0) return parsed
  if (rest[0] !== "--max-supply" || rest.length !== 2)
    return bad(
      rest.filter((a) => a === "--max-supply").length > 1
        ? "--max-supply was given more than once"
        : "expected a contract and a mark, then optionally --max-supply <n>",
    )
  if (mark === "clear") return bad("clear removes the marks; it takes no --max-supply")
  const n = rest[1] as string
  if (!MAX_SUPPLY.test(n) || BigInt(n) === 0n)
    return bad("--max-supply must be a whole number from 1 to 78 digits")
  return { ...parsed, maxSupply: BigInt(n) }
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
      // A max supply that was set by hand is forgotten with its mark: the next verdict run reads it
      // from the contract again.
      await tx`
        update indexer.nft_collections set max_supply = null, max_supply_checked = false
        where contract = ${contract}
          and exists (
            select 1 from indexer.nft_overrides where contract = ${contract} and max_supply is not null)`
      await tx`delete from indexer.nft_overrides where contract = ${contract}`
    } else {
      const column = value === "real" || value === "filtered" ? "verdict" : "kind"
      // Marking without --max-supply leaves an earlier one in place.
      const fields = {
        [column]: value,
        note: mark.note ?? null,
        set_at: new Date(),
        ...(mark.maxSupply === undefined ? {} : { max_supply: mark.maxSupply.toString() }),
      }
      await tx`
        insert into indexer.nft_overrides ${tx({ contract, ...fields })}
        on conflict (contract) do update set ${tx(fields)}`
    }
    await tx`update indexer.nft_collections set verdict_dirty = true where contract = ${contract}`
  })
  await deps.verdict.run(contract)
}
