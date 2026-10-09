import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { INKYPUMP_START_BLOCK as S } from "@ink-indexer/sdk"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { Indexer } from "../src/loop"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"
import { bond, HOOK, launch, launchIdOf, stateFor, tokenOf, trade, xstocksHook } from "./scenario"

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

async function indexerFor(chain: FakeChain) {
  const warnings: string[] = []
  const idx = new Indexer({
    chain,
    store,
    logger: (level, msg) => {
      if (level === "warn") warnings.push(msg)
    },
  })
  await idx.init()
  return { idx, warnings }
}

const count = async (table: string) =>
  Number((await sql.unsafe(`select count(*)::int as n from indexer.${table}`))[0]!.n)
const eventTypes = async () =>
  (await sql<{ type: string }[]>`select type from indexer.events order by id`).map((r) => r.type)
const LAUNCH_KEY = `${HOOK}:${launchIdOf(1)}`

describe("Indexer", () => {
  it("backfills from the start block in spans, reading state only at launch and bond", async () => {
    const chain = new FakeChain(S + 2_500n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 1_500n, sold: 4n * 10n ** 26n })
    bond(chain, { n: 1, block: S + 2_500n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()

    expect(chain.getLogsCalls).toEqual([
      [S, S + 999n],
      [S + 1_000n, S + 1_999n],
      [S + 2_000n, S + 2_500n],
    ])
    expect(chain.stateReads).toEqual([S + 10n, S + 2_500n])
    expect(await sql`select type, confirmed from indexer.events order by id`).toEqual([
      { type: "launchpad.launch", confirmed: true },
      { type: "launchpad.trade", confirmed: true },
      { type: "launchpad.bond", confirmed: false },
    ])
    expect(await store.getCursor()).toEqual({ block: S + 2_500n, hash: chain.hashOf(S + 2_500n) })
    expect((await sql`select phase from indexer.tokens`)[0]!.phase).toBe("bonded")
  })

  it("re-scans a range without duplicates or moving the cursor", async () => {
    const chain = new FakeChain(S + 2_500n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 1_500n, sold: 1n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()
    const cursor = await store.getCursor()
    await idx.backfill(S)
    expect([await count("events"), await count("trades"), await count("tokens")]).toEqual([2, 1, 1])
    expect(await store.getCursor()).toEqual(cursor)
  })

  it("follows new heads and confirms one block later", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()
    chain.head = S + 105n
    trade(chain, { n: 1, block: S + 105n, sold: 1n })
    await idx.trigger()
    expect(
      (await sql`select confirmed from indexer.events order by id`).map((r) => r.confirmed),
    ).toEqual([true, false])
    chain.head = S + 106n
    await idx.trigger()
    expect((await sql`select bool_and(confirmed) as ok from indexer.events`)[0]!.ok).toBe(true)
  })

  it("folds concurrent triggers into one extra tick", async () => {
    const chain = new FakeChain(S + 10n)
    const { idx } = await indexerFor(chain)
    await Promise.all([idx.trigger(), idx.trigger(), idx.trigger()])
    expect(chain.getBlockNumberCalls).toBe(2)
  })

  it("loses no logs when the log transport lags the head by 2 blocks", async () => {
    const chain = new FakeChain(S + 100n)
    chain.logLag = 2n
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 99n, sold: 1n })
    trade(chain, { n: 1, block: S + 100n, sold: 2n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()

    expect(chain.getLogsCalls).toEqual([
      [S, S + 98n],
      [S + 99n, S + 100n],
    ])
    expect(await eventTypes()).toEqual(["launchpad.launch", "launchpad.trade", "launchpad.trade"])
    expect(await store.getCursor()).toEqual({ block: S + 100n, hash: chain.hashOf(S + 100n) })
  })

  it("rolls back a one-block reorg and re-ingests the new block", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 100n, sold: 4n * 10n ** 26n })
    const { idx, warnings } = await indexerFor(chain)
    await idx.trigger()

    chain.reorg(S + 100n)
    trade(chain, { n: 1, block: S + 100n, sold: 2n * 10n ** 26n })
    chain.states.set(LAUNCH_KEY, stateFor(tokenOf(1), 0n)) // state at the fork block
    await idx.trigger()

    expect(await eventTypes()).toEqual(["launchpad.launch", "launchpad.trade"])
    expect(
      (
        await sql`select payload->>'progressBpsAfter' as p from indexer.events where type = 'launchpad.trade'`
      )[0]!.p,
    ).toBe("2500")
    expect((await sql`select progress_bps from indexer.curve_state`)[0]!.progress_bps).toBe(2500)
    expect(await store.getCursor()).toEqual({ block: S + 100n, hash: chain.hashOf(S + 100n) })
    expect(warnings).toContain("reorg: rolled back to fork block")
  })

  it("rolls back a five-block reorg, un-bonds and restores curve state from the fork block", async () => {
    const chain = new FakeChain(S + 200n)
    launch(chain, { n: 1, block: S + 10n })
    trade(chain, { n: 1, block: S + 100n, sold: 2n * 10n ** 26n })
    trade(chain, { n: 1, block: S + 197n, sold: 4n * 10n ** 26n })
    bond(chain, { n: 1, block: S + 199n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()

    chain.reorg(S + 196n)
    chain.states.set(LAUNCH_KEY, stateFor(tokenOf(1), 2n * 10n ** 26n))
    await idx.trigger()

    expect(await eventTypes()).toEqual(["launchpad.launch", "launchpad.trade"])
    expect(await sql`select phase, bonded_block from indexer.tokens`).toEqual([
      { phase: "curve", bonded_block: null },
    ])
    expect(await sql`select progress_bps, updated_block from indexer.curve_state`).toEqual([
      { progress_bps: 2500, updated_block: S + 100n },
    ])
    expect(chain.stateReads.at(-1)).toBe(S + 100n)
  })

  it("stops instead of guessing when no stored block hash matches", async () => {
    const chain = new FakeChain(S + 100n)
    launch(chain, { n: 1, block: S + 10n })
    const { idx } = await indexerFor(chain)
    await idx.trigger()
    chain.reorg(S)
    await expect(idx.trigger()).rejects.toThrow(/refusing to guess/)
  })

  it("reloads the hook registry when a batch write fails, so the retry persists the new hook", async () => {
    const XHOOK = "0x799def4ec4a0a293a59b53a6479afc5a9df76ac4" as const
    const WRAPPER = "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171" as const
    const chain = new FakeChain(S + 100n)
    chain.erc20.set(WRAPPER, { decimals: 18, symbol: "TSLAx" })
    xstocksHook(chain, { block: S + 10n, hook: XHOOK, wrapper: WRAPPER })
    launch(chain, { n: 1, block: S + 20n, hook: XHOOK })
    let failed = false
    const flaky: Store = {
      ...store,
      writeBatch: async (...args) => {
        if (!failed) {
          failed = true
          throw new Error("db down")
        }
        return store.writeBatch(...args)
      },
    }
    const idx = new Indexer({ chain, store: flaky, logger: () => {} })
    await idx.init()
    await expect(idx.trigger()).rejects.toThrow("db down")
    await idx.trigger()

    expect((await sql`select address from indexer.hooks where address = ${XHOOK}`).length).toBe(1)
    expect(await eventTypes()).toEqual(["launchpad.launch"])
  })
})
