import type { Address, Hex } from "viem"

/** The original factory (a proxy): every Tsunami launch so far comes from it. */
export const TSUNAMI_FACTORY: Address = "0x5934a5c377309453746ee8aa5194f671930c09fa"

/** Block the original factory was deployed in. */
export const TSUNAMI_START_BLOCK = 54_686_019n

/** The second factory, paused since block 55,846,925. Its launches are accepted should it be unpaused. */
export const TSUNAMI_FACTORY_2: Address = "0x1fc16511f5fa4b4c1591ffeb8c38affc367076f1"

export const TSUNAMI_FACTORIES: ReadonlySet<Address> = new Set([TSUNAMI_FACTORY, TSUNAMI_FACTORY_2])

/** Calamari's PoolManager: the Uniswap v4 fork that holds every graduated Tsunami pool. */
export const CALAMARI_POOL_MANAGER: Address = "0x6e4723a612831afb9f5b2a5ae22723c37aab9560"

/** Mints and sells a second supply of each Riptide launch's token for 24 hours, then burns what is left. */
export const RIPTIDE_VAULT: Address = "0x5fef936791026df0d4222bdd0bfa439c9d53e830"

/** The hooks of Tsunami's Calamari pools; `current` is the one the factory deploys new pools with. */
export const TSUNAMI_HOOKS = {
  first: "0x110aac8ee9cd4853fb2c12f4f73937996ecfa8cc",
  second: "0xba7286377d0369f566256770dbe2fc59d13128cc",
  current: "0x5dc5426a33c1d095b9fd0449ac16f6aaebeee8cc",
} as const satisfies Record<string, Address>

/** Base tokens every graduating curve puts into its pool (`CurveMath.MIGRATION_BASE_RESERVES`). */
export const MIGRATION_BASE = 206_900_000n * 10n ** 18n

export const TSUNAMI_TOPICS = {
  launchedLegacy: "0x1caf71a6ee342efb4142a6b3f32423430ddfbebae2cef54b0721d74757672820",
  launched: "0x758fdff804fe3abd2ef0b26c9a61f3c64f9858d1f132f145223ed0f292da854e",
  bought: "0x69c2c4bbea56030830cfa2a660af4e5e5f9922742272cac7cccfa1d78f18d568",
  sold: "0xb2888c28870dcbc5cc52fecadfbeeb35cf0b439bfd459ade61b675289c008be0",
  migrated: "0x404ee33f9ab48b16f4586d25a4d54d61e155a836b3c63d245ee99098327fb694",
  poolMoved: "0x15ea8f2641dbd7916bbafa2b32edd422b1a6424079f4df680f5e48209581f8dd",
  initialize: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
} as const

/** topic0 filter for one eth_getLogs call covering every Tsunami event we read. */
export const TSUNAMI_LOG_TOPICS: Hex[] = Object.values(TSUNAMI_TOPICS)
