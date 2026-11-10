import type { PublicClient } from "viem"
import { type Address, decodeAbiParameters, encodeFunctionData, type Hex, parseAbi } from "viem"
import { NFT_SELECTORS } from "./constants"

export type NftReader = Pick<PublicClient, "call">
export type CodeReader = Pick<PublicClient, "getCode">

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

/** The error code geth-style nodes give for a call that fails while executing: an invalid opcode, out of gas, a stack underflow, an aborted execution. */
const EXECUTION_FAILED_CODE = -32000
/** -32000 is also what a node answers when it does not have the block yet or no longer has its state; those pass, so the read is retried. */
const NODE_LAG =
  /header not found|missing trie node|unknown block|block .*not found|pruned|state .*not available|syncing/i

/**
 * True when the node answered the call with the execution-failure error of a contract that cannot
 * run from the zero address, as one that hits an invalid opcode does. Retrying gives the same answer.
 * Other JSON-RPC errors (rate limits, internal errors, a node without the block) and connection
 * failures are not included.
 */
function isExecutionFailure(err: unknown): boolean {
  let failed = false
  for (let e = err as { cause?: unknown } | undefined, depth = 0; e && depth < 8; depth++) {
    const { code, message, details } = e as { code?: number; message?: string; details?: string }
    if (NODE_LAG.test(`${message ?? ""} ${details ?? ""}`)) return false
    if (code === EXECUTION_FAILED_CODE) failed = true
    e = e.cause as typeof e
  }
  return failed
}

/** The return data of an eth_call at a block, or null when it reverted, the node reported an execution failure, or it returned nothing. */
async function callAt(
  client: NftReader,
  to: Address,
  data: Hex,
  blockNumber: bigint | undefined,
): Promise<Hex | null> {
  try {
    const { data: out } = await client.call({ to, data, blockNumber })
    return out && out !== "0x" ? out : null
  } catch (err) {
    if (isRevert(err) || isExecutionFailure(err)) return null
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

/** `totalSupply()` at a block. Null when the contract reverts or has no such function. */
export async function readNftTotalSupply(
  client: NftReader,
  contract: Address,
  block: bigint,
): Promise<bigint | null> {
  const out = await callAt(client, contract, NFT_SELECTORS.totalSupply, block)
  return out && (out.length - 2) / 2 >= WORD ? BigInt(out.slice(0, 2 + 2 * WORD)) : null
}

/** Whether the address had contract code at a block. A transport failure throws. */
export async function hasCodeAt(
  client: CodeReader,
  address: Address,
  block: bigint,
): Promise<boolean> {
  const code = await client.getCode({ address, blockNumber: block })
  return code !== undefined && code !== "0x"
}
