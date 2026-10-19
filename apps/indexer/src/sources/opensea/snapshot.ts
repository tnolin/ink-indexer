import { createHash } from "node:crypto"
import type { Sql } from "@ink-indexer/db"
import {
  type NftCollectionEvent,
  type NftEvent,
  type NftGates,
  SCHEMA_VERSION,
} from "@ink-indexer/events"
import { INK_CHAIN_ID } from "@ink-indexer/sdk"
import type { Address } from "viem"
import type { Store } from "../../store"
import type { Tx } from "../source"

/** `nft_collections` as the snapshot reads it. Numbers that can pass 2^53 come back as strings. */
export type CollectionRow = {
  contract: string
  standard: string | null
  kind: string | null
  launchpad: string | null
  launch_token: string | null
  seadrop: boolean
  max_supply: string | null
  slug: string | null
  name: string | null
  image_url: string | null
  twitter: string | null
  website: string | null
  discord: string | null
  safelist: string | null
  opensea_url: string | null
  rarity_calculated_at: Date | null
  max_rank: number | null
  /** The collection owner OpenSea names. */
  owner: string | null
  /** The creator a launchpad campaign names; wins over `owner`. */
  creator_address: string | null
  /** The cached OpenSea account of the creator, null when none is cached. Not a column. */
  creator_account: { username: string | null; verified: boolean } | null
  verdict: string
  gates: NftGates | null
  /** A manual verdict mark is set (`nft_overrides`). Not a column. */
  manual: boolean
  snapshot_hash: string | null
  snapshot_n: number
}

/** Columns a caller may change together with the snapshot. */
export type CollectionPatch = Partial<
  Omit<
    CollectionRow,
    "contract" | "snapshot_hash" | "snapshot_n" | "creator_account" | "manual"
  > & {
    discovery_attempts: number
    next_discovery_at: Date | null
    discovered_at: Date | null
    next_metadata_at: Date | null
    next_drops_at: Date | null
    verdict_dirty: boolean
    next_verdict_at: Date | null
    next_traits_at: Date | null
    traits_checks: number
    max_supply_checked: boolean
    /** The total supply the OpenSea collection page states; not part of the snapshot. */
    total_supply: number | null
    prior_supply: string | null
    prior_minted: boolean | null
  }
>

const KINDS = ["drop", "continuous", "legacy"] as const
type Kind = (typeof KINDS)[number]
const VERDICTS = ["real", "pending", "junk"] as const

/** Fields the hash leaves out: they differ between two snapshots of the same collection. */
const BASE_FIELDS = new Set(["txHash", "logIndex", "blockNumber", "blockTimestamp"])

/** JSON with object keys sorted at every level, so equal values give equal text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  if (v !== null && typeof v === "object")
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`)
      .join(",")}}`
  return JSON.stringify(v)
}

/** sha256 of the event's canonical JSON without its base fields (hex). */
export function snapshotHash(e: NftEvent): string {
  const body = Object.fromEntries(Object.entries(e).filter(([k]) => !BASE_FIELDS.has(k)))
  return createHash("sha256").update(canonicalJson(body)).digest("hex")
}

/**
 * Gate states before any gate has been judged. Gates that judge a mint phase do not apply to a
 * collection with none.
 */
function pendingGates(kind: Kind): NftGates {
  const mintPhase = kind === "drop"
  return {
    page: "pending",
    structure: mintPhase ? "pending" : "n/a",
    traits: "pending",
    farm: mintPhase ? "pending" : "n/a",
    farmShareBps: null,
  }
}

/**
 * The `nft.collection` event for a row, or null while the row cannot make one (no standard yet).
 * The base fields other than `source` and `contract` are placeholders the caller fills in.
 */
export function composeCollection(
  row: CollectionRow,
  nowSeconds: number,
): NftCollectionEvent | null {
  if (row.standard !== "erc721" && row.standard !== "erc1155") return null
  // shortcut: a row with no kind yet is reported as a drop. Its verdict stays pending, so no feed
  // alert follows; kind detection re-emits the snapshot once it sets the kind. A `pending_kind`
  // row is reported as a drop too (the event has no such kind); its gates hold structure pending
  // and farm n/a, so it is never judged on mint grounds.
  const kind = KINDS.find((k) => k === row.kind) ?? "drop"
  const verdict = VERDICTS.find((v) => v === row.verdict) ?? "pending"
  const chimera = row.launchpad === "chimera"
  return {
    v: SCHEMA_VERSION,
    chainId: INK_CHAIN_ID,
    contract: row.contract as Address,
    source: "opensea",
    txHash: `os:col:${row.contract}:${row.snapshot_n + 1}`,
    logIndex: 0,
    blockNumber: "0",
    blockTimestamp: nowSeconds,
    type: "nft.collection",
    slug: row.slug,
    name: row.name,
    imageUrl: row.image_url,
    links: { twitter: row.twitter, website: row.website, discord: row.discord },
    standard: row.standard,
    kind,
    verdict,
    gates: row.gates ?? pendingGates(kind),
    manual: row.manual,
    safelist: row.safelist,
    maxSupply: row.max_supply,
    seadrop: row.seadrop,
    openseaUrl: row.opensea_url,
    rarityCalculatedAt: row.rarity_calculated_at
      ? Math.floor(row.rarity_calculated_at.getTime() / 1000)
      : null,
    maxRank: row.max_rank,
    launchpad: chimera ? "chimera" : null,
    launchToken: chimera ? ((row.launch_token as Address | null) ?? null) : null,
    creator: creatorOf(row),
  }
}

/** The address whose account describes the collection's creator. */
export const creatorAddress = (row: Pick<CollectionRow, "creator_address" | "owner">) =>
  row.creator_address ?? row.owner

function creatorOf(row: CollectionRow): NftCollectionEvent["creator"] {
  const address = creatorAddress(row)
  if (!address || !row.creator_account) return null
  return {
    address: address as Address,
    username: row.creator_account.username,
    verified: row.creator_account.verified,
  }
}

/** A snapshot was written for the row since this caller read it. */
export class SnapshotRaced extends Error {
  constructor(contract: string) {
    super(`nft.collection snapshot of ${contract} changed while it was being written`)
  }
}

export type Snapshots = ReturnType<typeof createSnapshots>

/** Writes `nft.collection` events: one whenever a collection's row makes a different event than the last. */
export function createSnapshots(deps: { sql: Sql; store: Store; now?: () => number }) {
  const { sql, store } = deps
  const now = deps.now ?? Date.now

  /**
   * Applies `patch` to the collection's row and, if the event the row now makes differs from the
   * last one written, writes it (`txHash` `os:col:<contract>:<n>`) in the same transaction, with the
   * new hash and count. The creator comes from the cached account (`nft_accounts`) of the row's
   * creator address, so a changed account makes a different event. Nothing is written for a row with no standard yet, or for an unknown
   * contract. True when an event was written. Database writes only: fetch before calling.
   */
  async function emitSnapshotIfChanged(
    contract: string,
    patch: CollectionPatch = {},
  ): Promise<boolean> {
    const [row] = await sql<Omit<CollectionRow, "creator_account">[]>`
      select contract, standard, kind, launchpad, launch_token, seadrop, max_supply::text as max_supply,
        slug, name, image_url, twitter, website, discord, safelist, opensea_url,
        rarity_calculated_at, max_rank, owner, creator_address, verdict, gates, snapshot_hash, snapshot_n,
        exists (select 1 from indexer.nft_overrides o
          where o.contract = c.contract and o.verdict is not null) as manual
      from indexer.nft_collections c where contract = ${contract}`
    if (!row) return false
    const merged = { ...row, ...patch }
    const who = creatorAddress(merged)
    const [account] = who
      ? await sql<{ username: string | null; verified: boolean }[]>`
          select username, verified from indexer.nft_accounts where address = ${who}`
      : []
    const apply = async (tx: Tx) => {
      if (Object.keys(patch).length === 0) return
      // The gates go in as jsonb.
      const columns =
        patch.gates === undefined
          ? patch
          : { ...patch, gates: patch.gates === null ? null : tx.json(patch.gates) }
      await tx`update indexer.nft_collections set ${tx(columns as Record<string, never>)} where contract = ${contract}`
    }
    const event = composeCollection(
      { ...merged, creator_account: account ?? null } as CollectionRow,
      Math.floor(now() / 1000),
    )
    const hash = event ? snapshotHash(event) : null
    if (!event || hash === row.snapshot_hash) {
      await sql.begin(apply)
      return false
    }
    await store.writeOffchain([{ event }], async (tx) => {
      await apply(tx)
      const moved = await tx`
        update indexer.nft_collections set snapshot_hash = ${hash}, snapshot_n = snapshot_n + 1
        where contract = ${contract} and snapshot_n = ${row.snapshot_n} returning 1`
      if (moved.length === 0) throw new SnapshotRaced(contract)
    })
    return true
  }

  return { emitSnapshotIfChanged }
}
