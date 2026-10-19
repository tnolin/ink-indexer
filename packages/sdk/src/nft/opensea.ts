/**
 * Parsers for OpenSea REST v2 responses. Each takes the parsed JSON body and is tolerant: a field
 * that is missing or the wrong type comes back null (or empty), and input that is not usable at all
 * gives null. None of them throws.
 */

export type OsContract = { slug: string | null; standard: string }

export type OsCollection = {
  slug: string
  name: string | null
  imageUrl: string | null
  /** The Twitter username, without the @. */
  twitter: string | null
  website: string | null
  discord: string | null
  /** OpenSea's safelist status, such as "verified" or "not_requested". */
  safelist: string | null
  /** Calendar date, YYYY-MM-DD. */
  createdDate: string | null
  totalSupply: number | null
  /** When OpenSea last computed ranks, as OpenSea writes it. */
  rarityCalculatedAt: string | null
  maxRank: number | null
  openseaUrl: string | null
  /** The collection owner's address, lowercase. */
  owner: string | null
}

export type OsAccount = {
  username: string | null
  verified: boolean
}

export type OsStats = {
  floorWei: bigint | null
  owners: number | null
  volume24hWei: bigint | null
  sales24h: number | null
  /** Always null today: the stats endpoint does not carry it; read it from the collection. */
  totalSupply: number | null
}

export type OsDropStage = {
  type: string
  label: string
  priceWei: bigint
  /** Unix seconds. */
  startTime: number
  /** Unix seconds. Null when the stage has no end. */
  endTime: number | null
  maxPerWallet: number | null
  allowlistCount: number | null
}

export type OsDrop = {
  slug: string | null
  contract: string | null
  isMinting: boolean
  totalSupply: bigint | null
  maxSupply: bigint | null
  feeBps: number | null
  /** Ordered by start time. */
  stages: OsDropStage[]
}

export type OsNft = {
  rank: number | null
  traits: { type: string; value: string }[]
  name: string | null
  imageUrl: string | null
}

type Obj = Record<string, unknown>

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null
}

/** A non-empty string, else null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null
}

/** A finite number, or a string of digits that parses to one, else null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return null
}

/** A non-negative integer given as a number or a decimal string, else null. */
function big(v: unknown): bigint | null {
  if (typeof v === "string") return /^\d+$/.test(v) ? BigInt(v) : null
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  return null
}

const NUMBER = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i
const MAX_EXPONENT = 60

/**
 * An amount in ETH, as a float or a decimal string, to wei. The digits are read from the decimal
 * text, never multiplied as floats, so 0.562 is exactly 562000000000000000n. Digits past the 18th
 * decimal are dropped. Null for anything that is not a non-negative decimal number.
 */
export function ethToWei(v: unknown): bigint | null {
  if (typeof v === "number" && !Number.isFinite(v)) return null
  if (typeof v !== "number" && typeof v !== "string") return null
  const m = NUMBER.exec(String(v).trim())
  if (!m) return null
  const [, whole = "", frac = "", exp = "0"] = m
  const e = Number(exp)
  if (Math.abs(e) > MAX_EXPONENT) return null
  const digits = whole + frac
  const shift = e - frac.length + 18
  if (shift >= 0) return BigInt(digits) * 10n ** BigInt(shift)
  const keep = digits.length + shift
  return keep <= 0 ? 0n : BigInt(digits.slice(0, keep))
}

/** `GET /chain/ink/contract/{address}`: the collection slug and token standard. */
export function parseContract(j: unknown): OsContract | null {
  const o = obj(j)
  if (!o) return null
  return { slug: str(o.collection), standard: str(o.contract_standard) ?? "unknown" }
}

/** `GET /collections/{slug}`, or one entry of a page of collections. Null without a slug. */
export function parseCollection(j: unknown): OsCollection | null {
  const o = obj(j)
  const slug = o ? str(o.collection) : null
  if (!o || !slug) return null
  const rarity = obj(o.rarity)
  return {
    slug,
    name: str(o.name),
    imageUrl: str(o.image_url),
    twitter: str(o.twitter_username),
    website: str(o.project_url),
    discord: str(o.discord_url),
    safelist: str(o.safelist_status),
    createdDate: str(o.created_date),
    totalSupply: num(o.total_supply),
    rarityCalculatedAt: rarity ? str(rarity.calculated_at) : null,
    maxRank: rarity ? num(rarity.max_rank) : null,
    openseaUrl: str(o.opensea_url),
    owner: str(o.owner)?.toLowerCase() ?? null,
  }
}

/** `GET /accounts/{address}`: the account's username and whether OpenSea verified it. */
export function parseAccount(j: unknown): OsAccount | null {
  const o = obj(j)
  if (!o) return null
  return { username: str(o.username), verified: o.is_verified === true }
}

/** `GET /collections/{slug}/stats`. Prices are floats in ETH. */
export function parseStats(j: unknown): OsStats | null {
  const o = obj(j)
  if (!o) return null
  const total = obj(o.total)
  const day = (Array.isArray(o.intervals) ? o.intervals : [])
    .map(obj)
    .find((i) => i?.interval === "one_day")
  return {
    floorWei: ethToWei(total?.floor_price),
    owners: num(total?.num_owners),
    volume24hWei: ethToWei(day?.volume),
    sales24h: num(day?.sales),
    totalSupply: num(o.total_supply),
  }
}

/** Unix seconds from an ISO time that names its zone (Z or an offset), else null. */
function unixSeconds(v: unknown): number | null {
  if (typeof v !== "string" || !/(Z|[+-]\d\d:?\d\d)$/i.test(v)) return null
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

function parseStage(j: unknown): OsDropStage | null {
  const o = obj(j)
  if (!o) return null
  const start = unixSeconds(o.start_time)
  const priceWei = big(o.price)
  if (start === null || priceWei === null) return null
  return {
    type: str(o.stage_type) ?? "unknown",
    label: str(o.label) ?? "",
    priceWei,
    startTime: start,
    endTime: unixSeconds(o.end_time),
    maxPerWallet: num(o.max_per_wallet),
    allowlistCount: num(o.allowlist_wallet_count),
  }
}

/**
 * `GET /drops/{slug}`. Null when any stage cannot be read, because mints name a stage only by its
 * place in the order of starts and a dropped stage would shift the labels.
 */
export function parseDrop(j: unknown): OsDrop | null {
  const o = obj(j)
  if (!o || !Array.isArray(o.stages)) return null
  const stages: OsDropStage[] = []
  for (const s of o.stages) {
    const stage = parseStage(s)
    if (!stage) return null
    stages.push(stage)
  }
  stages.sort((a, b) => a.startTime - b.startTime)
  return {
    slug: str(o.collection_slug),
    contract: str(o.contract_address),
    isMinting: o.is_minting === true,
    totalSupply: big(o.total_supply),
    maxSupply: big(o.max_supply),
    feeBps: num(o.fee_bps),
    stages,
  }
}

/** `GET /chain/ink/contract/{address}/nfts/{id}` (`{ nft }`), or one entry of a page of NFTs. */
export function parseNft(j: unknown): OsNft | null {
  const top = obj(j)
  const o = top ? (obj(top.nft) ?? top) : null
  if (!o) return null
  const traits: OsNft["traits"] = []
  for (const t of Array.isArray(o.traits) ? o.traits : []) {
    const trait = obj(t)
    const type = trait ? str(trait.trait_type) : null
    const value = trait
      ? typeof trait.value === "number"
        ? String(trait.value)
        : str(trait.value)
      : null
    if (type !== null && value !== null) traits.push({ type, value })
  }
  const rarity = obj(o.rarity)
  return {
    rank: rarity ? num(rarity.rank) : null,
    traits,
    name: str(o.name),
    imageUrl: str(o.image_url),
  }
}
