import type { Sql } from "@ink-indexer/db"
import {
  type ChainLog,
  decodeInkfunLog,
  INKFUN_FACTORY,
  INKFUN_HOOK,
  INKFUN_LOG_TOPICS,
  INKFUN_MIGRATION,
  type InkfunBought,
  type InkfunCurve,
  type InkfunLaunchCreated,
  type InkfunLaunchState,
  type InkfunLog,
  type InkfunSold,
  inkfunCurveValue,
  inkfunLaunchEvent,
  inkfunLaunchId,
  inkfunPrice,
  inkfunProgressBps,
  inkfunTradeEvent,
  type LaunchMetadataFields,
  NATIVE_QUOTE_ASSET,
  parseInkfunMetadata,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../../chain"
import { BlockNotServedError } from "../../errors"
import { fetchIpfsJson } from "../../ipfs"
import type { Logger } from "../../log"
import type { LogFilter } from "../../rpc"
import type { AthRow, CurveRow, TradeRow } from "../inkypump/index"
import type { PoolEntry, PoolRegistry } from "../pools"
import { type EventRow, pick, type Source } from "../source"
import { curvesToRefresh, loadCurves, rollbackRows, writeRows } from "./store"

const WHOLE_TOKEN = 10n ** 18n

export type KnownCurve = {
  token: Address
  curve: Address
  launchId: Hash
  params: InkfunCurve
  totalSupply: bigint
  progressBps: number
}
export type InkfunTokenRow = {
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
  targetRaise: bigint
  saleSupply: bigint
  curve: Address
  params: InkfunCurve
  lpSupply: bigint
}
export type Supply = { token: Address; totalSupply: bigint }
export type InkfunBatch = {
  tokens: InkfunTokenRow[]
  bonds: { token: Address; block: bigint; totalSupply: bigint }[]
  pools: PoolEntry[]
  trades: TradeRow[]
  curve: CurveRow[]
  /** Tokens whose ath rose in this span, with the ath at the span's end. */
  ath: AthRow[]
  events: EventRow[]
  blocks: { number: bigint; hash: Hash }[]
}
export type Rollback = { curve: CurveRow[]; supplies: Supply[] }

export type InkfunDeps = {
  sql: Sql
  chain: Pick<Chain, "getBlock" | "readInkfunLaunches" | "readCurveSold" | "readTotalSupplies">
  logger: Logger
  pools: PoolRegistry
  ipfs: { gateway: string; fetch?: typeof fetch }
}

type Item = { log: ChainLog; d: InkfunLog }

/** Every ink.fun event: one topic0 position matching any of the event signatures. */
const LOG_FILTER: LogFilter = { topics: [INKFUN_LOG_TOPICS] }

const byPosition = (a: ChainLog, b: ChainLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

const marketCapOf = (curve: InkfunCurve, sold: bigint, supply: bigint) =>
  (inkfunPrice(curve, sold) * supply) / WHOLE_TOKEN

/**
 * ink.fun as a loop source: launches, bonding-curve trades and the migration into a Uniswap v4
 * pool. Each launch has its own curve contract, so a trade is trusted when its emitter is a curve
 * the source has seen created. The curves are kept in memory; `reload` rebuilds them from the
 * database. The InkyPump source owns the shared pool registry's lifecycle and the rollback of
 * token, trade, pool, bond and ath rows.
 */
export function inkfunSource(deps: InkfunDeps): Source<InkfunBatch, Rollback> {
  const { sql, chain, logger, pools } = deps
  const curves = new Map<Address, KnownCurve>()
  const byToken = new Map<Address, KnownCurve>()
  const warned = new Set<Address>()

  const remember = (c: KnownCurve) => {
    curves.set(c.curve, c)
    byToken.set(c.token, c)
  }
  const warnUnknown = (log: ChainLog) => {
    if (warned.has(log.address)) return
    warned.add(log.address)
    logger("warn", "ignoring ink.fun-shaped event from an unknown contract", {
      address: log.address,
      tx: log.transactionHash,
    })
  }

  /** Keeps logs from trusted emitters only, in order, so a trade can follow its launch in one span. */
  function trust(logs: ChainLog[]): Item[] {
    const items: Item[] = []
    const createdCurves = new Set<Address>()
    const createdTokens = new Set<Address>()
    for (const log of [...logs].sort(byPosition)) {
      const d = decodeInkfunLog(log)
      if (!d) continue
      let ok: boolean
      switch (d.kind) {
        case "launchCreated":
          ok = log.address === INKFUN_FACTORY
          if (ok) {
            createdCurves.add(d.curve)
            createdTokens.add(d.token)
          }
          break
        case "bought":
        case "sold":
          ok = curves.has(log.address) || createdCurves.has(log.address)
          break
        case "migrated":
          ok =
            log.address === INKFUN_MIGRATION && (byToken.has(d.token) || createdTokens.has(d.token))
          break
      }
      if (ok) items.push({ log, d })
      else warnUnknown(log)
    }
    return items
  }

  /** Metadata of every launch in the span, fetched together so the span waits for one budget. */
  async function fetchMetadata(
    launches: { token: Address; curve: Address; state: InkfunLaunchState }[],
  ): Promise<Map<Address, LaunchMetadataFields | null>> {
    const out = new Map<Address, LaunchMetadataFields | null>()
    await Promise.all(
      launches.map(async ({ token, curve, state }) => {
        if (state.metadataURI === null) return out.set(curve, null)
        const json = await fetchIpfsJson(state.metadataURI, {
          ...deps.ipfs,
          log: logger,
          token,
        })
        out.set(curve, json === null ? null : parseInkfunMetadata(json, deps.ipfs.gateway))
      }),
    )
    return out
  }

  async function process(input: ChainLog[]): Promise<InkfunBatch> {
    const batch: InkfunBatch = {
      tokens: [],
      bonds: [],
      pools: [],
      trades: [],
      curve: [],
      ath: [],
      events: [],
      blocks: [],
    }
    const items = trust(input)
    if (items.length === 0) return batch

    const blocks = groupByBlock(items)
    const reads = new Map<Address, { token: Address; curve: Address; state: InkfunLaunchState }>()
    for (const [blockNumber, group] of blocks) {
      const created = group.flatMap((i) => (i.d.kind === "launchCreated" ? [i.d] : []))
      if (created.length === 0) continue
      const states = await chain.readInkfunLaunches(
        created.map((c) => ({ token: c.token, curve: c.curve })),
        blockNumber,
      )
      created.forEach((c, i) => {
        reads.set(c.curve, { token: c.token, curve: c.curve, state: states[i]! })
      })
    }
    const metadata = await fetchMetadata([...reads.values()])

    const athBefore = new Map<Address, bigint>()
    const curveRows = new Map<Address, CurveRow>()
    for (const [blockNumber, group] of blocks) {
      const block = await chain.getBlock(blockNumber)
      if (!block) throw new BlockNotServedError(blockNumber)
      const timestamp = Number(block.timestamp)
      const blockHash = group[0]!.log.blockHash
      batch.blocks.push({ number: blockNumber, hash: blockHash })

      for (const { log, d } of group) {
        const meta = {
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber,
          blockTimestamp: timestamp,
        }
        if (d.kind === "launchCreated") {
          const read = reads.get(d.curve)!.state
          const known: KnownCurve = {
            token: d.token,
            curve: d.curve,
            launchId: inkfunLaunchId(d.curve),
            params: read.curve,
            totalSupply: read.totalSupply,
            progressBps: 0,
          }
          remember(known)
          const event = inkfunLaunchEvent(
            d,
            {
              totalSupply: read.totalSupply,
              graduationTarget: read.curve.graduationTarget,
              metadata: metadata.get(d.curve) ?? null,
            },
            meta,
          )
          batch.tokens.push(tokenRow(d, read, event, blockNumber, timestamp))
          batch.events.push({ event, block: blockNumber, blockHash })
          curveRows.set(d.token, {
            token: d.token,
            progressBps: 0,
            curveValue: 0n,
            target: read.curve.graduationTarget,
            marketCap: marketCapOf(read.curve, 0n, read.totalSupply),
            updatedBlock: blockNumber,
          })
        } else if (d.kind === "bought" || d.kind === "sold") {
          const known = curves.get(log.address)!
          if (!athBefore.has(known.token))
            athBefore.set(known.token, pools.marks(known.token)?.ath ?? 0n)
          const athMarketCap = pools.bumpAth(
            known.token,
            marketCapOf(known.params, d.tokensSold, known.totalSupply),
            blockNumber,
          )
          const event = inkfunTradeEvent(
            d,
            {
              token: known.token,
              launchId: known.launchId,
              curve: known.params,
              totalSupply: known.totalSupply,
              progressBpsBefore: known.progressBps,
              athMarketCap,
            },
            meta,
          )
          known.progressBps = event.progressBpsAfter
          batch.trades.push(tradeRow(log, known.token, event, blockNumber))
          batch.events.push({ event, block: blockNumber, blockHash })
          curveRows.set(known.token, {
            token: known.token,
            progressBps: event.progressBpsAfter,
            curveValue: BigInt(event.curveValue),
            target: known.params.graduationTarget,
            marketCap: BigInt(event.marketCap),
            updatedBlock: blockNumber,
          })
        }
      }
    }
    batch.curve = [...curveRows.values()]
    for (const [token, before] of athBefore) {
      const m = pools.marks(token)!
      if (m.ath > before && m.athBlock !== null)
        batch.ath.push({ token, marketCap: m.ath, block: m.athBlock })
    }
    return batch
  }

  return {
    name: "inkfun",
    filters: (only) => [pick(only, "inkfun", LOG_FILTER)],
    process: ([logs]) => process(logs ?? []),
    write: writeRows,
    async prepareRollback(fork) {
      const refresh = await curvesToRefresh(sql, fork)
      const sold =
        refresh.length > 0
          ? await chain.readCurveSold(
              refresh.map((c) => c.curve),
              fork,
            )
          : []
      const supplies: Supply[] = []
      return {
        curve: refresh.map((c, i) => {
          const s = sold[i]!
          return {
            token: c.token,
            progressBps: inkfunProgressBps(c.params, s),
            curveValue: inkfunCurveValue(c.params, s),
            target: c.params.graduationTarget,
            marketCap: marketCapOf(c.params, s, c.totalSupply),
            updatedBlock: fork,
          }
        }),
        supplies,
      }
    },
    rollback: (tx, _fork, prepared) => rollbackRows(tx, prepared),
    async reload() {
      curves.clear()
      byToken.clear()
      for (const c of await loadCurves(sql)) remember(c)
    },
  }
}

function tokenRow(
  d: InkfunLaunchCreated,
  read: InkfunLaunchState,
  event: { name: string | null; ticker: string | null },
  blockNumber: bigint,
  timestamp: number,
): InkfunTokenRow {
  return {
    address: d.token,
    hook: INKFUN_HOOK,
    launchId: inkfunLaunchId(d.curve),
    name: event.name,
    ticker: event.ticker,
    creator: d.creator,
    createdBlock: blockNumber,
    createdAt: new Date(timestamp * 1000),
    quoteAsset: NATIVE_QUOTE_ASSET,
    totalSupply: read.totalSupply,
    targetRaise: read.curve.graduationTarget,
    saleSupply: read.curve.curveSupply,
    curve: d.curve,
    params: read.curve,
    lpSupply: read.lpSupply,
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

function groupByBlock(items: Item[]): Map<bigint, Item[]> {
  const groups = new Map<bigint, Item[]>()
  for (const i of items) {
    const g = groups.get(i.log.blockNumber)
    if (g) g.push(i)
    else groups.set(i.log.blockNumber, [i])
  }
  return groups
}

export type { InkfunBought, InkfunSold }
