import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  type Hash,
  type Hex,
  hexToBytes,
  keccak256,
} from "viem"
import { nftxPoolKeyParameters } from "./abi"

const Q96 = 1n << 96n
const Q192 = Q96 * Q96
const ONE = 10n ** 18n
const POOL_KEY_BYTES = 160

export type NftxPoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
  poolId: Hash
}

/**
 * The pool key in `CollectionInitialized._poolKey`: five static words. Null for any other length.
 * The pool id is the keccak of the key bytes, as Uniswap v4 derives it.
 */
export function poolKeyOf(bytes: Hex): NftxPoolKey | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(bytes) || hexToBytes(bytes).length !== POOL_KEY_BYTES)
    return null
  let decoded: readonly [Address, Address, number, number, Address]
  try {
    decoded = decodeAbiParameters(nftxPoolKeyParameters, bytes) as typeof decoded
  } catch {
    return null
  }
  const [currency0, currency1, fee, tickSpacing, hooks] = decoded
  return {
    currency0: currency0.toLowerCase() as Address,
    currency1: currency1.toLowerCase() as Address,
    fee,
    tickSpacing,
    hooks: hooks.toLowerCase() as Address,
    poolId: keccak256(bytes),
  }
}

/**
 * Wei one NFT costs at the pool's spot price: `10^18 × 2^192 / sqrtPriceX96²` when flETH is
 * currency0, its inverse otherwise, rounded down. Null for an uninitialized pool (sqrt of 0) and
 * for a price that rounds to zero wei.
 */
export function nftxSpotWei(sqrtPriceX96: bigint, flethIsCurrency0: boolean): bigint | null {
  if (sqrtPriceX96 <= 0n) return null
  const p2 = sqrtPriceX96 * sqrtPriceX96
  const wei = flethIsCurrency0 ? (ONE * Q192) / p2 : (ONE * p2) / Q192
  return wei === 0n ? null : wei
}

/** Wei per NFT of an auction price: Q96 currency per token unit, times 1e18 token units per NFT. */
export function auctionPriceWei(priceQ96: bigint): bigint {
  return (priceQ96 * ONE) / Q96
}

/** A 32-byte id for an NFTX sale or listing, which has no order hash of its own. */
export function nftxOrderHash(txHash: Hash, logIndex: number, tokenId: bigint): Hash {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [txHash, BigInt(logIndex), tokenId],
    ),
  )
}

/**
 * Splits `total` across items in proportion to `weights`. Each part is rounded down and the last
 * takes the remainder, so the parts add up to `total`. Zero weights split evenly.
 */
export function splitTotal(total: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) return []
  const sum = weights.reduce((a, b) => a + b, 0n)
  const w = sum === 0n ? weights.map(() => 1n) : weights
  const denom = sum === 0n ? BigInt(weights.length) : sum
  const parts: bigint[] = []
  let given = 0n
  for (let i = 0; i < w.length - 1; i++) {
    const part = (total * (w[i] as bigint)) / denom
    parts.push(part)
    given += part
  }
  parts.push(total - given)
  return parts
}
