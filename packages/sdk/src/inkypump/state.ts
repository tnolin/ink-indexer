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

/**
 * `symbol()` and `name()` of each token at a block, in one multicall. A call that reverts, or a
 * token that answers with something else than a string, gives null for that field; a transport
 * failure throws.
 */
export async function readErc20Names(
  client: StateReader,
  tokens: Address[],
  blockNumber: bigint,
): Promise<{ symbol: string | null; name: string | null }[]> {
  if (tokens.length === 0) return []
  const results = await client.multicall({
    allowFailure: true,
    blockNumber,
    contracts: tokens.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: "symbol" } as const,
      { address: t, abi: erc20Abi, functionName: "name" } as const,
    ]),
  })
  const text = (r: { status: string; result?: unknown } | undefined) =>
    r?.status === "success" && typeof r.result === "string" && r.result !== "" ? r.result : null
  return tokens.map((_, i) => ({ symbol: text(results[2 * i]), name: text(results[2 * i + 1]) }))
}
