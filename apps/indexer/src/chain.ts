import {
  type AuctionCheckpoint,
  type ChainLog,
  type ClassicLaunch,
  type CodeReader,
  hasCodeAt,
  type InkfunLaunchState,
  type LaunchKey,
  type LaunchState,
  type MasterLaunchConfig,
  type NftReader,
  type NftxListingRead,
  type NftxReader,
  readAuctionCheckpoint,
  readBalances,
  readClassicLaunches,
  readCurveSold,
  readErc20Meta,
  readErc20Names,
  readInkfunLaunches,
  readLaunchStates,
  readMasterLaunchConfigs,
  readMaxSupply,
  readMetadataUris,
  readMintStats,
  readNftTotalSupply,
  readNftxListings,
  readNftxPoolCounts,
  readOwners,
  readTotalSupplies,
  readTsunamiCurves,
  type StateReader,
  type TsunamiCurveState,
} from "@ink-indexer/sdk"
import { type Address, BlockNotFoundError, type Hash } from "viem"
import { type Logger, log } from "./log"
import { isTransportError, type LogFilter, type LogRouter } from "./rpc"

/** Everything the indexer needs from Ink. viemChain is the real one; tests use FakeChain. */
export type Chain = {
  getBlockNumber(): Promise<bigint>
  /**
   * Each healthy endpoint's own eth_blockNumber, for a tick whose head is not above the cursor.
   * An endpoint that is benched or does not answer is left out; none answering gives an empty list.
   * A cached answer below `from` is read again.
   */
  getTransportHeads(from: bigint): Promise<{ name: string; head: bigint }[]>
  /** null when the serving endpoint does not have the block yet. That is unknown, never a hash mismatch. */
  getBlock(n: bigint): Promise<{ hash: Hash; timestamp: bigint } | null>
  /** Logs matching `filter` from `from` up to at most `to`, and the last block covered. The log transport may be behind head, so this can stop short of `to`. */
  getLogs(
    from: bigint,
    to: bigint,
    filter: LogFilter,
  ): Promise<{ logs: ChainLog[]; toBlock: bigint }>
  /**
   * One block read with its transactions: the block's hash and timestamp, and each transaction's
   * sender and target by transaction hash (the target is null for a contract creation). null when
   * the serving endpoint does not have the block yet.
   */
  getBlockSenders(n: bigint): Promise<{
    hash: Hash
    timestamp: number
    senders: Map<Hash, Address>
    targets: Map<Hash, Address | null>
  } | null>
  /** `balanceOf(holder)` on each token at a block, in the order given. */
  readBalances(pairs: { token: Address; holder: Address }[], block: bigint): Promise<bigint[]>
  readLaunchStates(keys: LaunchKey[], block: bigint): Promise<LaunchState[]>
  readTotalSupplies(tokens: Address[], block: bigint): Promise<bigint[]>
  /**
   * The NFTX Listings contract's record, price and type of each item at a block, in the order
   * given; null for an item whose `listings` call reverts. Two multicalls.
   */
  readNftxListings(
    items: { collection: Address; tokenId: bigint; listings?: Address }[],
    block: bigint,
  ): Promise<(NftxListingRead | null)[]>
  /** NFTs in each collection's NFTX pool at a block; null when a read reverts. */
  readNftxPoolCounts(
    collections: { collection: Address; createdBlock: bigint }[],
    block: bigint,
  ): Promise<(number | null)[]>
  /** `owner()` of each contract at a block; null when it reverts. */
  readOwners(contracts: Address[], block: bigint): Promise<(Address | null)[]>
  /** An auction's up-to-date state at a block; null when `checkpoint()` reverts. */
  readAuctionCheckpoint(auction: Address, block: bigint): Promise<AuctionCheckpoint | null>
  /** Curve parameters, token supply and metadata URI of ink.fun launches at a block, in the order given. */
  readInkfunLaunches(
    launches: { token: Address; curve: Address }[],
    block: bigint,
  ): Promise<InkfunLaunchState[]>
  /** `curve()` of each Tsunami curve at a block, in the order given. */
  readTsunamiCurves(curves: Address[], block: bigint): Promise<TsunamiCurveState[]>
  /** `launches(id)` of each Hookit Classic launch at a block, in the order given. */
  readClassicLaunches(ids: bigint[], block: bigint): Promise<ClassicLaunch[]>
  /**
   * Each Master launch's configuration, read from its factory at a block, in the order given. null
   * for a launch the factory does not answer for.
   */
  readMasterLaunchConfigs(
    launches: { factory: Address; launchId: bigint }[],
    block: bigint,
  ): Promise<(MasterLaunchConfig | null)[]>
  /** `metadataURI()` of each Hookit token at a block, in the order given. A call that reverts gives null. */
  readMetadataUris(tokens: Address[], block: bigint): Promise<(string | null)[]>
  /** `tokensSold()` of each ink.fun curve at a block, in the order given. */
  readCurveSold(curves: Address[], block: bigint): Promise<bigint[]>
  readErc20Meta(token: Address): Promise<{ decimals: number; symbol: string }>
  /** `symbol()` and `name()` of each token at a block, in the order given. A call that reverts gives null. */
  readErc20Names(
    tokens: Address[],
    block: bigint,
  ): Promise<{ symbol: string | null; name: string | null }[]>
  /** SeaDrop-style `getMintStats` at a block. null when the contract has no such function. */
  readMintStats(
    contract: Address,
    minter: Address,
    block: bigint,
  ): Promise<{ totalSupply: bigint; maxSupply: bigint } | null>
  /** `maxSupply()`, else `MAX_SUPPLY()`, at a block. null when the contract has neither. */
  readMaxSupply(contract: Address, block: bigint): Promise<bigint | null>
  /** An NFT contract's `totalSupply()` at a block. null when it reverts or has none. */
  readTotalSupplyAt(contract: Address, block: bigint): Promise<bigint | null>
  /** Whether the address had contract code at a block. */
  hasCodeAt(address: Address, block: bigint): Promise<boolean>
}

/** The slice of a PublicClient that viemChain reads blocks with. Structural, so chain-specific block shapes (Ink's deposit transactions) still fit. */
export type BlockReader = {
  getBlockNumber(args: { cacheTime: number }): Promise<bigint>
  getBlock(args: { blockNumber: bigint; includeTransactions?: boolean }): Promise<{
    hash: Hash | null
    timestamp: bigint
    transactions?: ({ hash: Hash; from: Address; to?: Address | null } | Hash)[]
  }>
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Consecutive failures of one call after which each further failure is logged as an error. */
export const ERROR_AFTER_FAILURES = 5

/** The url of the endpoint named in the error or its causes. */
function errorUrl(err: unknown): string | undefined {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    const url = (e as { url?: unknown }).url
    if (typeof url === "string") return url
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Reads go through viem's HTTP fallback over every endpoint, each request with a hard timeout, so a
 * transport error (socket, HTTP or timeout) only surfaces here when every endpoint failed. That is
 * an outage, not a data error: wait and ask again, unless shutdown has begun. Every other error
 * (revert, RPC error response, decode) is rethrown at once. From the 5th consecutive failure of a
 * call each retry is logged as an error; it keeps trying, and the stall watchdog decides when to exit.
 */
async function retryOnTransportError<T>(
  call: string,
  fn: () => Promise<T>,
  logger: Logger,
  sleep: (ms: number) => Promise<void>,
  isStopping: () => boolean,
): Promise<T> {
  for (let failures = 1, wait = 1_000; ; failures++, wait = Math.min(wait * 2, 30_000)) {
    try {
      return await fn()
    } catch (err) {
      if (!isTransportError(err) || isStopping()) throw err
      const fields = { call, failures, url: errorUrl(err), retryInMs: wait, error: String(err) }
      if (failures >= ERROR_AFTER_FAILURES)
        logger("error", "RPC read failing repeatedly; still retrying", fields)
      else logger("warn", "RPC read failed; retrying", fields)
      await sleep(wait)
    }
  }
}

export function viemChain(
  client: StateReader & NftReader & NftxReader & CodeReader & BlockReader,
  router: LogRouter,
  opts: {
    logger?: Logger
    sleep?: (ms: number) => Promise<void>
    isStopping?: () => boolean
  } = {},
): Chain {
  const { logger = log, sleep = sleepMs, isStopping = () => false } = opts
  const retry = <T>(call: string, fn: () => Promise<T>) =>
    retryOnTransportError(call, fn, logger, sleep, isStopping)
  return {
    getBlockNumber: () => retry("getBlockNumber", () => client.getBlockNumber({ cacheTime: 0 })),
    async getBlock(n) {
      try {
        const b = await retry("getBlock", () => client.getBlock({ blockNumber: n }))
        return b.hash ? { hash: b.hash.toLowerCase() as Hash, timestamp: b.timestamp } : null
      } catch (err) {
        if (err instanceof BlockNotFoundError) return null
        throw err
      }
    },
    async getBlockSenders(n) {
      try {
        const b = await retry("getBlockSenders", () =>
          client.getBlock({ blockNumber: n, includeTransactions: true }),
        )
        if (!b.hash) return null
        const senders = new Map<Hash, Address>()
        const targets = new Map<Hash, Address | null>()
        for (const tx of b.transactions ?? [])
          if (typeof tx !== "string") {
            const hash = tx.hash.toLowerCase() as Hash
            senders.set(hash, tx.from.toLowerCase() as Address)
            targets.set(hash, tx.to ? (tx.to.toLowerCase() as Address) : null)
          }
        return {
          hash: b.hash.toLowerCase() as Hash,
          timestamp: Number(b.timestamp),
          senders,
          targets,
        }
      } catch (err) {
        if (err instanceof BlockNotFoundError) return null
        throw err
      }
    },
    readBalances: (pairs, block) => retry("readBalances", () => readBalances(client, pairs, block)),
    getTransportHeads: (from) => router.heads(from),
    getLogs: (from, to, filter) => router.getLogs(from, to, filter),
    readLaunchStates: (keys, block) =>
      retry("readLaunchStates", () => readLaunchStates(client, keys, block)),
    readTotalSupplies: (tokens, block) =>
      retry("readTotalSupplies", () => readTotalSupplies(client, tokens, block)),
    readNftxListings: (items, block) =>
      retry("readNftxListings", () => readNftxListings(client, items, block)),
    readNftxPoolCounts: (collections, block) =>
      retry("readNftxPoolCounts", () => readNftxPoolCounts(client, collections, block)),
    readOwners: (contracts, block) =>
      retry("readOwners", () => readOwners(client, contracts, block)),
    readAuctionCheckpoint: (auction, block) =>
      retry("readAuctionCheckpoint", () => readAuctionCheckpoint(client, auction, block)),
    readInkfunLaunches: (launches, block) =>
      retry("readInkfunLaunches", () => readInkfunLaunches(client, launches, block)),
    readTsunamiCurves: (curves, block) =>
      retry("readTsunamiCurves", () => readTsunamiCurves(client, curves, block)),
    readClassicLaunches: (ids, block) =>
      retry("readClassicLaunches", () => readClassicLaunches(client, ids, block)),
    readMasterLaunchConfigs: (launches, block) =>
      retry("readMasterLaunchConfigs", () => readMasterLaunchConfigs(client, launches, block)),
    readMetadataUris: (tokens, block) =>
      retry("readMetadataUris", () => readMetadataUris(client, tokens, block)),
    readCurveSold: (curves, block) =>
      retry("readCurveSold", () => readCurveSold(client, curves, block)),
    readErc20Meta: (token) => retry("readErc20Meta", () => readErc20Meta(client, token)),
    readErc20Names: (tokens, block) =>
      retry("readErc20Names", () => readErc20Names(client, tokens, block)),
    readMintStats: (contract, minter, block) =>
      retry("readMintStats", () => readMintStats(client, contract, minter, block)),
    readMaxSupply: (contract, block) =>
      retry("readMaxSupply", () => readMaxSupply(client, contract, block)),
    readTotalSupplyAt: (contract, block) =>
      retry("readTotalSupplyAt", () => readNftTotalSupply(client, contract, block)),
    hasCodeAt: (address, block) => retry("hasCodeAt", () => hasCodeAt(client, address, block)),
  }
}
