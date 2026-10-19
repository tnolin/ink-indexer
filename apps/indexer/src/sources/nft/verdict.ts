import type { Sql } from "@ink-indexer/db"
import {
  type GateState,
  type NftDropStage,
  type NftGates,
  type NftMintEvent,
  SCHEMA_VERSION,
} from "@ink-indexer/events"
import { INK_CHAIN_ID } from "@ink-indexer/sdk"
import type { Address } from "viem"
import type { Chain } from "../../chain"
import type { Logger } from "../../log"
import type { Store } from "../../store"
import type { Job } from "../opensea/scheduler"
import type { CollectionPatch, Snapshots } from "../opensea/snapshot"
import { classifyKind, type Kind } from "./kind"
import {
  FARM_MIN_MINTERS,
  FARM_MIN_OTHER,
  FARM_SHARE_MAX_BPS,
  FARM_WINDOW_S,
  JOBS_PER_TICK,
  KIND_WINDOW_S,
  MINT_END_IDLE_S,
  MINT_LIVE_VERIFIED_MINTS,
  SCHEDULER_TICK_MS,
  STILL_MINTING_S,
  STRUCTURE_MIN_MINT_S,
  TRAITS_CHECKPOINTS_S,
  TRAITS_GRACE_S,
  VERDICT_RECHECK_S,
} from "./policy"

// The owner's four gates and the verdict they give (spec "Collection verdicts"). The pure part
// decides; the verdict job gathers the facts, stores the result and writes the snapshot.

export type Verdict = "real" | "pending" | "junk"

/**
 * What the traits sample showed: `pass` (the item has traits), `empty` (no traits and no rarity
 * rank) or `pending` (not sampled yet, or nothing to decide from).
 */
export type TraitsState = "pending" | "pass" | "empty"

/** Everything the gates look at. Times are unix seconds. */
export type GateFacts = {
  kind: Kind | "pending_kind"
  /** A manual verdict mark. */
  override: "real" | "junk" | null
  /** OpenSea's safelist status. */
  safelist: string | null
  /** The creator's OpenSea account is verified. */
  creatorVerified: boolean
  /** The collection page fields. */
  page: {
    slug: string | null
    name: string | null
    imageUrl: string | null
    twitter: string | null
    website: string | null
  }
  /** A slug lookup is still scheduled: discovery has not given up. */
  discoveryRetrying: boolean
  /** The stage types of the stored drop page. */
  dropStages: { type: string }[]
  /** SeaDrop stage indexes seen on chain or announced from the drop schedule. */
  stageIndexes: number[]
  firstMintTs: number | null
  lastMintTs: number | null
  soldOutTs: number | null
  now: number
  /** The traits sample and how many of its checkpoints are done (see `traitsSchedule`). */
  traits: { state: TraitsState; checks: number }
  /** Farm wallets' share of the minters, in basis points; null when not measured. */
  farmShareBps: number | null
  distinctMinters: number
}

const isVerified = (f: Pick<GateFacts, "safelist" | "creatorVerified">) =>
  f.safelist === "verified" || f.creatorVerified

const filled = (s: string | null) => s !== null && s.trim() !== ""

/** Gate 1. A verified collection or creator passes at once (amendment 2026-10-19). */
function pageGate(f: GateFacts): GateState {
  if (isVerified(f)) return "pass"
  const p = f.page
  if (p.slug)
    return filled(p.name) && filled(p.imageUrl) && (filled(p.twitter) || filled(p.website))
      ? "pass"
      : "fail"
  return f.discoveryRetrying ? "pending" : "fail"
}

/** More than one stage, or any signed or allowlist stage, on the drop page or on chain. */
function hasStages(f: Pick<GateFacts, "dropStages" | "stageIndexes">): boolean {
  return (
    f.dropStages.length > 1 ||
    f.dropStages.some((s) => /signed|allowlist/.test(s.type)) ||
    new Set(f.stageIndexes).size > 1 ||
    // SeaDrop's public stage is index 0; every other index is a signed or allowlist stage.
    f.stageIndexes.some((i) => i !== 0)
  )
}

/**
 * Gate 2 by how long the mint ran: it passes once the mint is still going 30 minutes after the
 * first mint (a mint in the last 10 minutes) or sold out more than 30 minutes after it; it fails
 * when it sold out sooner or stopped before 30 minutes.
 */
export function structureByDuration(
  f: Pick<GateFacts, "firstMintTs" | "lastMintTs" | "soldOutTs" | "now">,
): GateState {
  const first = f.firstMintTs
  if (first === null) return "pending"
  if (f.soldOutTs !== null) return f.soldOutTs - first > STRUCTURE_MIN_MINT_S ? "pass" : "fail"
  const last = f.lastMintTs ?? first
  if (last - first > STRUCTURE_MIN_MINT_S) return "pass"
  if (f.now - first < STRUCTURE_MIN_MINT_S) return "pending"
  return f.now - last <= STILL_MINTING_S ? "pass" : "fail"
}

/** Gate 2, for drops only. A collection whose kind is undecided waits. */
function structureGate(f: GateFacts): GateState | "n/a" {
  if (f.kind === "continuous" || f.kind === "legacy") return "n/a"
  if (f.kind === "pending_kind") return "pending"
  if (isVerified(f) || hasStages(f)) return "pass"
  return structureByDuration(f)
}

/**
 * When the mint ended: the sell-out, or a day after the last mint once that day has passed. A
 * continuous collection has no mint phase; its first day stands in for one, so its traits are
 * sampled too. Null while the mint runs, or with no mint stored.
 */
export function mintEndTs(
  f: Pick<GateFacts, "kind" | "firstMintTs" | "lastMintTs" | "soldOutTs" | "now">,
): number | null {
  if (f.kind === "continuous") {
    const end = f.firstMintTs === null ? null : f.firstMintTs + MINT_END_IDLE_S
    return end !== null && f.now >= end ? end : null
  }
  if (f.soldOutTs !== null) return f.soldOutTs
  if (f.lastMintTs !== null && f.now >= f.lastMintTs + MINT_END_IDLE_S)
    return f.lastMintTs + MINT_END_IDLE_S
  return null
}

/**
 * Gate 3. Fails only after the last checkpoint, 72 hours after the mint ended, found an item with
 * no traits and no rank; pending until then.
 */
function traitsGate(f: GateFacts): GateState {
  if (f.traits.state === "pass") return "pass"
  const end = mintEndTs(f)
  return f.traits.state === "empty" &&
    f.traits.checks >= TRAITS_CHECKPOINTS_S.length &&
    end !== null &&
    f.now >= end + TRAITS_GRACE_S
    ? "fail"
    : "pending"
}

/** Gate 4, for drops only, decided once there are enough minters. */
function farmGate(f: GateFacts): GateState | "n/a" {
  if (f.kind !== "drop") return "n/a"
  if (f.farmShareBps === null || f.distinctMinters < FARM_MIN_MINTERS) return "pending"
  return f.farmShareBps > FARM_SHARE_MAX_BPS ? "fail" : "pass"
}

/**
 * The four gates and the verdict. Precedence: a manual mark, then `safelist: verified`, then the
 * gates: any failed gate is `junk`; otherwise `pending` while gate 1 or 2 is undecided; otherwise
 * `real` (gates 3 and 4 only need not to have failed).
 */
export function evaluateGates(f: GateFacts): { gates: NftGates; verdict: Verdict } {
  const gates: NftGates = {
    page: pageGate(f),
    structure: structureGate(f),
    traits: traitsGate(f),
    farm: farmGate(f),
    farmShareBps: f.kind === "drop" ? f.farmShareBps : null,
  }
  const states = [gates.page, gates.structure, gates.traits, gates.farm]
  const verdict: Verdict = f.override
    ? f.override
    : f.safelist === "verified"
      ? "real"
      : states.includes("fail")
        ? "junk"
        : gates.page === "pending" || gates.structure === "pending"
          ? "pending"
          : "real"
  return { gates, verdict }
}

/**
 * When the traits sample is next due, and how many checkpoints are done or skipped. The
 * checkpoints are the mint end, then 24, 48 and 72 hours later. Checkpoints that passed unsampled
 * are skipped, so only the latest past one is sampled.
 *
 * shortcut: a mint that resumes after a day without mints moves its end; checkpoints already done
 * keep counting against the new end. Store the end each check was made against to make it exact.
 */
export function traitsSchedule(f: GateFacts): { nextTraitsAt: number | null; checks: number } {
  const { state, checks } = f.traits
  const end = state === "pass" ? null : mintEndTs(f)
  if (end === null || checks >= TRAITS_CHECKPOINTS_S.length) return { nextTraitsAt: null, checks }
  let passed = -1
  TRAITS_CHECKPOINTS_S.forEach((offset, i) => {
    if (end + offset <= f.now) passed = i
  })
  const k = Math.max(checks, passed)
  return { nextTraitsAt: end + TRAITS_CHECKPOINTS_S[k]!, checks: k }
}

/**
 * When the verdict is next due by time, or null. The earliest of: gate 2's decision 30 minutes
 * after the first mint, the mint end (the traits checkpoints start there), and an hourly look while
 * the collection mints and its kind or mint gates can still change. A kind fixed by a launchpad or
 * a manual mark does not change with mints. Everything else (pages, drops, milestones, traits
 * samples, discovery giving up) marks the verdict dirty instead.
 */
export function nextVerdictAt(f: GateFacts, opts: { kindFixed?: boolean } = {}): number | null {
  const at: number[] = []
  const first = f.firstMintTs
  if (f.kind === "drop" && first !== null) at.push(first + STRUCTURE_MIN_MINT_S)
  const ended = mintEndTs(f) !== null
  if (!ended) {
    if (f.kind === "continuous") {
      if (first !== null) at.push(first + MINT_END_IDLE_S)
    } else if (f.lastMintTs !== null) at.push(f.lastMintTs + MINT_END_IDLE_S)
  }
  const minting = !ended && f.lastMintTs !== null && f.now - f.lastMintTs < MINT_END_IDLE_S
  const kindMayChange =
    !opts.kindFixed && f.kind !== "legacy" && first !== null && f.now < first + KIND_WINDOW_S
  if (minting && (f.kind === "drop" || f.kind === "pending_kind" || kindMayChange))
    at.push(f.now + VERDICT_RECHECK_S)
  const ahead = at.filter((t) => t > f.now)
  return ahead.length > 0 ? Math.min(...ahead) : null
}

/**
 * Whether a mint with no SeaDrop stages gets its MINT LIVE now: a `drop` (never `pending_kind`)
 * still minting and not announced yet. A verified collection or creator is announced after 10
 * mints; any other once gate 2 passes by duration.
 */
export function mintLiveDue(
  f: GateFacts & { seadrop: boolean; mintStartEmitted: boolean; minted: number },
): boolean {
  if (f.kind !== "drop" || f.seadrop || f.mintStartEmitted || f.firstMintTs === null) return false
  if (mintEndTs(f) !== null) return false
  if (isVerified(f)) return f.minted >= MINT_LIVE_VERIFIED_MINTS
  return structureByDuration(f) === "pass"
}

// ---- The verdict job ----

// shortcut: mint times are derived from block numbers, one block a second from the collection's
// first mint, because the mint tables store blocks, not times. Ink's block time is fixed; store a
// block-time column if that ever changes.
const BLOCK_S = 1

/**
 * Farm wallets' share of the contract's distinct minters, in basis points. A farm wallet is a
 * minter of this contract that, within the farm window before `nowS`, received mints from at least
 * five other contracts whose kind is `drop`. One statement over `nft_mints`.
 */
export async function farmShareBps(
  sql: Sql,
  contract: string,
  nowS: number,
): Promise<{ share: number; minters: number }> {
  const [r] = await sql<{ minters: number; farm: number }[]>`
    with c as (
      select first_mint_block
        + (${nowS - FARM_WINDOW_S}::bigint - extract(epoch from first_mint_ts)::bigint) / ${BLOCK_S}
        as from_block
      from indexer.nft_collections where contract = ${contract}
    ),
    mine as (select distinct recipient from indexer.nft_mints where contract = ${contract}),
    farm as (
      select m.recipient
      from indexer.nft_mints m
      join indexer.nft_collections o on o.contract = m.contract and o.kind = 'drop'
      where m.recipient in (select recipient from mine)
        and m.contract <> ${contract}
        and m.block >= (select from_block from c)
      group by m.recipient
      having count(distinct m.contract) >= ${FARM_MIN_OTHER}
    )
    select (select count(*) from mine)::int as minters, (select count(*) from farm)::int as farm`
  const minters = r?.minters ?? 0
  return { share: minters > 0 ? Math.floor((r!.farm * 10_000) / minters) : 0, minters }
}

type FactsRow = {
  kind: string | null
  launchpad: string | null
  seadrop: boolean
  max_supply: string | null
  max_supply_checked: boolean
  first_ts: string | null
  first_block: string | null
  sold_out_block: string | null
  slug: string | null
  name: string | null
  image_url: string | null
  twitter: string | null
  website: string | null
  safelist: string | null
  discovery_retrying: boolean
  traits_state: TraitsState
  traits_checks: number
  mint_start_emitted: boolean
  creator_verified: boolean
  override_kind: string | null
  override_verdict: string | null
  last_block: string | null
  minted: string
  minters: number
  mints_7d: string
  burns_7d: string
  stage_indexes: number[]
  drop_stages: NftDropStage[] | null
}

async function loadFacts(sql: Sql, contract: string): Promise<FactsRow | undefined> {
  const [row] = await sql<FactsRow[]>`
    select c.kind, c.launchpad, c.seadrop, c.max_supply::text as max_supply, c.max_supply_checked,
      extract(epoch from c.first_mint_ts)::bigint::text as first_ts,
      c.first_mint_block::text as first_block, c.sold_out_block::text as sold_out_block,
      c.slug, c.name, c.image_url, c.twitter, c.website, c.safelist,
      c.slug is null and c.next_discovery_at is not null as discovery_retrying,
      c.traits_state, c.traits_checks, c.mint_start_emitted,
      coalesce(a.verified, false) as creator_verified,
      o.kind as override_kind, o.verdict as override_verdict,
      m.last_block::text as last_block, coalesce(m.minted, 0)::text as minted,
      coalesce(m.minters, 0)::int as minters, coalesce(m.mints_7d, 0)::text as mints_7d,
      (select coalesce(sum(b.qty), 0) from indexer.nft_burns b
        where b.contract = c.contract and b.block >= c.first_mint_block
          and b.block < c.first_mint_block + ${KIND_WINDOW_S / BLOCK_S})::text as burns_7d,
      array(
        select stage from indexer.nft_seadrop_mints where contract = c.contract
        union select stage_index from indexer.nft_stages where contract = c.contract
      ) as stage_indexes,
      d.stages as drop_stages
    from indexer.nft_collections c
    left join indexer.nft_accounts a on a.address = coalesce(c.creator_address, c.owner)
    left join indexer.nft_overrides o on o.contract = c.contract
    left join indexer.nft_drops d on d.contract = c.contract
    left join lateral (
      select max(block) as last_block, sum(qty) as minted, count(distinct recipient) as minters,
        sum(qty) filter (where block < c.first_mint_block + ${KIND_WINDOW_S / BLOCK_S}) as mints_7d
      from indexer.nft_mints where contract = c.contract
    ) m on true
    where c.contract = ${contract}`
  return row
}

export type VerdictDeps = {
  sql: Sql
  store: Store
  snapshots: Snapshots
  chain: Pick<Chain, "readMaxSupply">
  /** Unix seconds of the start of the mint history: a collection that first minted earlier is `legacy`. */
  historyStartTs: number
  log: Logger
  now?: () => number
}

const asKind = (v: string | null): Kind | undefined =>
  v === "drop" || v === "continuous" ? v : undefined
const asVerdict = (v: string | null): "real" | "junk" | null =>
  v === "real" || v === "junk" ? v : null
const toDate = (s: number | null) => (s === null ? null : new Date(s * 1000))

/**
 * The verdict job: collections marked dirty and collections whose `next_verdict_at` is due. Each
 * run reads the collection's facts (and `maxSupply()` once), decides its kind, gates and verdict,
 * stores them with the next due times and writes the `nft.collection` snapshot if it changed. A
 * mint with no SeaDrop stages also gets its MINT LIVE stage start here.
 */
export function createVerdictJob(deps: VerdictDeps): Job {
  const { sql, store, snapshots, chain } = deps
  const now = deps.now ?? Date.now

  async function evaluate(contract: string): Promise<void> {
    const row = await loadFacts(sql, contract)
    if (!row) return
    const nowS = Math.floor(now() / 1000)
    const firstTs = row.first_ts === null ? null : Number(row.first_ts)
    const firstBlock = row.first_block === null ? null : BigInt(row.first_block)
    const tsOf = (block: string | null) =>
      block === null || firstTs === null || firstBlock === null
        ? null
        : firstTs + Number(BigInt(block) - firstBlock) * BLOCK_S
    const lastMintTs = tsOf(row.last_block)

    // maxSupply() is read once, at the latest stored mint, unless the milestones already know it.
    let maxSupply = row.max_supply === null ? null : BigInt(row.max_supply)
    const patch: CollectionPatch = {}
    if (!row.max_supply_checked && row.last_block !== null) {
      if (maxSupply === null) {
        maxSupply = await chain.readMaxSupply(contract as Address, BigInt(row.last_block))
        if (maxSupply !== null) patch.max_supply = maxSupply.toString()
      }
      patch.max_supply_checked = true
    }
    const minted = BigInt(row.minted)
    const soldOutTs =
      tsOf(row.sold_out_block) ??
      (maxSupply !== null && maxSupply > 0n && minted >= maxSupply ? lastMintTs : null)

    const overrideKind = asKind(row.override_kind)
    const chimera = row.launchpad === "chimera"
    const kind = classifyKind({
      launchpad: chimera ? "chimera" : null,
      mints7d: Number(row.mints_7d),
      burns7d: Number(row.burns_7d),
      seadrop: row.seadrop,
      maxSupply,
      maxSupplyChecked: row.max_supply_checked || patch.max_supply_checked === true,
      firstMintTs: firstTs,
      historyStartTs: deps.historyStartTs,
      override: overrideKind,
    })
    const farm =
      kind === "drop" && row.minters >= FARM_MIN_MINTERS
        ? await farmShareBps(sql, contract, nowS)
        : null

    const facts: GateFacts = {
      kind,
      override: asVerdict(row.override_verdict),
      safelist: row.safelist,
      creatorVerified: row.creator_verified,
      page: {
        slug: row.slug,
        name: row.name,
        imageUrl: row.image_url,
        twitter: row.twitter,
        website: row.website,
      },
      discoveryRetrying: row.discovery_retrying,
      dropStages: row.drop_stages ?? [],
      stageIndexes: row.stage_indexes,
      firstMintTs: firstTs,
      lastMintTs,
      soldOutTs,
      now: nowS,
      traits: { state: row.traits_state, checks: row.traits_checks },
      farmShareBps: farm?.share ?? null,
      distinctMinters: row.minters,
    }
    const { gates, verdict } = evaluateGates(facts)
    const traits = traitsSchedule(facts)
    const next = nextVerdictAt(facts, { kindFixed: chimera || overrideKind !== undefined })

    await snapshots.emitSnapshotIfChanged(contract, {
      ...patch,
      kind,
      verdict,
      gates,
      next_verdict_at: toDate(next),
      next_traits_at: toDate(traits.nextTraitsAt),
      traits_checks: traits.checks,
    })

    const live = {
      ...facts,
      seadrop: row.seadrop,
      mintStartEmitted: row.mint_start_emitted,
      minted: Number(minted),
    }
    if (mintLiveDue(live)) await writeMintLive(contract, live, maxSupply, nowS)
  }

  /** The MINT LIVE stage start, written once: the flag and the event key both guard it. */
  async function writeMintLive(
    contract: string,
    f: GateFacts & { minted: number },
    maxSupply: bigint | null,
    nowS: number,
  ) {
    const event: NftMintEvent = {
      v: SCHEMA_VERSION,
      chainId: INK_CHAIN_ID,
      contract: contract as Address,
      source: "opensea",
      txHash: `nft:start:${contract}`,
      logIndex: 0,
      blockNumber: "0",
      blockTimestamp: nowS,
      type: "nft.mint",
      kind: "stage_start",
      stageIndex: 0,
      stageLabel: "Mint",
      // shortcut: a mint with no SeaDrop stages has no price in its logs; "0" stands for unknown.
      // Read the mint transaction's value to report it.
      stagePriceWei: "0",
      markBps: null,
      minted: f.minted.toString(),
      maxSupply: maxSupply?.toString() ?? "0",
      mintStartTs: f.firstMintTs!,
      stageStartTs: f.firstMintTs!,
      minters: f.distinctMinters,
    }
    await store.writeOffchain([{ event, sub: "mint:stage_start:0" }], async (tx) => {
      await tx`
        update indexer.nft_collections set mint_start_emitted = true where contract = ${contract}`
    })
  }

  return {
    name: "nft-verdict",
    everyMs: SCHEDULER_TICK_MS,
    async due(sql, at) {
      const rows = await sql<{ contract: string }[]>`
        select contract from indexer.nft_collections
        where verdict_dirty or next_verdict_at <= ${at}
        order by next_verdict_at nulls first limit ${JOBS_PER_TICK}`
      return rows.map((r) => r.contract)
    },
    async run(contract) {
      // Clear the mark first, so a writer that marks the row again while this run reads it is not
      // lost. A run that fails marks it again, to be tried next tick.
      const claimed = await sql`
        update indexer.nft_collections set verdict_dirty = false where contract = ${contract}
        returning 1`
      if (claimed.length === 0) return
      try {
        await evaluate(contract)
      } catch (err) {
        await sql`
          update indexer.nft_collections set verdict_dirty = true where contract = ${contract}`.catch(
          () => {},
        )
        throw err
      }
    },
  }
}
