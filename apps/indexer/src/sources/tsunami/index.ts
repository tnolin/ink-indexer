import type { Sql } from "@ink-indexer/db"
import {
  CALAMARI_POOL_MANAGER,
  type ChainLog,
  decodeTsunamiLog,
  type LaunchMetadataFields,
  parseTsunamiMetadata,
  RIPTIDE_VAULT,
  TSUNAMI_FACTORIES,
  TSUNAMI_HOOKS,
  TSUNAMI_LOG_TOPICS,
  type TsunamiCurveState,
  type TsunamiLog,
  tsunamiLaunchEvent,
  tsunamiLaunchId,
  tsunamiMarketCap,
  tsunamiProgressBps,
  tsunamiTradeEvent,
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
import { servedAt } from "../v4/index"
import { curvesToRefresh, loadCurves, rollbackRows, writeRows } from "./store"

/** Gateways rate-limit, so a span of many launches fetches this many documents at a time. */
const METADATA_CONCURRENCY = 4

export type KnownCurve = {
  token: Address
  curve: Address
  launchId: Hash
  quote: Address
  targetRaise: bigint
  /** The supply market cap is priced on: total supply less any Riptide vault inventory. */
  supply: bigint
  progressBps: number
}
export type TsunamiTokenRow = {
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
}
export type Supply = { token: Address; totalSupply: bigint }
export type TsunamiBatch = {
  tokens: TsunamiTokenRow[]
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

export type TsunamiDeps = {
  sql: Sql
  chain: Pick<Chain, "getBlockSenders" | "readTotalSupplies" | "readBalances" | "readTsunamiCurves">
  logger: Logger
  pools: PoolRegistry
  ipfs: { gateway: string; fetch?: typeof fetch }
}

type Launched = Extract<TsunamiLog, { kind: "launched" }>
type Item = { log: ChainLog; d: TsunamiLog; hook?: Address }

/** Every Tsunami event: one topic0 position matching any of the event signatures. */
const LOG_FILTER: LogFilter = { topics: [TSUNAMI_LOG_TOPICS] }

const byPosition = (a: ChainLog, b: ChainLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

/**
 * Tsunami as a loop source: launches and bonding-curve trades. Each launch has its own curve
 * contract, so a trade is trusted when its emitter is a curve the source has seen launched. The
 * curves are kept in memory; `reload` rebuilds them from the database. Curve events carry the whole
 * post-trade curve state, so price, curve value and progress need no contract reads. The InkyPump
 * source owns the shared pool registry's lifecycle and the rollback of token, trade, pool, bond and
 * ath rows.
 */
export function tsunamiSource(deps: TsunamiDeps): Source<TsunamiBatch, Rollback> {
  const { sql, chain, logger, pools } = deps
  const curves = new Map<Address, KnownCurve>()
  const warned = new Set<Address>()

  const warnUnknown = (log: ChainLog) => {
    if (warned.has(log.address)) return
    warned.add(log.address)
    logger("warn", "ignoring Tsunami-shaped event from an unknown contract", {
      address: log.address,
      tx: log.transactionHash,
    })
  }

  /**
   * Keeps logs from trusted emitters only, in order, so a trade can follow its launch in one span.
   * A Calamari `Initialize` is kept only when it names the token of a launch in its own transaction,
   * and is attached to that launch as its hook.
   */
  function trust(logs: ChainLog[]): Item[] {
    const sorted = [...logs].sort(byPosition)
    const decoded = sorted.flatMap((log) => {
      const d = decodeTsunamiLog(log)
      return d ? [{ log, d }] : []
    })
    const launchedIn = new Map<Hash, Launched[]>()
    for (const { log, d } of decoded)
      if (d.kind === "launched" && TSUNAMI_FACTORIES.has(log.address)) {
        launchedIn.set(log.transactionHash, [...(launchedIn.get(log.transactionHash) ?? []), d])
      }
    const hooks = new Map<Address, Address>()
    const items: Item[] = []
    const created = new Set<Address>()
    for (const { log, d } of decoded) {
      let ok: boolean
      switch (d.kind) {
        case "launched":
          ok = TSUNAMI_FACTORIES.has(log.address)
          if (ok) created.add(d.curve)
          break
        case "bought":
        case "sold":
        case "migrated":
        case "poolMoved":
          ok = curves.has(log.address) || created.has(log.address)
          break
        case "initialize": {
          // Uniswap's and other Calamari pools emit the same topic: only a launch's own pool counts.
          const launch = launchedIn
            .get(log.transactionHash)
            ?.find((l) => l.token === d.currency0 || l.token === d.currency1)
          if (log.address === CALAMARI_POOL_MANAGER && launch) hooks.set(launch.curve, d.hooks)
          continue
        }
      }
      if (ok) items.push({ log, d })
      else warnUnknown(log)
    }
    for (const item of items)
      if (item.d.kind === "launched") {
        const hook = hooks.get(item.d.curve)
        if (hook) item.hook = hook
      }
    return items
  }

  /** Metadata of every launch in the span, fetched together so the span waits for one budget. */
  async function fetchMetadata(
    launches: Launched[],
  ): Promise<Map<Address, LaunchMetadataFields | null>> {
    const out = new Map<Address, LaunchMetadataFields | null>()
    const queue = [...launches]
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const json = await fetchIpfsJson(next.uri, {
          ...deps.ipfs,
          log: logger,
          launchpad: "tsunami",
          token: next.token,
        })
        out.set(next.curve, json === null ? null : parseTsunamiMetadata(json, deps.ipfs.gateway))
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(METADATA_CONCURRENCY, launches.length) }, worker),
    )
    return out
  }

  async function process(input: ChainLog[]): Promise<TsunamiBatch> {
    const batch: TsunamiBatch = {
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
    // Supply less the Riptide vault's inventory, which is not circulating, per launch.
    const supplies = new Map<Address, bigint>()
    const launches: Launched[] = []
    for (const [blockNumber, group] of blocks) {
      const launched = group.flatMap((i) => (i.d.kind === "launched" ? [i.d] : []))
      if (launched.length === 0) continue
      launches.push(...launched)
      const tokens = launched.map((l) => l.token)
      const total = await chain.readTotalSupplies(tokens, blockNumber)
      const vault = await chain.readBalances(
        tokens.map((token) => ({ token, holder: RIPTIDE_VAULT })),
        blockNumber,
      )
      launched.forEach((l, i) => {
        supplies.set(l.curve, total[i]! - vault[i]!)
      })
    }
    const metadata = await fetchMetadata(launches)

    const athBefore = new Map<Address, bigint>()
    const curveRows = new Map<Address, CurveRow>()
    for (const [blockNumber, group] of blocks) {
      const blockHash = group[0]!.log.blockHash
      const block = await servedAt(blockNumber, () => chain.getBlockSenders(blockNumber))
      // The logs and the block can come from different endpoints on either side of a reorg.
      if (!block || block.hash !== blockHash) throw new BlockNotServedError(blockNumber)
      batch.blocks.push({ number: blockNumber, hash: blockHash })

      for (const { log, d, hook } of group) {
        const meta = {
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber,
          blockTimestamp: block.timestamp,
        }
        if (d.kind === "launched") {
          const supply = supplies.get(d.curve)!
          const launchHook = hook ?? TSUNAMI_HOOKS.current
          if (!hook)
            logger("warn", "launch without a Calamari Initialize", {
              token: d.token,
              tx: log.transactionHash,
            })
          const known: KnownCurve = {
            token: d.token,
            curve: d.curve,
            launchId: tsunamiLaunchId(d.curve),
            quote: d.quote,
            targetRaise: d.targetRaise,
            supply,
            progressBps: 0,
          }
          curves.set(d.curve, known)
          const event = tsunamiLaunchEvent(
            d,
            { hook: launchHook, supply, metadata: metadata.get(d.curve) ?? null },
            meta,
          )
          batch.tokens.push({
            address: d.token,
            hook: launchHook,
            launchId: known.launchId,
            name: event.name,
            ticker: event.ticker,
            creator: d.creator,
            createdBlock: blockNumber,
            createdAt: new Date(block.timestamp * 1000),
            quoteAsset: d.quote,
            totalSupply: supply,
            targetRaise: d.targetRaise,
            saleSupply: d.state.realBase,
          })
          batch.events.push({ event, block: blockNumber, blockHash })
          curveRows.set(d.token, curveRow(d.token, d.state, d.targetRaise, supply, blockNumber))
        } else if (d.kind === "bought" || d.kind === "sold") {
          const known = curves.get(log.address)!
          const trader = block.senders.get(log.transactionHash)
          if (!trader) throw new BlockNotServedError(blockNumber)
          if (!athBefore.has(known.token))
            athBefore.set(known.token, pools.marks(known.token)?.ath ?? 0n)
          const athMarketCap = pools.bumpAth(
            known.token,
            tsunamiMarketCap(d.state, known.supply),
            blockNumber,
          )
          const event = tsunamiTradeEvent(
            d,
            {
              token: known.token,
              launchId: known.launchId,
              quote: known.quote,
              targetRaise: known.targetRaise,
              supply: known.supply,
              trader,
              progressBpsBefore: known.progressBps,
              athMarketCap,
            },
            meta,
          )
          known.progressBps = event.progressBpsAfter
          batch.trades.push(tradeRow(log, known.token, event, blockNumber))
          batch.events.push({ event, block: blockNumber, blockHash })
          curveRows.set(
            known.token,
            curveRow(known.token, d.state, known.targetRaise, known.supply, blockNumber),
          )
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
    name: "tsunami",
    filters: (only) => [pick(only, "tsunami", LOG_FILTER)],
    process: ([logs]) => process(logs ?? []),
    write: writeRows,
    async prepareRollback(fork) {
      const refresh = await curvesToRefresh(sql, fork)
      const states =
        refresh.length > 0
          ? await chain.readTsunamiCurves(
              refresh.map((c) => c.curve),
              fork,
            )
          : []
      return {
        curve: refresh.map((c, i) => curveRow(c.token, states[i]!, c.targetRaise, c.supply, fork)),
        supplies: [],
      }
    },
    rollback: (tx, _fork, prepared) => rollbackRows(tx, prepared),
    async reload() {
      curves.clear()
      for (const c of await loadCurves(sql)) curves.set(c.curve, c)
    },
  }
}

/** The curve-state row for a curve after an event or a read: progress, raise and market cap on `supply`. */
function curveRow(
  token: Address,
  state: TsunamiCurveState,
  targetRaise: bigint,
  supply: bigint,
  updatedBlock: bigint,
): CurveRow {
  return {
    token,
    progressBps: tsunamiProgressBps(state, targetRaise),
    curveValue: state.realQuote,
    target: targetRaise,
    marketCap: tsunamiMarketCap(state, supply),
    updatedBlock,
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
