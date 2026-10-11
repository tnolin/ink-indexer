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
