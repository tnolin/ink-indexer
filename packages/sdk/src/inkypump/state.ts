import { type Address, erc20Abi, type Hash, type PublicClient } from "viem"
import { launchStateAbi } from "./abi"

export type LaunchKey = { hook: Address; launchId: Hash }
export type LaunchState = {
  token: Address
  sold: bigint
  raised: bigint
  netContributions: bigint
  targetRaise: bigint
  saleSupply: bigint
  gainBps: number
  finalized: boolean
}
export type StateReader = Pick<PublicClient, "multicall">

/** getLaunchState for each key at one block, in one multicall. */
export async function readLaunchStates(
  client: StateReader,
  keys: LaunchKey[],
  blockNumber: bigint,
): Promise<LaunchState[]> {
  if (keys.length === 0) return []
  const results = (await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: keys.map(
      (k) =>
        ({
          address: k.hook,
          abi: launchStateAbi,
          functionName: "getLaunchState",
          args: [BigInt(k.launchId)],
        }) as const,
    ),
  })) as unknown as LaunchState[]
  return results.map((r) => ({
    token: r.token.toLowerCase() as Address,
    sold: r.sold,
    raised: r.raised,
    netContributions: r.netContributions,
    targetRaise: r.targetRaise,
    saleSupply: r.saleSupply,
    gainBps: r.gainBps,
    finalized: r.finalized,
  }))
}

export async function readTotalSupplies(
  client: StateReader,
  tokens: Address[],
  blockNumber: bigint,
): Promise<bigint[]> {
  if (tokens.length === 0) return []
  return (await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: tokens.map(
      (t) => ({ address: t, abi: erc20Abi, functionName: "totalSupply" }) as const,
    ),
  })) as bigint[]
}

export async function readErc20Meta(
  client: StateReader,
  token: Address,
): Promise<{ decimals: number; symbol: string }> {
  const [decimals, symbol] = (await client.multicall({
    allowFailure: false,
    contracts: [
      { address: token, abi: erc20Abi, functionName: "decimals" },
      { address: token, abi: erc20Abi, functionName: "symbol" },
    ],
  })) as [number, string]
  return { decimals, symbol }
}
