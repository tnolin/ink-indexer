import type { Address, Hex } from "viem"

/** `TokenFactory`: creates every ink.fun launch. */
export const INKFUN_FACTORY: Address = "0x329ae95b937415b7ee805ff2c4e358137daccd37"

/** Block the factory was deployed in. */
export const INKFUN_START_BLOCK = 57_612_017n

/** `LaunchHook`: the hook of every ink.fun pool in the Uniswap v4 PoolManager. */
export const INKFUN_HOOK: Address = "0x735458d31dcf29dc204109430b1f7f96738568cc"

/** `V4MigrationModule`: emits `Migrated` when a curve graduates into a pool. */
export const INKFUN_MIGRATION: Address = "0xc202bb7fb1e9c7e67305e09ad2313756e0b5034d"

/** `BondingCurve`: every launch's curve is an EIP-1167 clone of this contract. */
export const INKFUN_CURVE_IMPL: Address = "0x9fb96d0959b4b86198efbfbf8039698b4105bc04"

export const INKFUN_TOPICS = {
  launchCreated: "0x0b6f3e5d73693a196bb5efee504ff46042d1036f826b445548a5e56225faec1f",
  bought: "0x8a5254432535d4192429d2cc163283a57784eac274295fcda17cc659c1ee414c",
  sold: "0x490fdc1c23c0f3a84bf80a0384eaadcb9188c9ef71b9430da391a0e4c4c39bf6",
  migrated: "0x17c26e6c14f99c7cbc9757fb63c4189e5c1932239e7396cee757f68524788638",
} as const

/** topic0 filter for one eth_getLogs call covering every ink.fun event we index. */
export const INKFUN_LOG_TOPICS: Hex[] = Object.values(INKFUN_TOPICS)
