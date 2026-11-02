import { DEAD_ADDRESS, NATIVE_QUOTE_ASSET, UNISWAP_V4_POOL_MANAGER } from "@ink-indexer/sdk"
import { type Address, type Hash, pad, toHex } from "viem"
import { swapLog, transferLog } from "../../../packages/sdk/test/builders"
import type { PoolEntry } from "../src/sources/pools"
import type { FakeChain } from "./fake-chain"
import { launchIdOf, tokenOf } from "./scenario"

export const B = 45_300_000n
export const Q96 = 1n << 96n
export const SUPPLY = 10n ** 27n
export const TOKEN = tokenOf(1)
export const POOL = launchIdOf(1)
export const ROUTER: Address = "0x00000000000000000000000000000000000000f1"
export const BUYER: Address = "0x00000000000000000000000000000000000000b1"
export const DEAD_KEY = `${TOKEN}:${DEAD_ADDRESS}`

export const entry = (n: number): PoolEntry => ({
  poolId: launchIdOf(n),
  poolManager: UNISWAP_V4_POOL_MANAGER,
  token: tokenOf(n),
  launchId: launchIdOf(n),
  launchpad: "inkypump",
  quoteAsset: NATIVE_QUOTE_ASSET,
  // The native quote is the zero address, so the token is always currency1.
  tokenIsCurrency0: false,
  createdBlock: B - 10n,
})

let txCounter = 0
export const nextTx = () => pad(toHex(0xc0ffee000 + ++txCounter), { size: 32 }) as Hash

/** Records `trader` as the sender of `tx` in `block`, with the block's own hash. */
export function sender(chain: FakeChain, block: bigint, tx: Hash, trader: Address) {
  const s = chain.senders.get(block) ?? { hash: chain.hashOf(block), senders: new Map() }
  s.senders.set(tx, trader)
  chain.senders.set(block, s)
}

/**
 * A buy in `poolId` (default the registered pool). With the token as currency1, a √P of 2⁹⁶
 * values the token at one quote unit, so the market cap equals the supply; half that √P is four
 * times the market cap.
 */
export function swap(
  chain: FakeChain,
  a: {
    block: bigint
    sqrtPriceX96?: bigint
    logIndex?: number
    tx?: Hash
    poolId?: Hash
    trader?: Address
    side?: "buy" | "sell"
  },
): Hash {
  const tx = a.tx ?? nextTx()
  const buy = (a.side ?? "buy") === "buy"
  chain.add(
    swapLog(
      {
        poolId: a.poolId ?? POOL,
        sender: ROUTER,
        amount0: buy ? -(10n ** 15n) : 10n ** 15n,
        amount1: buy ? 10n ** 20n : -(10n ** 20n),
        sqrtPriceX96: a.sqrtPriceX96 ?? Q96,
        liquidity: 10n ** 21n,
      },
      { blockNumber: a.block, transactionHash: tx, logIndex: a.logIndex ?? 0 },
    ),
  )
  sender(chain, a.block, tx, a.trader ?? BUYER)
  return tx
}

export function burn(chain: FakeChain, a: { block: bigint; value: bigint; logIndex?: number }) {
  chain.add(
    transferLog(
      { from: BUYER, to: DEAD_ADDRESS, value: a.value },
      {
        address: TOKEN,
        blockNumber: a.block,
        transactionHash: nextTx(),
        logIndex: a.logIndex ?? 0,
      },
    ),
  )
}
