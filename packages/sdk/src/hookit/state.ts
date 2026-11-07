import type { Address, Hash } from "viem"
import type { StateReader } from "../inkypump/state"
import { hookitBondingAbi, hookitTokenAbi } from "./abi"
import { HOOKIT_BONDING_FACTORY } from "./constants"

/** The fields of the bonding factory's `launches(id)` the indexer uses. */
export type ClassicLaunch = {
  token: Address
  creator: Address
  quote: Address
  totalSupply: bigint
  curveSupply: bigint
  tokensSold: bigint
  realQuote: bigint
  virtualQuote: bigint
  virtualToken: bigint
  graduationQuote: bigint
  poolId: Hash
}

/** `launches(id)` of each bonding launch at one block, in one multicall. */
export async function readClassicLaunches(
  client: StateReader,
  ids: bigint[],
  blockNumber: bigint,
): Promise<ClassicLaunch[]> {
  if (ids.length === 0) return []
  const results = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: ids.map(
      (id) =>
        ({
          address: HOOKIT_BONDING_FACTORY,
          abi: hookitBondingAbi,
          functionName: "launches",
          args: [id],
        }) as const,
    ),
  })
  return results.map((r) => ({
    token: r[0].toLowerCase() as Address,
    creator: r[1].toLowerCase() as Address,
    quote: r[2].toLowerCase() as Address,
    totalSupply: r[5],
    curveSupply: r[6],
    tokensSold: r[7],
    realQuote: r[8],
    virtualQuote: r[9],
    virtualToken: r[10],
    graduationQuote: r[11],
    poolId: r[12].toLowerCase() as Hash,
  }))
}

/** `metadataURI()` of each token at one block. Null for a token whose call reverts. */
export async function readMetadataUris(
  client: StateReader,
  tokens: Address[],
  blockNumber: bigint,
): Promise<(string | null)[]> {
  if (tokens.length === 0) return []
  const results = await client.multicall({
    allowFailure: true,
    blockNumber,
    contracts: tokens.map(
      (t) => ({ address: t, abi: hookitTokenAbi, functionName: "metadataURI" }) as const,
    ),
  })
  return results.map((r) => (r.status === "success" ? r.result : null))
}
