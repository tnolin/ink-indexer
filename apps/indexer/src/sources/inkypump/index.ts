import type { Sql } from "@ink-indexer/db"
import {
  bondEvent,
  type ChainLog,
  type CurveParams,
  curvePrice,
  curveValue,
  type DecodedLog,
  decodeLog,
  type LaunchCreated,
  type LaunchKey,
  type LaunchMetadata,
  type LaunchState,
  LOG_TOPICS,
  launchEvent,
  marketCap,
  progressBps,
  tradeEvent,
  UNISWAP_V4_POOL_MANAGER,
  XSTOCKS_HOOK_CREATED_TOPIC,
  type XStocksHookCreated,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../../chain"
import { BlockNotServedError } from "../../errors"
import type { Logger } from "../../log"
import type { LogFilter } from "../../rpc"
import type { PoolEntry, PoolRegistry } from "../pools"
import { type EventRow, pick, type Source } from "../source"
import { HookRegistry, type HookRow, nativeHookRows } from "./hooks"
import {
  launchesToRefresh,
  loadHooks,
  loadLaunches,
  rollbackRows,
  seedHooks,
  writeRows,
} from "./store"

export type KnownLaunch = {
  token: Address
  hook: Address
  launchId: Hash
  quoteAsset: Address
  params: CurveParams
  totalSupply: bigint
  progressBps: number
}
export type TokenRow = {
  address: Address
  hook: Address
  launchId: Hash
  name: string | null
  ticker: string | null
  creator: Address
  createdBlock: bigint
  createdAt: Date
  quoteAsset: Address
  pairedStock: string | null
  totalSupply: bigint
  targetRaise: bigint
  saleSupply: bigint
  gainBps: number
}
export type TradeRow = {
  txHash: Hash
  logIndex: number
  token: Address
  side: "buy" | "sell"
  trader: Address
  amountIn: bigint
  amountOut: bigint
  block: bigint
}
export type CurveRow = {
  token: Address
  progressBps: number
  curveValue: bigint
  target: bigint
  marketCap: bigint
  updatedBlock: bigint
}
export type AthRow = { token: Address; marketCap: bigint; block: bigint }
export type Batch = {
  hooks: HookRow[]
  tokens: TokenRow[]
  bonds: { token: Address; block: bigint }[]
  pools: PoolEntry[]
  trades: TradeRow[]
  curve: CurveRow[]
  /** Tokens whose ath rose in this span, with the ath at the span's end. */
  ath: AthRow[]
  events: EventRow[]
  blocks: { number: bigint; hash: Hash }[]
}
export type SourceDeps = {
  chain: Pick<Chain, "getBlock" | "readLaunchStates" | "readTotalSupplies" | "readErc20Meta">
  registry: HookRegistry
  pools: PoolRegistry
  logger: Logger
  loadLaunches(keys: LaunchKey[]): Promise<KnownLaunch[]>
}

type Item = { log: ChainLog; d: Exclude<DecodedLog, XStocksHookCreated> }

/** Every InkyPump event: one topic0 position matching any of the event signatures. */
const LOG_FILTER: LogFilter = { topics: [LOG_TOPICS] }

/**
 * InkyPump as a loop source. It keeps the hook registry in memory; `reload` seeds the native hooks
 * (idempotent) and rebuilds the registry from the database. It also owns the shared pool registry's
 * lifecycle: it registers pools at bond, rolls back pool trades and ath, and reloads the registry.
 */
export function inkypumpSource(deps: {
  sql: Sql
  chain: SourceDeps["chain"]
  logger: Logger
  pools: PoolRegistry
}): Source<Batch, CurveRow[]> {
  const { sql, chain, logger, pools } = deps
  let registry = new HookRegistry([], logger)
  return {
    name: "inkypump",
    filters: (only) => [pick(only, "inkypump", LOG_FILTER)],
    process: ([logs]) =>
      processLogs(logs ?? [], {
        chain,
        registry,
        pools,
        logger,
        loadLaunches: (keys) => loadLaunches(sql, keys),
      }),
    write: writeRows,
    async prepareRollback(fork) {
      const launches = await launchesToRefresh(sql, fork)
      const states =
        launches.length > 0
          ? await chain.readLaunchStates(
              launches.map((l) => ({ hook: l.hook, launchId: l.launchId })),
              fork,
            )
          : []
      return launches.map((l, i) => {
        const sold = states[i]!.sold
        const value = curveValue(l.params, sold)
        return {
          token: l.token,
          progressBps: progressBps(value, l.params.targetRaise),
          curveValue: value,
          target: l.params.targetRaise,
          marketCap: curveMarketCap(l, sold),
          updatedBlock: fork,
        }
      })
    },
    rollback: rollbackRows,
    async reload() {
      await seedHooks(sql, nativeHookRows())
      registry = new HookRegistry(await loadHooks(sql), logger)
      await pools.load(sql)
    },
  }
}

const keyOf = (hook: string, launchId: string) => `${hook}:${launchId}`

const byPosition = (a: ChainLog, b: ChainLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

export function curveMarketCap(
  l: Pick<KnownLaunch, "params" | "totalSupply">,
  sold: bigint,
): bigint {
  return marketCap(curvePrice(l.params, sold), l.totalSupply)
}

/** Turns one span of InkyPump logs into rows. Reads state only in launch and bond blocks. */
export async function processLogs(input: ChainLog[], deps: SourceDeps): Promise<Batch> {
  const batch: Batch = {
    hooks: [],
    tokens: [],
    bonds: [],
    pools: [],
    trades: [],
    curve: [],
    ath: [],
    events: [],
    blocks: [],
  }
  const athBefore = new Map<Address, bigint>()
  const items = await trustAndDecode([...input].sort(byPosition), deps, batch)

  const createdHere = new Set(
    items
      .filter((i) => i.d.kind === "launchCreated")
      .map((i) => keyOf(i.log.address, i.d.launchId)),
  )
  const missing = new Map<string, LaunchKey>()
  for (const { log, d } of items) {
    const k = keyOf(log.address, d.launchId)
    if ((d.kind === "trade" || d.kind === "launchFinalized") && !createdHere.has(k)) {
      missing.set(k, { hook: log.address, launchId: d.launchId })
    }
  }
  const launches = new Map<string, KnownLaunch>()
  for (const l of await deps.loadLaunches([...missing.values()]))
    launches.set(keyOf(l.hook, l.launchId), l)

  const curve = new Map<Address, CurveRow>()
  for (const [blockNumber, blockItems] of groupByBlock(items)) {
    const created = blockItems.filter(
      (i): i is Item & { d: LaunchCreated } => i.d.kind === "launchCreated",
    )
    const stateKeys = blockItems
      .filter((i) => i.d.kind === "launchCreated" || i.d.kind === "launchFinalized")
      .map((i) => ({ hook: i.log.address, launchId: i.d.launchId }))
    const states = new Map<string, LaunchState>()
    if (stateKeys.length > 0) {
      const read = await deps.chain.readLaunchStates(stateKeys, blockNumber)
      stateKeys.forEach((k, i) => {
        states.set(keyOf(k.hook, k.launchId), read[i]!)
      })
    }
    const supplies =
      created.length > 0
        ? await deps.chain.readTotalSupplies(
            created.map((i) => i.d.token),
            blockNumber,
          )
        : []
    const timestamp = await blockTimestamp(blockItems, blockNumber, deps)
    const blockHash = blockItems[0]!.log.blockHash
    batch.blocks.push({ number: blockNumber, hash: blockHash })

    for (const { log, d } of blockItems) {
      const meta = {
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber,
        blockTimestamp: timestamp,
      }
      const k = keyOf(log.address, d.launchId)

      if (d.kind === "launchCreated") {
        const hook = deps.registry.get(log.address)!
        const state = states.get(k)!
        const totalSupply = supplies[created.findIndex((c) => c.log === log)]!
        const metadata =
          blockItems.find(
            (o): o is Item & { d: LaunchMetadata } =>
              o.d.kind === "launchMetadata" &&
              o.log.transactionHash === log.transactionHash &&
              o.d.launchId === d.launchId,
          )?.d ?? null
        const launch: KnownLaunch = {
          token: d.token,
          hook: hook.address,
          launchId: d.launchId,
          quoteAsset: hook.quoteAsset,
          params: {
            targetRaise: d.targetRaise,
            saleSupply: state.saleSupply,
            gainBps: state.gainBps,
          },
          totalSupply,
          progressBps: 0,
        }
        launches.set(k, launch)
        const event = launchEvent(
          d,
          metadata,
          { hook: hook.address, quoteAsset: hook.quoteAsset, totalSupply },
          meta,
        )
        batch.tokens.push({
          address: d.token,
          hook: hook.address,
          launchId: d.launchId,
          name: event.name,
          ticker: event.ticker,
          creator: d.creator,
          createdBlock: blockNumber,
          createdAt: new Date(timestamp * 1000),
          quoteAsset: hook.quoteAsset,
          pairedStock: hook.kind === "xstocks" ? hook.quoteSymbol : null,
          totalSupply,
          targetRaise: d.targetRaise,
          saleSupply: state.saleSupply,
          gainBps: state.gainBps,
        })
        batch.events.push({ event, block: blockNumber, blockHash })
        curve.set(d.token, {
          token: d.token,
          progressBps: 0,
          curveValue: 0n,
          target: d.targetRaise,
          marketCap: curveMarketCap(launch, 0n),
          updatedBlock: blockNumber,
        })
      } else if (d.kind === "trade") {
        const launch = launches.get(k)
        if (!launch)
          throw new Error(
            `trade for unknown launch ${d.launchId} on ${log.address} in tx ${log.transactionHash}`,
          )
        if (!athBefore.has(launch.token))
          athBefore.set(launch.token, deps.pools.marks(launch.token)?.ath ?? 0n)
        const athMarketCap = deps.pools.bumpAth(
          launch.token,
          marketCap(d.price, launch.totalSupply),
          blockNumber,
        )
        const event = tradeEvent(
          d,
          {
            token: launch.token,
            params: launch.params,
            totalSupply: launch.totalSupply,
            quoteAsset: launch.quoteAsset,
            progressBpsBefore: launch.progressBps,
            athMarketCap,
          },
          meta,
        )
        launch.progressBps = event.progressBpsAfter
        batch.trades.push({
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          token: launch.token,
          side: d.side,
          trader: d.trader,
          amountIn: d.side === "buy" ? d.quoteAmount : d.tokenAmount,
          amountOut: d.side === "buy" ? d.tokenAmount : d.quoteAmount,
          block: blockNumber,
        })
        batch.events.push({ event, block: blockNumber, blockHash })
        curve.set(launch.token, {
          token: launch.token,
          progressBps: event.progressBpsAfter,
          curveValue: BigInt(event.curveValue),
          target: launch.params.targetRaise,
          marketCap: BigInt(event.marketCap),
          updatedBlock: blockNumber,
        })
      } else if (d.kind === "launchFinalized") {
        const launch = launches.get(k)
        if (!launch)
          throw new Error(
            `bond for unknown launch ${d.launchId} on ${log.address} in tx ${log.transactionHash}`,
          )
        const state = states.get(k)!
        if (state.sold !== state.saleSupply) {
          deps.logger("warn", "bond fired with sold != saleSupply", {
            hook: launch.hook,
            launchId: launch.launchId,
            sold: state.sold,
            saleSupply: state.saleSupply,
            tx: log.transactionHash,
          })
        }
        launch.progressBps = 10_000
        batch.bonds.push({ token: launch.token, block: blockNumber })
        const pool: PoolEntry = {
          poolId: d.poolId,
          poolManager: UNISWAP_V4_POOL_MANAGER,
          token: launch.token,
          launchpad: "inkypump",
          quoteAsset: launch.quoteAsset,
          // v4 orders a pool's currencies by address.
          tokenIsCurrency0: launch.token < launch.quoteAsset,
          createdBlock: blockNumber,
        }
        deps.pools.add(pool, launch.totalSupply)
        batch.pools.push(pool)
        batch.events.push({
          event: bondEvent(d, { token: launch.token, quoteAsset: launch.quoteAsset }, meta),
          block: blockNumber,
          blockHash,
        })
        curve.set(launch.token, {
          token: launch.token,
          progressBps: 10_000,
          curveValue: curveValue(launch.params, state.sold),
          target: launch.params.targetRaise,
          marketCap: curve.get(launch.token)?.marketCap ?? curveMarketCap(launch, state.sold),
          updatedBlock: blockNumber,
        })
      }
      // launchMetadata is merged into its launchCreated above.
    }
  }
  batch.curve = [...curve.values()]
  for (const [token, before] of athBefore) {
    const m = deps.pools.marks(token)!
    if (m.ath > before && m.athBlock !== null)
      batch.ath.push({ token, marketCap: m.ath, block: m.athBlock })
  }
  return batch
}

/** Keeps logs from trusted emitters only, registering xStocks hooks from trusted factories in order. */
async function trustAndDecode(logs: ChainLog[], deps: SourceDeps, batch: Batch): Promise<Item[]> {
  const items: Item[] = []
  for (const log of logs) {
    if (log.topics[0] === XSTOCKS_HOOK_CREATED_TOPIC) {
      if (!deps.registry.isFactory(log.address)) {
        deps.registry.warnUnknown(log)
        continue
      }
      const d = decodeLog(log) as XStocksHookCreated
      if (deps.registry.get(d.hook)) continue
      const quote = await deps.chain.readErc20Meta(d.wrapper)
      const row: HookRow = {
        address: d.hook,
        kind: "xstocks",
        abiFamily: "xstocks",
        quoteAsset: d.wrapper,
        quoteDecimals: quote.decimals,
        quoteSymbol: quote.symbol,
        assetId: d.assetId,
        discoveredBlock: log.blockNumber,
      }
      deps.registry.add(row)
      batch.hooks.push(row)
      continue
    }
    if (!deps.registry.get(log.address)) {
      deps.registry.warnUnknown(log)
      continue
    }
    const d = decodeLog(log)
    if (!d || d.kind === "xstocksHookCreated") continue
    items.push({ log, d })
  }
  return items
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

/** Trade events carry the block timestamp; other blocks cost one getBlock. */
async function blockTimestamp(items: Item[], n: bigint, deps: SourceDeps): Promise<number> {
  for (const i of items) if (i.d.kind === "trade") return i.d.timestamp
  const block = await deps.chain.getBlock(n)
  if (!block) throw new BlockNotServedError(n)
  return Number(block.timestamp)
}
