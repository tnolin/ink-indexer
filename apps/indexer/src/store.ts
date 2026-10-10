import type { Sql } from "@ink-indexer/db"
import type { AbiFamily, LaunchKey } from "@ink-indexer/sdk"
import type postgres from "postgres"
import type { Address, Hash } from "viem"
import type { HookRow } from "./sources/inkypump/hooks"
import type { Batch, CurveRow, KnownLaunch } from "./sources/inkypump/index"

export type Cursor = { block: bigint; hash: Hash }

const SOURCE = "inkypump"
const RECENT_BLOCKS = 128
const s = (x: bigint) => x.toString()
/** Rows per multi-row insert: Postgres allows 65,534 parameters per statement, so 1,000 rows leaves room for 65 columns. */
const CHUNK = 1_000
function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK)
}

type HookRecord = {
  address: Address
  kind: "native" | "xstocks"
  abi_family: AbiFamily
  quote_asset: Address
  quote_decimals: number
  quote_symbol: string | null
  asset_id: Hash | null
  discovered_block: bigint
}
type LaunchRecord = {
  address: Address
  hook: Address
  launch_id: Hash
  quote_asset: Address
  total_supply: string
  target_raise: string
  sale_supply: string
  gain_bps: number
  progress_bps: number
}

const hookRecord = (r: HookRow) => ({
  address: r.address,
  launchpad: SOURCE,
  kind: r.kind,
  abi_family: r.abiFamily,
  quote_asset: r.quoteAsset,
  quote_decimals: r.quoteDecimals,
  quote_symbol: r.quoteSymbol,
  asset_id: r.assetId,
  discovered_block: s(r.discoveredBlock),
})

const curveRecord = (c: CurveRow) => ({
  token: c.token,
  progress_bps: c.progressBps,
  curve_value: s(c.curveValue),
  target: s(c.target),
  market_cap: s(c.marketCap),
  updated_block: s(c.updatedBlock),
})

const toKnownLaunch = (r: LaunchRecord): KnownLaunch => ({
  token: r.address,
  hook: r.hook,
  launchId: r.launch_id,
  quoteAsset: r.quote_asset,
  params: {
    targetRaise: BigInt(r.target_raise),
    saleSupply: BigInt(r.sale_supply),
    gainBps: r.gain_bps,
  },
  totalSupply: BigInt(r.total_supply),
  progressBps: r.progress_bps,
})

export function createStore(sql: Sql) {
  return {
    async seedHooks(rows: HookRow[]) {
      if (rows.length > 0)
        await sql`insert into indexer.hooks ${sql(rows.map(hookRecord))} on conflict (address) do nothing`
    },

    async loadHooks(): Promise<HookRow[]> {
      const rows = await sql<HookRecord[]>`select * from indexer.hooks`
      return rows.map((r) => ({
        address: r.address,
        kind: r.kind,
        abiFamily: r.abi_family,
        quoteAsset: r.quote_asset,
        quoteDecimals: r.quote_decimals,
        quoteSymbol: r.quote_symbol,
        assetId: r.asset_id,
        discoveredBlock: BigInt(r.discovered_block),
      }))
    },

    async loadLaunches(keys: LaunchKey[]): Promise<KnownLaunch[]> {
      if (keys.length === 0) return []
      const rows = await sql<LaunchRecord[]>`
        select t.address, t.hook, t.launch_id, t.quote_asset, t.total_supply, t.target_raise, t.sale_supply,
               t.gain_bps, coalesce(c.progress_bps, 0) as progress_bps
        from indexer.tokens t left join indexer.curve_state c on c.token = t.address
        where t.hook || ':' || t.launch_id in ${sql(keys.map((k) => `${k.hook}:${k.launchId}`))}`
      return rows.map(toKnownLaunch)
    },

    /** Launches created at or before `fork` whose curve state changed after it. */
    async launchesToRefresh(fork: bigint): Promise<KnownLaunch[]> {
      const rows = await sql<LaunchRecord[]>`
        select t.address, t.hook, t.launch_id, t.quote_asset, t.total_supply, t.target_raise, t.sale_supply,
               t.gain_bps, c.progress_bps
        from indexer.tokens t join indexer.curve_state c on c.token = t.address
        where t.created_block <= ${s(fork)} and c.updated_block > ${s(fork)}`
      return rows.map(toKnownLaunch)
    },

    async getCursor(): Promise<Cursor | null> {
      const [r] = await sql<{ block: bigint; block_hash: Hash }[]>`
        select block, block_hash from indexer.cursors where source = ${SOURCE}`
      return r ? { block: BigInt(r.block), hash: r.block_hash } : null
    },

    async recentBlocks(): Promise<{ number: bigint; hash: Hash }[]> {
      const rows = await sql<{ number: bigint; hash: Hash }[]>`
        select number, hash from indexer.recent_blocks order by number desc`
      return rows.map((r) => ({ number: BigInt(r.number), hash: r.hash }))
    },

    /** One transaction. With `cursor: null` (backfill) the live cursor and recent hashes are left alone. */
    async writeBatch(batch: Batch, opts: { cursor: Cursor | null; head: bigint }) {
      await sql.begin(async (tx) => {
        // Confirm older rows in the same commit that adds newer confirmed ones, so a reader of
        // `confirmed and id > $1` can never pass an unconfirmed row that is old enough to confirm.
        await tx`update indexer.events set confirmed = true where not confirmed and block <= ${s(opts.head - 1n)}`
        for (const part of chunks(batch.hooks.map(hookRecord))) {
          await tx`insert into indexer.hooks ${tx(part)} on conflict (address) do nothing`
        }
        {
          const rows = batch.tokens.map((t) => ({
            address: t.address,
            launchpad: SOURCE,
            hook: t.hook,
            launch_id: t.launchId,
            name: t.name,
            ticker: t.ticker,
            creator: t.creator,
            created_block: s(t.createdBlock),
            created_at: t.createdAt,
            quote_asset: t.quoteAsset,
            paired_stock: t.pairedStock,
            total_supply: s(t.totalSupply),
            target_raise: s(t.targetRaise),
            sale_supply: s(t.saleSupply),
            gain_bps: t.gainBps,
          }))
          for (const part of chunks(rows))
            await tx`insert into indexer.tokens ${tx(part)} on conflict (address) do nothing`
        }
        for (const b of batch.bonds) {
          await tx`update indexer.tokens set phase = 'bonded', bonded_block = ${s(b.block)} where address = ${b.token}`
        }
        for (const part of chunks(batch.curve.map(curveRecord))) {
          await tx`
            insert into indexer.curve_state ${tx(part)}
            on conflict (token) do update set
              progress_bps = excluded.progress_bps, curve_value = excluded.curve_value, target = excluded.target,
              market_cap = excluded.market_cap, updated_block = excluded.updated_block
            where indexer.curve_state.updated_block <= excluded.updated_block`
        }
        {
          const rows = batch.trades.map((t) => ({
            tx_hash: t.txHash,
            log_index: t.logIndex,
            token: t.token,
            side: t.side,
            trader: t.trader,
            amount_in: s(t.amountIn),
            amount_out: s(t.amountOut),
            block: s(t.block),
            venue: "curve",
          }))
          for (const part of chunks(rows))
            await tx`insert into indexer.trades ${tx(part)} on conflict do nothing`
        }
        {
          const rows = batch.events.map((e) => ({
            type: e.event.type,
            entity: e.event.token,
            payload: tx.json(e.event as unknown as postgres.JSONValue),
            block: s(e.block),
            block_hash: e.blockHash,
            tx_hash: e.event.txHash,
            log_index: e.event.logIndex,
            confirmed: e.block <= opts.head - 1n,
          }))
          for (const part of chunks(rows))
            await tx`insert into indexer.events ${tx(part)} on conflict (tx_hash, log_index) do nothing`
        }
        if (opts.cursor) {
          const blocks = new Map(batch.blocks.map((b) => [b.number, b.hash]))
          blocks.set(opts.cursor.block, opts.cursor.hash)
          const rows = [...blocks].map(([number, hash]) => ({ number: s(number), hash }))
          for (const part of chunks(rows))
            await tx`insert into indexer.recent_blocks ${tx(part)} on conflict (number) do update set hash = excluded.hash`
          await tx`
            delete from indexer.recent_blocks where number not in
              (select number from indexer.recent_blocks order by number desc limit ${RECENT_BLOCKS})`
          await tx`
            insert into indexer.cursors (source, block, block_hash)
            values (${SOURCE}, ${s(opts.cursor.block)}, ${opts.cursor.hash})
            on conflict (source) do update set block = excluded.block, block_hash = excluded.block_hash`
        }
      })
    },

    async confirm(head: bigint) {
      await sql`update indexer.events set confirmed = true where not confirmed and block <= ${s(head - 1n)}`
    },

    async rollback(fork: bigint, forkHash: Hash, refreshed: CurveRow[]) {
      const f = s(fork)
      await sql.begin(async (tx) => {
        await tx`delete from indexer.events where block > ${f}`
        await tx`delete from indexer.trades where block > ${f}`
        await tx`delete from indexer.tokens where created_block > ${f}`
        await tx`delete from indexer.hooks where kind = 'xstocks' and discovered_block > ${f}`
        await tx`update indexer.tokens set phase = 'curve', bonded_block = null where bonded_block > ${f}`
        for (const c of refreshed) {
          await tx`
            update indexer.curve_state set progress_bps = ${c.progressBps}, curve_value = ${s(c.curveValue)},
              market_cap = ${s(c.marketCap)}, updated_block = ${s(c.updatedBlock)}
            where token = ${c.token}`
        }
        await tx`delete from indexer.recent_blocks where number > ${f}`
        await tx`update indexer.cursors set block = ${f}, block_hash = ${forkHash} where source = ${SOURCE}`
      })
    },
  }
}

export type Store = ReturnType<typeof createStore>
