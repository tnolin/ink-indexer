import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Address, Hash } from "viem"
import type { ChainLog, LaunchState } from "../src/index"

export const FIXTURES = [
  "legacy-launch",
  "legacy-sell",
  "legacy-bond",
  "legacy-capped-sell",
  "current-launch",
  "current-buy",
  "current-sell",
  "xstocks-launch-buy",
  "xstocks-sell",
  "xstocks-hook-created",
] as const
export type FixtureName = (typeof FIXTURES)[number]

export type Fixture = {
  name: FixtureName
  txHash: Hash
  blockNumber: bigint
  blockHash: Hash
  timestamp: number
  logs: ChainLog[]
  states: { hook: Address; launchId: Hash; at: LaunchState; prev: LaunchState | null }[]
  totalSupplies: Record<string, bigint>
}

/** Fixtures store bigints as "123n" strings. */
export function loadFixture(name: FixtureName): Fixture {
  const raw = readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8")
  return JSON.parse(raw, (_k, v) =>
    typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  )
}

export const NFT_FIXTURES = [
  "hornet-mints",
  "inkverse-mints",
  "burst-mints",
  "wired-transfers",
  "prtscn-mints",
  "seaport-fills",
  "erc1155-mints",
] as const
export type NftFixtureName = (typeof NFT_FIXTURES)[number]

type SavedLog = Omit<ChainLog, "blockNumber"> & { blockNumber: string }

function readNftJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "nft", file), "utf8"))
}

/** NFT chain logs recorded by scripts/record-nft-fixtures.ts, in block order. Block numbers are decimal strings in the files. */
export function loadNftFixture(name: NftFixtureName): ChainLog[] {
  return readNftJson<SavedLog[]>(`${name}.json`).map((l) => ({
    ...l,
    blockNumber: BigInt(l.blockNumber),
  }))
}

/** The recipient sets of the ten largest recent mint bursts, keyed by collection, and the wallets in five or more of them under `farmWallets`. */
export function loadFarmWallets(): Record<string, Address[]> {
  return readNftJson("farm-wallets.json")
}

/** Which transaction in seaport-fills is which kind of fill. A role with no transaction in the recording window is null. */
export type SeaportRoles = {
  sweep: Hash
  listing: Hash
  offer: Hash
  multi: Hash | null
  /** True when `multi` is one order carrying several NFTs, false when it is a transaction that fills several orders. */
  multiIsSingleOrder: boolean
  unsupportedErc20: Hash | null
}
export function loadSeaportRoles(): SeaportRoles {
  return readNftJson("seaport-roles.json")
}

/** Every Chimera factory CampaignCreated log since its deployment, and one other factory log. */
export function loadChimeraCampaigns(): ChainLog[] {
  return readNftJson<SavedLog[]>("chimera-campaigns.json").map((l) => ({
    ...l,
    blockNumber: BigInt(l.blockNumber),
  }))
}
