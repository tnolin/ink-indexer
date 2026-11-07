import {
  type ChainLog,
  decodeHookitLog,
  decodeTsunamiLog,
  hookitLaunchId,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import {
  type HookitFixture,
  type HookitFixtureName,
  loadHookitFixture,
} from "../../../packages/sdk/test/fixtures"
import type { PoolEntry } from "../src/sources/pools"
import type { FakeChain } from "./fake-chain"

/** The pools a recorded Master launch creates, as the registry holds them: one entry per `Initialize`. */
export function poolsOfLaunch(name: HookitFixtureName): PoolEntry[] {
  const f = loadHookitFixture(name)
  const decoded = f.logs.map((l) => decodeHookitLog(l))
  const master = decoded.find((d) => d?.kind === "masterLaunched")
  if (master?.kind !== "masterLaunched") throw new Error(`${name} has no Master launch`)
  const ticks = new Map<Hash, { tickLower: number; tickUpper: number }>()
  ticks.set(master.poolId, { tickLower: master.tickLower, tickUpper: master.tickUpper })
  for (const d of decoded)
    if (d?.kind === "market")
      ticks.set(d.poolId, { tickLower: d.tickLower, tickUpper: d.tickUpper })
  const pools: PoolEntry[] = []
  for (const l of f.logs) {
    const init = decodeTsunamiLog(l)
    if (init?.kind !== "initialize") continue
    const tokenIsCurrency0 = init.currency0 === master.token
    pools.push({
      poolId: init.poolId,
      poolManager: UNISWAP_V4_POOL_MANAGER,
      token: master.token,
      launchId: hookitLaunchId(master.token),
      launchpad: "hookit",
      quoteAsset: tokenIsCurrency0 ? init.currency1 : init.currency0,
      tokenIsCurrency0,
      createdBlock: f.blockNumber,
      hook: master.hooks,
      ...ticks.get(init.poolId)!,
    })
  }
  return pools
}

/** Adds a recorded transaction's logs and its sender to the chain, as the tx's block. */
export function addFixture(chain: FakeChain, f: HookitFixture, only?: (l: ChainLog) => boolean) {
  for (const l of f.logs) if (!only || only(l)) chain.add({ ...l })
  const known = chain.senders.get(f.blockNumber)
  chain.senders.set(f.blockNumber, {
    hash: chain.hashOf(f.blockNumber),
    senders: known?.senders ?? new Map(),
  })
  chain.senders.get(f.blockNumber)!.senders.set(f.txHash, f.sender as Address)
}
