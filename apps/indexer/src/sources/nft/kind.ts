import { CONTINUOUS_BURN_BPS, CONTINUOUS_MIN_MINTS, PENDING_KIND_BURN_BPS } from "./policy"

/** What a collection is, as `nft.collection` reports it. */
export type Kind = "drop" | "continuous" | "legacy"

export type KindFacts = {
  launchpad: "chimera" | null
  /** Mints in the kind window (`KIND_WINDOW_S` from the first mint). */
  mints7d: number
  /** Burns in the same window. */
  burns7d: number
  /** A SeaDrop log names the contract. */
  seadrop: boolean
  /** `maxSupply()` as read, null when it reverted or has not been read. */
  maxSupply: bigint | null
  maxSupplyChecked: boolean
  /** Unix seconds; null when no mint is stored. */
  firstMintTs: number | null
  /** Unix seconds of the start of the indexer's mint history. */
  historyStartTs: number
  /** A manual mark. */
  override?: Kind
}

const atLeastBps = (part: number, whole: number, bps: number) => part * 10_000 >= whole * bps

/**
 * The kind of a collection, in this order:
 * - a manual mark wins;
 * - a Chimera collection is `continuous` from its first block;
 * - `legacy` when the first mint predates the mint history, or when no mint is stored and nothing
 *   says a mint is coming (a SeaDrop collection before its first mint is a `drop`);
 * - `continuous` by the burn-ratio fallback: enough mints, enough burns, no SeaDrop and a
 *   `maxSupply()` that reverts;
 * - `pending_kind` for a contract without SeaDrop whose burns are already a notable share of its
 *   mints, so a young WIRED-like collection is never judged on mint grounds;
 * - `drop` otherwise.
 */
export function classifyKind(f: KindFacts): Kind | "pending_kind" {
  if (f.override) return f.override
  if (f.launchpad === "chimera") return "continuous"
  if (f.firstMintTs === null ? !f.seadrop : f.firstMintTs < f.historyStartTs) return "legacy"
  if (
    !f.seadrop &&
    f.mints7d >= CONTINUOUS_MIN_MINTS &&
    atLeastBps(f.burns7d, f.mints7d, CONTINUOUS_BURN_BPS) &&
    f.maxSupplyChecked &&
    f.maxSupply === null
  )
    return "continuous"
  if (!f.seadrop && f.burns7d > 0 && atLeastBps(f.burns7d, f.mints7d, PENDING_KIND_BURN_BPS))
    return "pending_kind"
  return "drop"
}
