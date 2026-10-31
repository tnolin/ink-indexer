import type { Address } from "viem"
import type { StateReader } from "../inkypump/state"
import { inkfunCurveAbi, inkfunTokenAbi } from "./abi"
import type { InkfunCurve } from "./curve"

export type InkfunLaunchState = {
  curve: InkfunCurve
  lpSupply: bigint
  totalSupply: bigint
  /** Null when the token's `metadataURI()` reverts. */
  metadataURI: string | null
}

const READS_PER_LAUNCH = 7

/**
 * The curve's parameters and the token's supply and metadata URI for each launch at one block, in
 * one multicall. A reverting `metadataURI()` gives null; any other failed read throws.
 */
export async function readInkfunLaunches(
  client: StateReader,
  launches: { token: Address; curve: Address }[],
  blockNumber: bigint,
): Promise<InkfunLaunchState[]> {
  if (launches.length === 0) return []
  const results = await client.multicall({
    allowFailure: true,
    blockNumber,
    contracts: launches.flatMap((l) => [
      { address: l.curve, abi: inkfunCurveAbi, functionName: "virtualQuote" } as const,
      { address: l.curve, abi: inkfunCurveAbi, functionName: "virtualTokens" } as const,
      { address: l.curve, abi: inkfunCurveAbi, functionName: "curveSupply" } as const,
      { address: l.curve, abi: inkfunCurveAbi, functionName: "lpSupply" } as const,
      { address: l.curve, abi: inkfunCurveAbi, functionName: "graduationTarget" } as const,
      { address: l.token, abi: inkfunTokenAbi, functionName: "totalSupply" } as const,
      { address: l.token, abi: inkfunTokenAbi, functionName: "metadataURI" } as const,
    ]),
  })
  const big = (i: number): bigint => {
    const r = results[i]
    if (r?.status !== "success" || typeof r.result !== "bigint")
      throw new Error("ink.fun curve read failed")
    return r.result
  }
  return launches.map((_, n) => {
    const at = n * READS_PER_LAUNCH
    const uri = results[at + 6]
    return {
      curve: {
        virtualQuote: big(at),
        virtualTokens: big(at + 1),
        curveSupply: big(at + 2),
        graduationTarget: big(at + 4),
      },
      lpSupply: big(at + 3),
      totalSupply: big(at + 5),
      metadataURI: uri?.status === "success" && typeof uri.result === "string" ? uri.result : null,
    }
  })
}

/** `tokensSold()` of each curve at one block, in one multicall. */
export async function readCurveSold(
  client: StateReader,
  curves: Address[],
  blockNumber: bigint,
): Promise<bigint[]> {
  if (curves.length === 0) return []
  return (await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: curves.map(
      (c) => ({ address: c, abi: inkfunCurveAbi, functionName: "tokensSold" }) as const,
    ),
  })) as bigint[]
}
