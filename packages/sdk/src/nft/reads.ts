import type { PublicClient } from "viem"
import { type Address, decodeAbiParameters, encodeFunctionData, type Hex, parseAbi } from "viem"
import { NFT_SELECTORS } from "./constants"

export type NftReader = Pick<PublicClient, "call">

const mintStatsAbi = parseAbi([
  "function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
])
const WORD = 32

/** True for a call the node answered with a revert, false for a failure to reach it. */
function isRevert(err: unknown): boolean {
  for (let e = err as { cause?: unknown; name?: string; code?: number } | undefined; e; ) {
    if (e.name === "ExecutionRevertedError" || e.name === "ContractFunctionRevertedError")
      return true
    if (e.code === 3) return true
    e = e.cause as typeof e
  }
  return false
}

/** The return data of an eth_call at a block, or null when it reverted or returned nothing. */
async function callAt(
  client: NftReader,
  to: Address,
  data: Hex,
  blockNumber: bigint,
): Promise<Hex | null> {
  try {
    const { data: out } = await client.call({ to, data, blockNumber })
    return out && out !== "0x" ? out : null
  } catch (err) {
    if (isRevert(err)) return null
    throw err
  }
}

/**
 * SeaDrop-style `getMintStats(minter)` at a block: the collection's total supply and max supply.
 * Null when the contract reverts or has no such function. A transport failure throws.
 */
export async function readMintStats(
  client: NftReader,
  contract: Address,
  minter: Address,
  block: bigint,
): Promise<{ totalSupply: bigint; maxSupply: bigint } | null> {
  const data = encodeFunctionData({
    abi: mintStatsAbi,
    functionName: "getMintStats",
    args: [minter],
  })
  const out = await callAt(client, contract, data, block)
  if (!out || (out.length - 2) / 2 < 3 * WORD) return null
  const [, totalSupply, maxSupply] = decodeAbiParameters(mintStatsAbi[0].outputs, out) as readonly [
    bigint,
    bigint,
    bigint,
  ]
  return { totalSupply, maxSupply }
}

/** `maxSupply()`, then `MAX_SUPPLY()`, at a block. Null when the contract exposes neither. */
export async function readMaxSupply(
  client: NftReader,
  contract: Address,
  block: bigint,
): Promise<bigint | null> {
  for (const selector of [NFT_SELECTORS.maxSupply, NFT_SELECTORS.MAX_SUPPLY]) {
    const out = await callAt(client, contract, selector, block)
    if (out && (out.length - 2) / 2 >= WORD) return BigInt(out.slice(0, 2 + 2 * WORD))
  }
  return null
}
