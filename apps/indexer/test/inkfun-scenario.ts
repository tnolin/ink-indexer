import {
  INKFUN_FACTORY,
  type InkfunCurve,
  inkfunLaunchId,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import { type Address, type Hash, pad, toHex } from "viem"
import {
  inkfunBoughtLog,
  inkfunLaunchCreatedLog,
  inkfunMigratedLog,
  inkfunSoldLog,
} from "../../../packages/sdk/test/builders"
import type { FakeChain } from "./fake-chain"

export { INKFUN_FACTORY, UNISWAP_V4_POOL_MANAGER }

/** The parameters every live ink.fun curve has. */
export const CURVE_PARAMS: InkfunCurve = {
  virtualQuote: 1_400_000_000_000_000_000n,
  virtualTokens: 1_066_666_666_666_666_666_666_666_666n,
  curveSupply: 800_000_000n * 10n ** 18n,
  graduationTarget: 4_200_000_000_000_000_000n,
}
export const TOTAL_SUPPLY = 10n ** 27n
export const CREATOR: Address = "0x00000000000000000000000000000000000000c1"
export const BUYER: Address = "0x00000000000000000000000000000000000000e1"

export const tokenOf = (n: number) => pad(toHex(0x1000 + n), { size: 20 }) as Address
export const curveOf = (n: number) => pad(toHex(0x2000 + n), { size: 20 }) as Address
export const launchIdOf = (n: number) => inkfunLaunchId(curveOf(n))
export const poolIdOf = (n: number) => pad(toHex(0x3000 + n), { size: 32 }) as Hash

let txCounter = 0
export const nextTx = () => pad(toHex(0xe00000 + ++txCounter), { size: 32 }) as Hash

/** A LaunchCreated and the chain reads that answer for the launch. */
export function inkfunLaunch(
  chain: FakeChain,
  a: {
    n: number
    block: bigint
    uri?: string | null
    transactionHash?: Hash
    logIndex?: number
    creator?: Address
    factory?: Address
  },
) {
  chain.add(
    inkfunLaunchCreatedLog(
      {
        token: tokenOf(a.n),
        curve: curveOf(a.n),
        creator: a.creator ?? CREATOR,
        name: `Token ${a.n}`,
        symbol: `T${a.n}`,
      },
      {
        address: a.factory ?? INKFUN_FACTORY,
        blockNumber: a.block,
        transactionHash: a.transactionHash ?? nextTx(),
        logIndex: a.logIndex ?? 0,
      },
    ),
  )
  chain.inkfunLaunches.set(curveOf(a.n), {
    curve: CURVE_PARAMS,
    lpSupply: 200_000_000n * 10n ** 18n,
    totalSupply: TOTAL_SUPPLY,
    metadataURI: a.uri === undefined ? `ipfs://bafy${a.n}` : a.uri,
  })
}

export function inkfunBuy(
  chain: FakeChain,
  a: {
    n: number
    block: bigint
    sold: bigint
    quoteIn?: bigint
    fee?: bigint
    tokensOut?: bigint
    logIndex?: number
    transactionHash?: Hash
    address?: Address
  },
) {
  chain.add(
    inkfunBoughtLog(
      {
        payer: BUYER,
        beneficiary: BUYER,
        quoteIn: a.quoteIn ?? 1_000n,
        fee: a.fee ?? 13n,
        tokensOut: a.tokensOut ?? 77n,
        tokensSold: a.sold,
      },
      {
        address: a.address ?? curveOf(a.n),
        blockNumber: a.block,
        transactionHash: a.transactionHash ?? nextTx(),
        logIndex: a.logIndex ?? 1,
      },
    ),
  )
}

export function inkfunSell(
  chain: FakeChain,
  a: {
    n: number
    block: bigint
    sold: bigint
    quoteOut?: bigint
    fee?: bigint
    tokensIn?: bigint
    logIndex?: number
  },
) {
  chain.add(
    inkfunSoldLog(
      {
        seller: BUYER,
        tokensIn: a.tokensIn ?? 50n,
        quoteOut: a.quoteOut ?? 900n,
        fee: a.fee ?? 11n,
        tokensSold: a.sold,
      },
      {
        address: curveOf(a.n),
        blockNumber: a.block,
        transactionHash: nextTx(),
        logIndex: a.logIndex ?? 1,
      },
    ),
  )
}

export function inkfunMigrate(
  chain: FakeChain,
  a: {
    n: number
    block: bigint
    logIndex?: number
    transactionHash?: Hash
    address?: Address
    token?: Address
  },
) {
  chain.add(
    inkfunMigratedLog(
      {
        poolId: poolIdOf(a.n),
        launchToken: a.token ?? tokenOf(a.n),
        tokenAmount: 197_000_000n * 10n ** 18n,
        quoteAmount: 4_150_000_000_000_000_000n,
      },
      {
        ...(a.address ? { address: a.address } : {}),
        blockNumber: a.block,
        transactionHash: a.transactionHash ?? nextTx(),
        logIndex: a.logIndex ?? 5,
      },
    ),
  )
}

/** `tokensSold` after raising `raised` wei of net quote, by the curve's own formula. */
export function soldFor(raised: bigint): bigint {
  const c = CURVE_PARAMS
  return c.virtualTokens - (c.virtualQuote * c.virtualTokens) / (c.virtualQuote + raised)
}
