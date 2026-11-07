/** The module names Hookit's token page shows. */
export const HOOKIT_MODULE_NAMES = {
  antiSnipe: "Anti-Snipe",
  backedFloor: "Backed Floor",
  dynamicFees: "Dynamic Fees",
  maxTx: "Max Tx",
  antiMev: "Anti-MEV",
  autoBurn: "Auto-Burn",
  deepenLps: "Deepen LPs",
  holderAirdrop: "Holder Airdrop",
  buybackVesting: "Buyback Vesting",
  creatorToHook: "Creator → Hook",
  hookToCreator: "Hook → Creator",
  fixedFees: "Fixed Fees",
} as const

const bit = (n: number) => 1n << BigInt(n)

/** Bit positions in `LaunchConfigured.bitmask`, listed in the order the token page shows them. */
const MODULE_BITS = [
  [0, HOOKIT_MODULE_NAMES.antiSnipe],
  [1, HOOKIT_MODULE_NAMES.backedFloor],
  [5, HOOKIT_MODULE_NAMES.dynamicFees],
  [3, HOOKIT_MODULE_NAMES.maxTx],
  [2, HOOKIT_MODULE_NAMES.antiMev],
  [111, HOOKIT_MODULE_NAMES.autoBurn],
  [112, HOOKIT_MODULE_NAMES.deepenLps],
  [145, HOOKIT_MODULE_NAMES.holderAirdrop],
  // shortcut: no launch has used Buyback Vesting, so its name and place are a guess; check both against a token page when one appears.
  [6, HOOKIT_MODULE_NAMES.buybackVesting],
  [162, HOOKIT_MODULE_NAMES.creatorToHook],
  [4, HOOKIT_MODULE_NAMES.hookToCreator],
] as const

const DYNAMIC_FEES_BIT = 5
const TAX_SHIFT = 7n
const TAX_MASK = 0xffffn

/**
 * The modules a launch's bitmask turns on, in the order the token page shows them. Fixed Fees is
 * a flat `hookTaxBps` (bits 7 to 22) charged when Dynamic Fees is off. Bits that are not modules
 * are ignored, so a bitmask from a newer factory never throws.
 */
export function hookModules(bitmask: bigint): string[] {
  const modules: string[] = MODULE_BITS.filter(([b]) => (bitmask & bit(b)) !== 0n).map(
    ([, name]) => name,
  )
  const tax = (bitmask >> TAX_SHIFT) & TAX_MASK
  const dynamic = (bitmask & bit(DYNAMIC_FEES_BIT)) !== 0n
  if (tax > 0n && !dynamic) modules.push(HOOKIT_MODULE_NAMES.fixedFees)
  return modules
}
