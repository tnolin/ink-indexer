import type { Sql } from "@ink-indexer/db"
import {
  type ChainLog,
  type ClassicCurve,
  type ClassicLaunch,
  classicCurveOf,
  classicMarketCap,
  classicProgressBps,
  classicState,
  decodeHookitLog,
  HOOKIT_BONDING_FACTORY,
  HOOKIT_GRADUATED_FEE_HOOK,
  HOOKIT_GRADUATED_TICK_SPACING,
  HOOKIT_LOG_TOPICS,
  HOOKIT_MASTER_FACTORIES,
  type HookitLog,
  hookitBondEvent,
  hookitClassicLaunchEvent,
  hookitLaunchId,
  hookitMasterLaunchEvent,
  hookitTradeEvent,
  inlineJson,
  type LaunchMetadataFields,
  type PoolKey,
  parseHookitMetadata,
  poolIdOf,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import { settleBounded } from "../../bounded"
import type { Chain } from "../../chain"
import { BlockNotServedError } from "../../errors"
import { fetchIpfsJson } from "../../ipfs"
import type { Logger } from "../../log"
import type { LogFilter } from "../../rpc"
import type { AthRow, CurveRow, TradeRow } from "../inkypump/index"
import type { PoolEntry, PoolRegistry } from "../pools"
import { blockSendersFor } from "../senders"
import { type EventRow, pick, type Source } from "../source"
import { curvesToRefresh, loadCurves, loadHooks, rollbackRows, writeRows } from "./store"

/** Gateways rate-limit, so a span of many launches fetches this many documents at a time. */
const METADATA_CONCURRENCY = 4
/** Launch blocks whose chain state a backfill span reads at once. */
const LAUNCH_READS = 4
/** Unknown emitters named in a warning; past this one warning says there are more. */
const MAX_WARNED = 1_000

type Of<K extends HookitLog["kind"]> = Extract<HookitLog, { kind: K }>
type Master = Of<"masterLaunched">
type Classic = Of<"classicLaunched">
type Item = { log: ChainLog; d: HookitLog }

/** A Classic launch on its curve: the constants its state is derived from, and the tokens sold so far. */
export type KnownClassic = {
  token: Address
  /** The factory's own id for the launch, which its events carry. */
  launchNumber: bigint
  quote: Address
  curve: ClassicCurve
  supply: bigint
  sold: bigint
  progressBps: number
  /** Events at or below this block are already in `sold`, so a replayed span does not count them again. */
  appliedThrough: bigint
}
export type HookitTokenRow = {
  address: Address
  hook: Address
  launchId: Hash
  name: string | null
  ticker: string | null
  creator: Address
  createdBlock: bigint
  createdAt: Date
  quoteAsset: Address
  totalSupply: bigint
  /** Null for a Master token, which starts in a pool. */
  targetRaise: bigint | null
  saleSupply: bigint | null
}
export type ClassicRow = {
  token: Address
  launchNumber: bigint
  curve: ClassicCurve
  sold: bigint
  block: bigint
}
export type Bond = { token: Address; block: bigint; totalSupply: bigint }
export type Sold = { token: Address; sold: bigint; block: bigint }
export type HookitBatch = {
  hooks: { address: Address; discoveredBlock: bigint }[]
  tokens: HookitTokenRow[]
  classic: ClassicRow[]
  /** Tokens that graduated in this span, with the supply read at the graduation block. */
  bonds: Bond[]
  pools: PoolEntry[]
  trades: TradeRow[]
  curve: CurveRow[]
  /** Tokens whose ath rose in this span, with the ath at the span's end. */
  ath: AthRow[]
  events: EventRow[]
  blocks: { number: bigint; hash: Hash }[]
}
export type Rollback = { curve: CurveRow[]; sold: Sold[] }

export type HookitDeps = {
  sql: Sql
  chain: Pick<
    Chain,
    | "getBlockSenders"
    | "readTotalSupplies"
    | "readClassicLaunches"
    | "readMetadataUris"
    | "readErc20Names"
  >
  logger: Logger
  pools: PoolRegistry
  ipfs: { gateway: string; fetch?: typeof fetch }
  /** Block-sender reads a backfill span keeps in flight; tests lower it. */
  blockReads?: number
}

/** Every Hookit event: one topic0 position matching any of the event signatures. */
const LOG_FILTER: LogFilter = { topics: [HOOKIT_LOG_TOPICS] }

const MASTER_KINDS: ReadonlySet<HookitLog["kind"]> = new Set([
  "masterLaunched",
  "market",
  "configured",
  "devBuy",
])

const byPosition = (a: ChainLog, b: ChainLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

type Launch = { d: Master | Classic; block: bigint }
type Read = {
  supply: bigint
  name: string | null
  ticker: string | null
  uri: string | null
  classic: ClassicLaunch | null
}
/** The logs one Master launch emits in its transaction, which come on both sides of `TokenLaunched`. */
type Group = {
  markets: Map<number, Of<"market">>
  configured?: Of<"configured">
  devBuy?: Of<"devBuy">
}

const groupKey = (log: ChainLog, launchId: bigint) =>
  `${log.transactionHash}:${log.address}:${launchId}`

/**
 * Hookit as a loop source: Master launches (a token that trades in its pools from the first block,
 * with one pool per market) and Classic bonding-curve trades. Events are trusted by emitter: Master
 * events from the Master factories, Classic events from the bonding factory. A Classic curve's state
 * is derived from the tokens sold, which the events replay exactly; the constants it starts from are
 * kept in `hookit_curves`. The InkyPump source owns the shared pool registry's lifecycle and the
 * rollback of token, trade, pool and ath rows.
 */
export function hookitSource(deps: HookitDeps): Source<HookitBatch, Rollback> {
  const { sql, chain, logger, pools } = deps
  const curves = new Map<bigint, KnownClassic>()
  const knownHooks = new Set<Address>()
  const warned = new Set<Address>()
  let warnedTooMany = false
  const warnedLaunches = new Set<bigint>()
  /** Transactions whose trader this source set for the `v4` source; cleared when the next span starts. */
  let overridden: Hash[] = []

  const warnUnknown = (log: ChainLog) => {
    if (warned.has(log.address)) return
    if (warned.size >= MAX_WARNED) {
      if (!warnedTooMany) {
        warnedTooMany = true
        logger("warn", "too many unknown emitters", { limit: MAX_WARNED })
      }
      return
    }
    warned.add(log.address)
    logger("warn", "ignoring Hookit-shaped launch from an unknown contract", {
      address: log.address,
      tx: log.transactionHash,
    })
  }

  /** Keeps logs from the emitter that may emit them, in order. */
  function trust(logs: ChainLog[]): Item[] {
    const items: Item[] = []
    for (const log of [...logs].sort(byPosition)) {
      const d = decodeHookitLog(log)
      if (!d) continue
      const trusted = MASTER_KINDS.has(d.kind)
        ? HOOKIT_MASTER_FACTORIES.has(log.address)
        : log.address === HOOKIT_BONDING_FACTORY
      if (trusted) items.push({ log, d })
      // Names like Bought and Sold are common, so only a launch-shaped log is worth a warning.
      else if (d.kind === "masterLaunched" || d.kind === "classicLaunched") warnUnknown(log)
    }
    return items
  }

  /** Supply, names, metadata URI and (Classic) curve of every launch in one block. */
  async function readBlock(block: bigint, launches: Launch[]): Promise<[Address, Read][]> {
    const tokens = launches.map((l) => l.d.token)
    const ids = launches.flatMap((l) => (l.d.kind === "classicLaunched" ? [l.d.launchId] : []))
    const [supplies, uris, names, classic] = await Promise.all([
      chain.readTotalSupplies(tokens, block),
      chain.readMetadataUris(tokens, block),
      chain.readErc20Names(tokens, block),
      chain.readClassicLaunches(ids, block),
    ])
    let next = 0
    return launches.map((l, i) => [
      l.d.token,
      {
        supply: supplies[i]!,
        name: names[i]!.name,
        ticker: names[i]!.symbol,
        uri: uris[i] ?? null,
        classic: l.d.kind === "classicLaunched" ? classic[next++]! : null,
      },
    ])
  }

  /** `limit` launch blocks at a time. The first block in order that failed fails the read. */
  async function readLaunches(
    launchBlocks: [bigint, Launch[]][],
    limit: number,
  ): Promise<Map<Address, Read>> {
    let failed = false
    const settled = await settleBounded(launchBlocks, limit, async ([block, launches]) => {
      if (failed) return null
      try {
        return await readBlock(block, launches)
      } catch (err) {
        failed = true
        throw err
      }
    })
    const reads = new Map<Address, Read>()
    for (const r of settled) {
      if (r.status === "rejected") throw r.reason
      for (const [token, read] of r.value ?? []) reads.set(token, read)
    }
    return reads
  }

  /**
   * Metadata of every launch in the span, fetched together so the span waits for one budget. An
   * inline `data:` document is decoded in process; an `ipfs://` one is fetched; any other URI, and a
   * launch whose read reverted, gives null.
   */
  async function fetchMetadata(
    launches: Launch[],
    reads: Map<Address, Read>,
  ): Promise<Map<Address, LaunchMetadataFields | null>> {
    const out = new Map<Address, LaunchMetadataFields | null>()
    const queue = [...launches]
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const token = next.d.token
        const uri = reads.get(token)?.uri ?? null
        const json =
          uri === null
            ? null
            : (inlineJson(uri) ??
              (await fetchIpfsJson(uri, {
                ...deps.ipfs,
                log: logger,
                ipfsOnly: true,
                launchpad: "hookit",
                token,
              })))
        out.set(token, json === null ? null : parseHookitMetadata(json, deps.ipfs.gateway))
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(METADATA_CONCURRENCY, launches.length) }, worker),
    )
    return out
  }

  async function process(input: ChainLog[], live: boolean): Promise<HookitBatch> {
    const batch: HookitBatch = {
      hooks: [],
      tokens: [],
      classic: [],
      bonds: [],
      pools: [],
      trades: [],
      curve: [],
      ath: [],
      events: [],
      blocks: [],
    }
    // The v4 source of the previous span has used these by now.
    for (const tx of overridden) pools.forgetTraderOf(tx)
    overridden = []

    const groups = new Map<string, Group>()
    const group = (log: ChainLog, launchId: bigint) => {
      const key = groupKey(log, launchId)
      let g = groups.get(key)
      if (!g) {
        g = { markets: new Map() }
        groups.set(key, g)
      }
      return g
    }
    const items = trust(input).filter(({ log, d }) => {
      if (d.kind === "market") group(log, d.launchId).markets.set(d.index, d)
      else if (d.kind === "configured") group(log, d.launchId).configured = d
      else if (d.kind === "devBuy") group(log, d.launchId).devBuy = d
      else if (d.kind === "masterLaunched" && !group(log, d.launchId).configured) {
        logger("warn", "ignoring Hookit launch without a configuration", {
          token: d.token,
          tx: log.transactionHash,
        })
        return false
      }
      return true
    })
    if (items.length === 0) return batch

    const blocks = new Map<bigint, Item[]>()
    for (const i of items) {
      const g = blocks.get(i.log.blockNumber)
      if (g) g.push(i)
      else blocks.set(i.log.blockNumber, [i])
    }
    const launchBlocks: [bigint, Launch[]][] = []
    for (const [block, its] of blocks) {
      const launches = its.flatMap(({ d }) =>
        d.kind === "masterLaunched" || d.kind === "classicLaunched" ? [{ d, block }] : [],
      )
      if (launches.length > 0) launchBlocks.push([block, launches])
    }
    const launches = launchBlocks.flatMap(([, l]) => l)

    // The live tick reads launch state, then metadata, then each block when it reaches it. A
    // backfill span runs all three together, then processes the logs in order from what was read.
    let reads: Map<Address, Read>
    let metadata: Map<Address, LaunchMetadataFields | null>
    let senders: Awaited<ReturnType<typeof blockSendersFor>>
    if (live) {
      reads = await readLaunches(launchBlocks, 1)
      metadata = await fetchMetadata(launches, reads)
      senders = await blockSendersFor(chain, [], { live })
    } else {
      reads = await readLaunches(launchBlocks, LAUNCH_READS)
      ;[senders, metadata] = await Promise.all([
        blockSendersFor(chain, [...blocks.keys()], { live, limit: deps.blockReads }),
        fetchMetadata(launches, reads),
      ])
    }

    const athBefore = new Map<Address, bigint>()
    const curveRows = new Map<Address, CurveRow>()
    const classicRows = new Map<Address, ClassicRow>()
    const touch = (k: KnownClassic, block: bigint) => {
      k.progressBps = classicProgressBps(k.curve, k.sold)
      classicRows.set(k.token, {
        token: k.token,
        launchNumber: k.launchNumber,
        curve: k.curve,
        sold: k.sold,
        block,
      })
      curveRows.set(k.token, {
        token: k.token,
        progressBps: k.progressBps,
        curveValue: classicState(k.curve, k.sold).realQuote,
        target: k.curve.graduationQuote,
        marketCap: classicMarketCap(k.curve, k.sold, k.supply),
        updatedBlock: block,
      })
    }

    for (const [blockNumber, its] of blocks) {
      const blockHash = its[0]!.log.blockHash
      const block = await senders(blockNumber)
      // The logs and the block can come from different endpoints on either side of a reorg.
      if (!block || block.hash !== blockHash) throw new BlockNotServedError(blockNumber)
      batch.blocks.push({ number: blockNumber, hash: blockHash })

      for (const { log, d } of its) {
        const meta = {
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber,
          blockTimestamp: block.timestamp,
        }
        if (d.kind === "masterLaunched") {
          const g = groups.get(groupKey(log, d.launchId))!
          const configured = g.configured!
          const read = reads.get(d.token)!
          const markets = [...g.markets.values()].sort((a, b) => a.index - b.index)
          const event = hookitMasterLaunchEvent(
            d,
            {
              configured,
              markets,
              supply: read.supply,
              name: read.name,
              ticker: read.ticker,
              metadata: metadata.get(d.token) ?? null,
            },
            meta,
          )
          if (!knownHooks.has(d.hooks)) {
            knownHooks.add(d.hooks)
            batch.hooks.push({ address: d.hooks, discoveredBlock: blockNumber })
          }
          batch.tokens.push({
            address: d.token,
            hook: d.hooks,
            launchId: event.launchId,
            name: event.name,
            ticker: event.ticker,
            creator: d.creator,
            createdBlock: blockNumber,
            createdAt: new Date(block.timestamp * 1000),
            quoteAsset: event.quoteAsset,
            totalSupply: read.supply,
            targetRaise: null,
            saleSupply: null,
          })
          batch.events.push({ event, block: blockNumber, blockHash })
          // A launch with one market has no MarketLaunched; its only pool is the launch's own.
          const marketPools =
            markets.length > 0
              ? markets
              : [
                  {
                    poolId: d.poolId,
                    quote: configured.quote,
                    tickLower: d.tickLower,
                    tickUpper: d.tickUpper,
                  },
                ]
          for (const m of marketPools) {
            const pool: PoolEntry = {
              poolId: m.poolId,
              poolManager: UNISWAP_V4_POOL_MANAGER,
              token: d.token,
              launchId: event.launchId,
              launchpad: "hookit",
              quoteAsset: m.quote,
              tokenIsCurrency0: d.token < m.quote,
              createdBlock: blockNumber,
              hook: d.hooks,
              tickLower: m.tickLower,
              tickUpper: m.tickUpper,
            }
            pools.add(pool, read.supply, blockNumber)
            batch.pools.push(pool)
          }
          // The factory's own dev-buy swap is made for the creator, whatever the transaction's sender.
          if (g.devBuy) {
            pools.setTraderOf(log.transactionHash, g.devBuy.buyer, log.address)
            overridden.push(log.transactionHash)
          }
        } else if (d.kind === "classicLaunched") {
          const read = reads.get(d.token)!
          const state = read.classic!
          // Trades in this block replay from an untouched curve; only the constants come from the read.
          const known: KnownClassic = {
            token: d.token,
            launchNumber: d.launchId,
            quote: d.quote,
            curve: classicCurveOf(state),
            supply: read.supply,
            sold: 0n,
            progressBps: 0,
            // Trades in the launch block replay from an untouched curve.
            appliedThrough: blockNumber - 1n,
          }
          curves.set(d.launchId, known)
          const event = hookitClassicLaunchEvent(
            d,
            {
              supply: read.supply,
              name: read.name,
              ticker: read.ticker,
              metadata: metadata.get(d.token) ?? null,
            },
            meta,
          )
          batch.tokens.push({
            address: d.token,
            hook: HOOKIT_GRADUATED_FEE_HOOK,
            launchId: event.launchId,
            name: event.name,
            ticker: event.ticker,
            creator: d.creator,
            createdBlock: blockNumber,
            createdAt: new Date(block.timestamp * 1000),
            quoteAsset: d.quote,
            totalSupply: read.supply,
            targetRaise: d.graduationQuote,
            saleSupply: state.curveSupply,
          })
          batch.events.push({ event, block: blockNumber, blockHash })
          touch(known, blockNumber)
        } else if (
          d.kind === "bought" ||
          d.kind === "sold" ||
          d.kind === "drop" ||
          d.kind === "graduated"
        ) {
          const known = curves.get(d.launchId)
          if (!known || (d.kind === "drop" && d.token !== known.token)) {
            if (!warnedLaunches.has(d.launchId)) {
              warnedLaunches.add(d.launchId)
              logger("warn", "ignoring Hookit curve event for an unknown launch", {
                launchId: d.launchId.toString(),
                tx: log.transactionHash,
              })
            }
            continue
          }
          if (d.kind !== "graduated" && blockNumber <= known.appliedThrough) continue
          if (d.kind === "graduated") {
            // The graduating trade has already written 10,000 bps; moving tokens into the pool
            // changes the supply, so it is read again at this block.
            const [supply] = await chain.readTotalSupplies([known.token], blockNumber)
            // v4 orders a pool's currencies by address, so either one can be the token.
            const [currency0, currency1] =
              known.token < known.quote ? [known.token, known.quote] : [known.quote, known.token]
            const key: PoolKey = {
              currency0,
              currency1,
              fee: 0,
              tickSpacing: HOOKIT_GRADUATED_TICK_SPACING,
              hooks: HOOKIT_GRADUATED_FEE_HOOK,
            }
            if (poolIdOf(key) !== d.poolId)
              logger("warn", "Hookit graduation pool id does not match its pool key", {
                token: known.token,
                poolId: d.poolId,
                tx: log.transactionHash,
              })
            const pool: PoolEntry = {
              poolId: d.poolId,
              poolManager: UNISWAP_V4_POOL_MANAGER,
              token: known.token,
              launchId: hookitLaunchId(known.token),
              launchpad: "hookit",
              quoteAsset: known.quote,
              tokenIsCurrency0: known.token < known.quote,
              createdBlock: blockNumber,
              hook: HOOKIT_GRADUATED_FEE_HOOK,
              // The graduation position is full range, which the registry holds as no ticks.
            }
            pools.add(pool, supply!, blockNumber)
            batch.pools.push(pool)
            batch.bonds.push({ token: known.token, block: blockNumber, totalSupply: supply! })
            batch.events.push({
              event: hookitBondEvent(d, { token: known.token, quote: known.quote }, meta),
              block: blockNumber,
              blockHash,
            })
            const before = curveRows.get(known.token)
            curveRows.set(known.token, {
              token: known.token,
              progressBps: 10_000,
              curveValue: before?.curveValue ?? classicState(known.curve, known.sold).realQuote,
              target: known.curve.graduationQuote,
              marketCap:
                before?.marketCap ?? classicMarketCap(known.curve, known.sold, known.supply),
              updatedBlock: blockNumber,
            })
            continue
          }
          known.sold =
            d.kind === "bought" || d.kind === "drop"
              ? known.sold + d.tokensOut
              : known.sold > d.tokensIn
                ? known.sold - d.tokensIn
                : 0n
          if (d.kind === "drop") {
            // A holder drop moves the curve for the trade after it and is not a trade itself.
            touch(known, blockNumber)
            continue
          }
          const trader = block.senders.get(log.transactionHash)
          if (!trader) throw new BlockNotServedError(blockNumber)
          if (!athBefore.has(known.token))
            athBefore.set(known.token, pools.marks(known.token)?.ath ?? 0n)
          const athMarketCap = pools.bumpAth(
            known.token,
            classicMarketCap(known.curve, known.sold, known.supply),
            blockNumber,
          )
          const event = hookitTradeEvent(
            d,
            {
              token: known.token,
              quote: known.quote,
              curve: known.curve,
              sold: known.sold,
              supply: known.supply,
              trader,
              progressBpsBefore: known.progressBps,
              athMarketCap,
            },
            meta,
          )
          touch(known, blockNumber)
          batch.trades.push(tradeRow(log, known.token, event, blockNumber))
          batch.events.push({ event, block: blockNumber, blockHash })
        }
      }
    }
    batch.curve = [...curveRows.values()]
    batch.classic = [...classicRows.values()]
    for (const [token, before] of athBefore) {
      const m = pools.marks(token)!
      if (m.ath > before && m.athBlock !== null)
        batch.ath.push({ token, marketCap: m.ath, block: m.athBlock })
    }
    return batch
  }

  return {
    name: "hookit",
    filters: (only) => [pick(only, "hookit", LOG_FILTER)],
    process: ([logs], { live }) => process(logs ?? [], live),
    write: writeRows,
    async prepareRollback(fork) {
      const refresh = await curvesToRefresh(sql, fork)
      const states =
        refresh.length > 0
          ? await chain.readClassicLaunches(
              refresh.map((c) => c.launchNumber),
              fork,
            )
          : []
      const sold: Sold[] = refresh.map((c, i) => ({
        token: c.token,
        sold: states[i]!.tokensSold,
        block: fork,
      }))
      return {
        sold,
        curve: refresh.map((c, i) => {
          const at = { ...c, sold: sold[i]!.sold }
          return {
            token: c.token,
            progressBps: classicProgressBps(c.curve, at.sold),
            curveValue: classicState(c.curve, at.sold).realQuote,
            target: c.curve.graduationQuote,
            marketCap: classicMarketCap(c.curve, at.sold, c.supply),
            updatedBlock: fork,
          }
        }),
      }
    },
    rollback: (tx, _fork, prepared) => rollbackRows(tx, prepared),
    async reload() {
      curves.clear()
      for (const c of await loadCurves(sql)) curves.set(c.launchNumber, c)
      knownHooks.clear()
      for (const h of await loadHooks(sql)) knownHooks.add(h)
    },
  }
}

function tradeRow(
  log: ChainLog,
  token: Address,
  event: { side: "buy" | "sell"; trader: Address; tokenAmount: string; quoteAmount: string },
  block: bigint,
): TradeRow {
  const buy = event.side === "buy"
  return {
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    token,
    side: event.side,
    trader: event.trader,
    amountIn: BigInt(buy ? event.quoteAmount : event.tokenAmount),
    amountOut: BigInt(buy ? event.tokenAmount : event.quoteAmount),
    block,
  }
}
