import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Address, Hash } from "viem"
import type { ChainLog, ClassicLaunch, LaunchState, TsunamiCurveState } from "../src/index"

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
function readFixtureJson<T>(name: string): T {
  const raw = readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8")
  return JSON.parse(raw, (_k, v) =>
    typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  )
}

export function loadFixture(name: FixtureName): Fixture {
  return readFixtureJson(name)
}

/** Transactions recorded with `capture-fixture.ts --topics v4`. */
export const V4_FIXTURES = ["v4-inkypump-buy", "v4-inkypump-sell", "v4-inkypump-bond"] as const
export type V4FixtureName = (typeof V4_FIXTURES)[number]

export type V4Fixture = {
  name: V4FixtureName
  txHash: Hash
  blockNumber: bigint
  blockHash: Hash
  timestamp: number
  logs: ChainLog[]
  /** Transaction hash to the transaction's sender. */
  senders: Record<string, Address>
  /** StateView reads at the block for each pool a LaunchFinalized log names. */
  pools: { poolId: Hash; sqrtPriceX96: bigint; liquidity: bigint }[]
}

export function loadV4Fixture(name: V4FixtureName): V4Fixture {
  return readFixtureJson(name)
}

/** Transactions recorded with `capture-fixture.ts --topics inkfun`. */
export const INKFUN_FIXTURES = [
  "inkfun-launch",
  "inkfun-launch-seed-buy",
  "inkfun-buy",
  "inkfun-sell",
] as const
export type InkfunFixtureName = (typeof INKFUN_FIXTURES)[number]

export type InkfunFixture = {
  name: InkfunFixtureName
  txHash: Hash
  blockNumber: bigint
  blockHash: Hash
  timestamp: number
  logs: ChainLog[]
  /** Every curve the transaction touches, read at the transaction's block. */
  curves: {
    curve: Address
    token: Address
    params: {
      virtualQuote: bigint
      virtualTokens: bigint
      curveSupply: bigint
      graduationTarget: bigint
    }
    lpSupply: bigint
    totalSupply: bigint
    metadataURI: string | null
    sold: bigint
    /** The curve's `realQuote()`: net quote raised. */
    realQuote: bigint
  }[]
}

export function loadInkfunFixture(name: InkfunFixtureName): InkfunFixture {
  return readFixtureJson(name)
}

export const NFT_FIXTURES = [
  "hornet-mints",
  "inkverse-mints",
  "burst-mints",
  "wired-transfers",
  "prtscn-mints",
  "seaport-fills",
  "erc1155-mints",
  "seaport-matched",
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

/** Transactions recorded with `capture-fixture.ts --topics tsunami`. */
export const TSUNAMI_FIXTURES = [
  "tsunami-launch-riptide",
  "tsunami-launch-gm",
  "tsunami-graduation-gm",
  "tsunami-legacy-smoke",
  "tsunami-sell",
  "tsunami-usdc-buy",
  "tsunami-kbtc-buy",
  "tsunami-usdc-graduation",
  "tsunami-wnvdax-graduation",
  "tsunami-graduation-moved",
  "tsunami-pool-move",
  "tsunami-launch-usdc",
  "tsunami-launch-usdc-buyer",
  "tsunami-launch-pool-moved",
] as const
export type TsunamiFixtureName = (typeof TSUNAMI_FIXTURES)[number]

export type TsunamiFixture = {
  name: TsunamiFixtureName
  txHash: Hash
  blockNumber: bigint
  blockHash: Hash
  timestamp: number
  logs: ChainLog[]
  /** The transaction's `from`. */
  sender: Address
  /** The chain head when the fixture was recorded. */
  headBlock: bigint
  /** Every curve the transaction touches. */
  curves: {
    curve: Address
    token: Address
    /** `curve()` at the transaction's block. */
    state: TsunamiCurveState
    /** `totalSupply()` and the Riptide vault's balance at the transaction's block. */
    totalSupply: bigint
    vaultBalance: bigint
    /** `curve()` and `totalSupply()` at `headBlock`. */
    stateAtHead: TsunamiCurveState
    totalSupplyAtHead: bigint
  }[]
}

export function loadTsunamiFixture(name: TsunamiFixtureName): TsunamiFixture {
  return readFixtureJson(name)
}

/** Calamari swaps recorded with `capture-fixture.ts --topics v4`. */
export const CALAMARI_FIXTURES = [
  "calamari-swap-usdc",
  "calamari-swap-gm",
  "calamari-swap-gm-first",
  "calamari-swap-moved",
  "calamari-swap-wnvdax",
] as const
export type CalamariFixtureName = (typeof CALAMARI_FIXTURES)[number]

export type CalamariFixture = Omit<V4Fixture, "name"> & {
  name: CalamariFixtureName
  /** The pool's price before the transaction: its previous Swap, or the PoolSeeded of its graduation, or the Initialize of a pool created by a move. */
  before: {
    source: "Swap" | "PoolSeeded" | "Initialize"
    block: number
    tx: Hash
    sqrtPriceX96: bigint
  }
}

export function loadCalamariFixture(name: CalamariFixtureName): CalamariFixture {
  return readFixtureJson(name)
}

/** Transactions recorded with `capture-fixture.ts --topics hookit`. */
export const HOOKIT_FIXTURES = [
  "hookit-hkt-launch",
  "hookit-hkt-first-swap",
  "hookit-hkt-sell",
  "hookit-hkt-buyback",
  "hookit-hmu-launch",
  "hookit-hmu-split",
  "hookit-inky-launch",
  "hookit-inky-usdg-wmstrx",
  "hookit-stock-pool-swap",
  "hookit-a18-launch",
  "hookit-kbtc-launch",
  "hookit-quill-launch",
  "hookit-bloop-launch",
  "hookit-qcard-launch",
  "hookit-dead-transfer",
  "hookit-hooc-launch",
  "hookit-drop-sold",
  "hookit-classic-wnvdax",
  "hookit-classic-latest",
  "hookit-tsunami-launch",
] as const
export type HookitFixtureName = (typeof HOOKIT_FIXTURES)[number]

export type HookitFixture = {
  name: HookitFixtureName
  txHash: Hash
  blockNumber: bigint
  blockHash: Hash
  timestamp: number
  logs: ChainLog[]
  /** The transaction's `from`. */
  sender: Address
  /** Every Hookit token the transaction touches, read at its block. */
  tokens: {
    token: Address
    metadataURI: string
    totalSupply: bigint
    /** `totalSupply()` one block earlier; null when the token did not exist yet. */
    totalSupplyBefore: bigint | null
  }[]
  /** `launches(id)` of every bonding launch the transaction touches, at its block and the block before. */
  classic: { id: bigint; at: ClassicLaunch; before: ClassicLaunch | null }[]
}

export function loadHookitFixture(name: HookitFixtureName): HookitFixture {
  return readFixtureJson(name)
}

/** Every bonding event of one launch from its creation to its latest event, with `launches(id)` at the last one. */
export type HookitHistory = {
  name: string
  launchId: bigint
  blockNumber: bigint
  logs: ChainLog[]
  state: ClassicLaunch
}

export function loadHookitHistory(): HookitHistory {
  return readFixtureJson("hookit-hooc-history")
}

/** StateView reads of the $HKT and QUILL pools at one block. */
export type HookitPoolState = {
  blockNumber: bigint
  pools: { poolId: Hash; sqrtPriceX96: bigint; tick: number; liquidity: bigint }[]
}

export function loadHookitPoolState(): HookitPoolState {
  return readFixtureJson("hookit-pool-state")
}
