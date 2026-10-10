import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { NATIVE_QUOTE_ASSET } from "@ink-indexer/sdk"
import { type Hash, pad, toHex } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { HookRegistry, nativeHookRows } from "../src/sources/inkypump/hooks"
import { type Batch, processLogs } from "../src/sources/inkypump/index"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import { bond, HOOK, launch, launchIdOf, PARAMS, tokenOf, trade } from "./scenario"

const B = 45_290_000n
let sql: Sql
let store: Store

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  await store.seedHooks(nativeHookRows())
})
afterEach(() => sql.end())

const emptyBatch = (): Batch => ({
  hooks: [],
  tokens: [],
  bonds: [],
  trades: [],
  curve: [],
  events: [],
  blocks: [],
})

async function batchFrom(chain: FakeChain): Promise<Batch> {
  return processLogs(chain.logsIn(0n, chain.head), {
    chain,
    registry: new HookRegistry(await store.loadHooks(), () => {}),
    logger: () => {},
    loadLaunches: (keys) => store.loadLaunches(keys),
  })
}

const count = async (table: string) =>
  Number((await sql.unsafe(`select count(*)::int as n from indexer.${table}`))[0]!.n)

describe("store", () => {
  it("writes a batch, confirms by head and reloads launches", async () => {
    const chain = new FakeChain(B + 10n)
    launch(chain, { n: 1, block: B })
    trade(chain, { n: 1, block: B + 10n, sold: 4n * 10n ** 26n })
    const cursor = { block: B + 10n, hash: chain.hashOf(B + 10n) }
    await store.writeBatch(await batchFrom(chain), { cursor, head: B + 10n })

    expect(await sql`select type, confirmed from indexer.events order by id`).toEqual([
      { type: "launchpad.launch", confirmed: true },
      { type: "launchpad.trade", confirmed: false },
    ])
    expect(await store.getCursor()).toEqual(cursor)
    expect(await store.loadLaunches([{ hook: HOOK, launchId: launchIdOf(1) }])).toEqual([
      {
        token: tokenOf(1),
        hook: HOOK,
        launchId: launchIdOf(1),
        quoteAsset: NATIVE_QUOTE_ASSET,
        params: PARAMS,
        totalSupply: 10n ** 27n,
        progressBps: 5000,
      },
    ])
    await store.confirm(B + 11n)
    expect((await sql`select bool_and(confirmed) as ok from indexer.events`)[0]!.ok).toBe(true)
  })

  it("is idempotent when the same batch is written twice", async () => {
    const chain = new FakeChain(B + 10n)
    launch(chain, { n: 1, block: B })
    trade(chain, { n: 1, block: B + 10n, sold: 1n })
    const batch = await batchFrom(chain)
    await store.writeBatch(batch, { cursor: null, head: B + 10n })
    await store.writeBatch(batch, { cursor: null, head: B + 10n })
    expect([await count("events"), await count("trades"), await count("tokens")]).toEqual([2, 1, 1])
  })

  it("never moves curve state backwards", async () => {
    const chain = new FakeChain(B + 10n)
    launch(chain, { n: 1, block: B })
    trade(chain, { n: 1, block: B + 10n, sold: 4n * 10n ** 26n })
    await store.writeBatch(await batchFrom(chain), { cursor: null, head: B + 10n })
    const older = {
      token: tokenOf(1),
      progressBps: 100,
      curveValue: 1n,
      target: 1n,
      marketCap: 1n,
      updatedBlock: B + 5n,
    }
    await store.writeBatch({ ...emptyBatch(), curve: [older] }, { cursor: null, head: B + 10n })
    expect((await sql`select progress_bps from indexer.curve_state`)[0]!.progress_bps).toBe(5000)
  })

  it("keeps only the newest 128 block hashes", async () => {
    const blocks = Array.from({ length: 130 }, (_, i) => ({
      number: BigInt(i + 1),
      hash: pad(toHex(i + 1), { size: 32 }) as Hash,
    }))
    await store.writeBatch(
      { ...emptyBatch(), blocks },
      { cursor: { block: 130n, hash: blocks[129]!.hash }, head: 130n },
    )
    const recent = await store.recentBlocks()
    expect(recent).toHaveLength(128)
    expect(recent[0]!.number).toBe(130n)
    expect(recent.at(-1)!.number).toBe(3n)
  })

  it("rolls back everything above a fork block", async () => {
    const chain = new FakeChain(B + 8n)
    launch(chain, { n: 1, block: B })
    trade(chain, { n: 1, block: B + 5n, sold: 4n * 10n ** 26n })
    bond(chain, { n: 1, block: B + 8n })
    await store.writeBatch(await batchFrom(chain), {
      cursor: { block: B + 8n, hash: chain.hashOf(B + 8n) },
      head: B + 8n,
    })

    expect((await store.launchesToRefresh(B + 4n)).map((l) => l.token)).toEqual([tokenOf(1)])
    const refreshed = [
      {
        token: tokenOf(1),
        progressBps: 0,
        curveValue: 0n,
        target: 10n ** 18n,
        marketCap: 1n,
        updatedBlock: B + 4n,
      },
    ]
    await store.rollback(B + 4n, chain.hashOf(B + 4n), refreshed)

    expect(await sql`select type from indexer.events`).toEqual([{ type: "launchpad.launch" }])
    expect(await count("trades")).toBe(0)
    expect(await sql`select phase, bonded_block from indexer.tokens`).toEqual([
      { phase: "curve", bonded_block: null },
    ])
    expect(await sql`select progress_bps, updated_block from indexer.curve_state`).toEqual([
      { progress_bps: 0, updated_block: B + 4n },
    ])
    expect(await store.getCursor()).toEqual({ block: B + 4n, hash: chain.hashOf(B + 4n) })
    expect((await store.recentBlocks()).every((b) => b.number <= B + 4n)).toBe(true)
  })

  it("writes a span larger than one statement's parameter limit, idempotently", async () => {
    const chain = new FakeChain(B + 10n)
    launch(chain, { n: 1, block: B })
    trade(chain, { n: 1, block: B + 10n, sold: 1n })
    const base = await batchFrom(chain)
    const tx = (i: number) => pad(toHex(i + 1), { size: 32 }) as Hash
    const addr = (i: number) => pad(toHex(i + 1000), { size: 20 }) as `0x${string}`
    const trade0 = base.trades[0]!
    const launchEvent = base.events[0]!
    const batch: Batch = {
      ...base,
      tokens: [
        ...base.tokens,
        ...Array.from({ length: 4_500 }, (_, i) => ({
          ...base.tokens[0]!,
          address: addr(i),
          launchId: tx(i + 100_000),
        })),
      ],
      trades: Array.from({ length: 7_500 }, (_, i) => ({ ...trade0, txHash: tx(i), logIndex: i })),
      events: Array.from({ length: 8_500 }, (_, i) => ({
        ...launchEvent,
        event: { ...launchEvent.event, txHash: tx(i), logIndex: i },
      })),
    }
    const cursor = { block: B + 10n, hash: chain.hashOf(B + 10n) }
    await store.writeBatch(batch, { cursor, head: B + 10n })
    await store.writeBatch(batch, { cursor, head: B + 10n })
    expect([await count("tokens"), await count("trades"), await count("events")]).toEqual([
      4_501, 7_500, 8_500,
    ])
  })
})
