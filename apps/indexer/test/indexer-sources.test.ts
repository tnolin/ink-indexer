import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  CHIMERA_FACTORY,
  NATIVE_QUOTE_ASSET,
  SEADROP_V1,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import type { LogFilter } from "../src/rpc"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { nftSource } from "../src/sources/nft/index"
import { PoolRegistry } from "../src/sources/pools"
import { v4Source } from "../src/sources/v4/index"
import { createStore } from "../src/store"
import { readSources, startSourceServices } from "../src/wiring"
import { FakeChain } from "./fake-chain"
import { FakeStream } from "./opensea/fake-ws"

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

const quiet: Logger = () => {}
const sources = (env: Record<string, string | undefined>) => readSources(env, quiet)

describe("readSources", () => {
  it("enables inkypump, opensea and chimera when unset or empty", () => {
    for (const v of [undefined, "", "  "]) {
      const s = sources({ INDEXER_SOURCES: v })
      expect(s.names).toEqual(["inkypump", "opensea", "chimera"])
      expect(s.openSea).toBe(true)
      expect(s.groups).toEqual(["inkypump", "v4-swaps", "nft-mints", "nft-sales", "nft-launches"])
    }
  })

  it("maps each platform to its backfill groups", () => {
    expect(sources({ INDEXER_SOURCES: "inkypump" })).toMatchObject({
      groups: ["inkypump", "v4-swaps"],
      openSea: false,
    })
    expect(sources({ INDEXER_SOURCES: "opensea" })).toMatchObject({
      groups: ["nft-mints", "nft-sales"],
      openSea: true,
    })
    expect(sources({ INDEXER_SOURCES: "chimera" })).toMatchObject({
      groups: ["nft-launches"],
      openSea: false,
    })
  })

  it("trims whitespace around names and is case-sensitive", () => {
    expect(sources({ INDEXER_SOURCES: " inkypump , chimera " }).names).toEqual([
      "inkypump",
      "chimera",
    ])
    expect(() => sources({ INDEXER_SOURCES: "InkyPump" })).toThrow(/unknown platform: InkyPump/)
  })

  it("rejects an unknown name, naming the allowed ones", () => {
    expect(() => sources({ INDEXER_SOURCES: "inkypump,bogus" })).toThrow(
      "INDEXER_SOURCES: unknown platform: bogus (expected inkypump, opensea, chimera)",
    )
  })

  it("rejects a duplicate and an empty entry", () => {
    expect(() => sources({ INDEXER_SOURCES: "opensea,opensea" })).toThrow(/duplicate.*opensea/)
    for (const v of [",", "inkypump,", "inkypump,,chimera"])
      expect(() => sources({ INDEXER_SOURCES: v }), v).toThrow(/empty/)
  })

  it("logs what runs", () => {
    const seen: unknown[][] = []
    readSources({ INDEXER_SOURCES: "inkypump,chimera" }, (...a) => void seen.push(a))
    expect(seen).toEqual([["info", "sources", { running: ["inkypump", "chimera"] }]])
  })
})

describe("the live tick with INDEXER_SOURCES", () => {
  const TOKEN: Address = "0x00000000000000000000000000000000000000d1"
  const POOL: Hash = `0x${"d1".repeat(32)}`

  /** The filters the live tick asks for, over every source, with one registered pool. */
  async function liveFilters(env: Record<string, string | undefined>) {
    const chain = new FakeChain(1000n)
    const asked: LogFilter[] = []
    const getLogs = chain.getLogs.bind(chain)
    chain.getLogs = (from, to, filter) => {
      asked.push(filter)
      return getLogs(from, to, filter)
    }
    const store = createStore(sql)
    const pools = new PoolRegistry()
    await store.writeBatch([], [], {
      cursor: { block: 990n, hash: chain.hashOf(990n) },
      head: 990n,
    })
    const idx = new Indexer({
      chain,
      store,
      logger: quiet,
      only: sources(env).groups,
      sources: [
        inkypumpSource({ sql, chain, pools, logger: quiet }),
        v4Source({ sql, chain, pools, logger: quiet }),
        nftSource({ sql, chain, logger: quiet }),
      ],
    })
    await idx.init()
    // init loads the registry from the empty database; a pool registered afterwards keeps both v4 filters on.
    pools.add(
      {
        poolId: POOL,
        poolManager: UNISWAP_V4_POOL_MANAGER,
        token: TOKEN,
        launchId: POOL,
        launchpad: "inkypump",
        quoteAsset: NATIVE_QUOTE_ASSET,
        tokenIsCurrency0: false,
        createdBlock: 1n,
      },
      10n ** 27n,
    )
    await idx.tick()
    return asked
  }

  it("reads every filter by default, in 7 requests", async () => {
    expect(await liveFilters({})).toHaveLength(7)
  })

  it("inkypump alone reads its own and the two v4 filters and no NFT filter, in 3 requests", async () => {
    const asked = await liveFilters({ INDEXER_SOURCES: "inkypump" })
    expect(asked).toHaveLength(3)
    expect(asked.filter((f) => f.address === UNISWAP_V4_POOL_MANAGER)).toHaveLength(1)
    expect(asked.filter((f) => JSON.stringify(f.address) === JSON.stringify([TOKEN]))).toHaveLength(
      1,
    )
  })

  it("inkypump,chimera reads only the Chimera filter of the NFT source, in 4 requests", async () => {
    const asked = await liveFilters({ INDEXER_SOURCES: "inkypump,chimera" })
    expect(asked).toHaveLength(4)
    expect(asked.filter((f) => f.address === CHIMERA_FACTORY)).toHaveLength(1)
    expect(asked.some((f) => f.address === SEADROP_V1)).toBe(false)
  })

  it("opensea alone reads the mint and sale filters in 4 requests", async () => {
    expect(await liveFilters({ INDEXER_SOURCES: "opensea" })).toHaveLength(4)
  })
})

describe("startSourceServices", () => {
  const deps = (env: Record<string, string>, calls: string[], server: FakeStream) => ({
    env,
    sql,
    store: createStore(sql),
    chain: new FakeChain(100n),
    log: quiet as Logger,
    report: () => {},
    fetch: async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response("{}", { status: 200 })
    },
    socket: server.factory,
    tickMs: 10,
  })

  it("does not start the NFT services when opensea is off", async () => {
    const calls: string[] = []
    const server = new FakeStream()
    const warnings: string[] = []
    const d = deps({ OPENSEA_API_KEY: "wiring-test-key-0123456789" }, calls, server)
    d.log = (level, msg) => void (level === "warn" && warnings.push(msg))
    const services = await startSourceServices(sources({ INDEXER_SOURCES: "inkypump,chimera" }), d)
    await new Promise((r) => setTimeout(r, 100))
    services.stop()
    expect(calls).toEqual([])
    expect(server.sockets).toEqual([])
    // Not even the keyless warning: startNftServices never ran.
    const keyless = await startSourceServices(sources({ INDEXER_SOURCES: "inkypump" }), {
      ...d,
      env: {},
    })
    keyless.stop()
    expect(warnings).toEqual([])
  })

  it("starts them when opensea is on", async () => {
    const warnings: string[] = []
    const d = deps({}, [], new FakeStream())
    d.log = (level, msg) => void (level === "warn" && warnings.push(msg))
    const services = await startSourceServices(sources({}), d)
    services.stop()
    expect(warnings).toEqual([
      "OPENSEA_API_KEY is not set: OpenSea collections, drops, stats and listings are off",
    ])
  })
})
