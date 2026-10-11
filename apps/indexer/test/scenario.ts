import type { LaunchState } from "@ink-indexer/sdk"
import { type Address, type Hash, pad, toHex } from "viem"
import {
  launchCreatedLog,
  launchFinalizedLog,
  launchMetadataLog,
  tradeLog,
  xstocksHookCreatedLog,
} from "../../../packages/sdk/test/builders"
import type { FakeChain } from "./fake-chain"

export const HOOK: Address = "0x893183da2411c7df81f103bfef09e4e46c326ac4"
export const CREATOR: Address = "0x00000000000000000000000000000000000000c1"
export const TRADER: Address = "0x00000000000000000000000000000000000000e1"
/** Flat curve: curveValue(sold) = 1e18 × sold / 8e26. */
export const PARAMS = { targetRaise: 10n ** 18n, saleSupply: 8n * 10n ** 26n, gainBps: 0 }

export const launchIdOf = (n: number) => pad(toHex(n), { size: 32 }) as Hash
export const tokenOf = (n: number) => pad(toHex(n), { size: 20 }) as Address

let txCounter = 0
const nextTx = () => pad(toHex(0xf00000 + ++txCounter), { size: 32 }) as Hash

export function stateFor(token: Address, sold: bigint): LaunchState {
  return {
    token,
    sold,
    raised: 0n,
    netContributions: 0n,
    targetRaise: PARAMS.targetRaise,
    saleSupply: PARAMS.saleSupply,
    gainBps: PARAMS.gainBps,
    finalized: sold === PARAMS.saleSupply,
  }
}

/** LaunchCreated (logIndex 0) and LaunchMetadata (logIndex 1) in one tx. */
export function launch(chain: FakeChain, a: { n: number; block: bigint; hook?: Address }) {
  const hook = a.hook ?? HOOK
  const transactionHash = nextTx()
  const launchId = BigInt(launchIdOf(a.n))
  chain.add(
    launchCreatedLog(
      { launchId, creator: CREATOR, token: tokenOf(a.n), targetRaise: PARAMS.targetRaise },
      { address: hook, blockNumber: a.block, transactionHash, logIndex: 0 },
    ),
  )
  chain.add(
    launchMetadataLog(
      { launchId, name: `Token ${a.n}`, ticker: `T${a.n}` },
      { address: hook, blockNumber: a.block, transactionHash, logIndex: 1 },
    ),
  )
  chain.states.set(`${hook}:${launchIdOf(a.n)}`, stateFor(tokenOf(a.n), 0n))
}

/** A trade with price 1000 and token and quote amounts of 1. */
export function trade(
  chain: FakeChain,
  a: {
    n: number
    block: bigint
    sold: bigint
    side?: "buy" | "sell"
    logIndex?: number
    hook?: Address
  },
) {
  chain.add(
    tradeLog(
      {
        launchId: BigInt(launchIdOf(a.n)),
        trader: TRADER,
        side: a.side ?? "buy",
        price: 1000n,
        sold: a.sold,
        timestamp: Number(a.block),
        tokenAmount: 1n,
        quoteAmount: 1n,
      },
      {
        address: a.hook ?? HOOK,
        blockNumber: a.block,
        transactionHash: nextTx(),
        logIndex: a.logIndex ?? 0,
      },
    ),
  )
}

/** LaunchFinalized; sets the launch's state to `sold` (default: the full curve). */
export function bond(
  chain: FakeChain,
  a: { n: number; block: bigint; sold?: bigint; logIndex?: number },
) {
  chain.states.set(
    `${HOOK}:${launchIdOf(a.n)}`,
    stateFor(tokenOf(a.n), a.sold ?? PARAMS.saleSupply),
  )
  chain.add(
    launchFinalizedLog(
      {
        launchId: BigInt(launchIdOf(a.n)),
        poolId: launchIdOf(a.n),
        liquidityQuote: 1n,
        liquidityTokens: 1n,
      },
      { address: HOOK, blockNumber: a.block, transactionHash: nextTx(), logIndex: a.logIndex ?? 0 },
    ),
  )
}

export function xstocksHook(
  chain: FakeChain,
  a: { block: bigint; hook: Address; wrapper: Address; factory?: Address; logIndex?: number },
) {
  chain.add(
    xstocksHookCreatedLog(
      { assetId: pad("0x07bc", { size: 32 }) as Hash, wrapper: a.wrapper, hook: a.hook },
      {
        address: a.factory ?? "0x92f303ae539052ebb7d551bb2ec1a6f1affbaf85",
        blockNumber: a.block,
        transactionHash: nextTx(),
        logIndex: a.logIndex ?? 0,
      },
    ),
  )
}
