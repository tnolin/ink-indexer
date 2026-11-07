import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { type HookitFixtureName, loadHookitFixture } from "../../../packages/sdk/test/fixtures"
import { Indexer } from "../src/loop"
import { hookitSource } from "../src/sources/hookit/index"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import { v4Source } from "../src/sources/v4/index"
import { createStore } from "../src/store"
import { FakeChain } from "./fake-chain"
import { addFixture } from "./hookit-scenario"

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

const GATEWAY = "https://gw.example"
const doc = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../packages/sdk/test/fixtures", "hookit-metadata-hkt.json"),
    "utf8",
  ),
)

/** The recorded $HKT launch and first swap on a chain, with the reads that answer for the token. */
function chainOf() {
  const chain = new FakeChain(61_000_000n)
  const launch = loadHookitFixture("hookit-hkt-launch")
  const first = loadHookitFixture("hookit-hkt-first-swap")
  for (const f of [launch, first]) {
    addFixture(chain, f)
    for (const t of f.tokens) {
      chain.supplies.set(t.token, t.totalSupply)
      chain.metadataUris.set(t.token, t.metadataURI)
      chain.erc20Names.set(t.token, { name: "HOOKIT", symbol: "HKT" })
    }
  }
  return { chain, launch, first }
}

/** The sources in the order `main.ts` runs them: launch sources before the v4 source. */
function indexerOn(chain: FakeChain, db: Sql) {
  const pools = new PoolRegistry()
  const logger = () => {}
  const cid = loadHookitFixture("hookit-hkt-launch").tokens[0]!.metadataURI.replace("ipfs://", "")
  return new Indexer({
    chain,
    store: createStore(db),
    logger,
    sources: [
      inkypumpSource({ sql: db, chain, logger, pools }),
      hookitSource({
        sql: db,
        chain,
        logger,
        pools,
        ipfs: {
          gateway: GATEWAY,
          fetch: (async (url: string) =>
            url.endsWith(cid)
              ? Response.json(doc)
              : new Response("", { status: 404 })) as typeof fetch,
        },
        report: { warn: () => {} },
      }),
      v4Source({ sql: db, chain, logger, pools }),
    ],
  })
}

const swapsOf = async (db: Sql) =>
  db`select tx_hash, log_index, payload from indexer.events where type = 'launchpad.swap' order by block, log_index`

describe("backfill from an empty registry", () => {
  it("writes the swaps of a pool registered in the span it starts with", async () => {
    // The control registers the pool in an earlier span, so every swap lies in a span that asks for it.
    const control = chainOf()
    const a = indexerOn(control.chain, sql)
    await a.init()
    await a.backfill(control.launch.blockNumber, control.launch.blockNumber)
    await a.backfill(control.launch.blockNumber + 1n, control.first.blockNumber)
    const expected = await swapsOf(sql)
    expect(expected.length).toBeGreaterThan(0)

    await sql.end()
    sql = await resetDb(inject("databaseUrl"))
    const { chain, launch, first } = chainOf()
    const b = indexerOn(chain, sql)
    await b.init()
    await b.backfill(launch.blockNumber, first.blockNumber)
    expect(await swapsOf(sql)).toEqual(expected)
  })

  it("makes no request for the v4 source while nothing is registered", async () => {
    const { chain, launch } = chainOf()
    const pools = new PoolRegistry()
    const idx = new Indexer({
      chain,
      store: createStore(sql),
      logger: () => {},
      sources: [v4Source({ sql, chain, logger: () => {}, pools })],
    })
    await idx.init()
    await idx.backfill(launch.blockNumber, launch.blockNumber + 5n)
    expect(chain.getLogsCalls).toEqual([])
    expect(await swapsOf(sql)).toEqual([])
  })

  it("does not read for the v4 source when a backfill names other sources", async () => {
    const { chain, launch, first } = chainOf()
    const idx = indexerOn(chain, sql)
    await idx.init()
    await idx.backfill(launch.blockNumber, first.blockNumber, ["hookit"])
    expect(await swapsOf(sql)).toEqual([])
  })
})

export type { HookitFixtureName }
