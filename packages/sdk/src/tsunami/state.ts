import type { Address } from "viem"
import type { StateReader } from "../inkypump/state"
import { tsunamiCurveAbi } from "./abi"
import type { TsunamiCurveState } from "./decode"

/** `curve()` of each curve at one block, in one multicall. */
export async function readTsunamiCurves(
  client: StateReader,
  curves: Address[],
  blockNumber: bigint,
): Promise<TsunamiCurveState[]> {
  if (curves.length === 0) return []
  const results = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: curves.map(
      (c) => ({ address: c, abi: tsunamiCurveAbi, functionName: "curve" }) as const,
    ),
  })
  return results.map(([realBase, realQuote, virtualBase, virtualQuote]) => ({
    realBase,
    realQuote,
    virtualBase,
    virtualQuote,
  }))
}
