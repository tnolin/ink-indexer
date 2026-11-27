import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  CCA_AUCTION_TOPICS,
  CCA_FACTORY,
  CCA_TOPICS,
  CHIMERA_FACTORY,
  HOOKIT_TOPICS,
  INKFUN_TOPICS,
  NATIVE_QUOTE_ASSET,
  NFTX_LOCKER,
  NFTX_TOPICS,
  SEADROP_V1,
  TSUNAMI_TOPICS,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import type { LogFilter } from "../src/rpc"
import { hookitSource } from "../src/sources/hookit/index"
import { inkfunSource } from "../src/sources/inkfun/index"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { nftSource } from "../src/sources/nft/index"
import { nftxSource } from "../src/sources/nftx/index"
import type { Ranks } from "../src/sources/opensea/ranks"
import { PoolRegistry } from "../src/sources/pools"
import { BACKFILL_SOURCES, LAUNCHPAD_SOURCES, SOURCE_GROUPS } from "../src/sources/source"
import { tsunamiSource } from "../src/sources/tsunami/index"
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
  it("enables every platform when unset or empty", () => {
    for (const v of [undefined, "", "  "]) {
      const s = sources({ INDEXER_SOURCES: v })
      expect(s.names).toEqual([
        "inkypump",
        "opensea",
        "chimera",
        "inkfun",
        "tsunami",
        "hookit",
        "nftx",
      ])
      expect(s.openSea).toBe(true)
      expect(s.groups).toEqual([
        "inkypump",
        "v4-swaps",
        "nft-mints",
        "nft-sales",
        "nft-launches",
        "inkfun",
        "tsunami",
        "hookit",
        "nftx",
      ])
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
    expect(sources({ INDEXER_SOURCES: "inkfun" })).toMatchObject({
      groups: ["inkfun", "v4-swaps"],
      openSea: false,
    })
    expect(sources({ INDEXER_SOURCES: "hookit" })).toMatchObject({
      groups: ["hookit", "v4-swaps"],
      openSea: false,
    })
    expect(sources({ INDEXER_SOURCES: "nftx" })).toMatchObject({
      groups: ["nftx"],
      openSea: false,
    })
  })

  it("says whether the NFTX source runs", () => {
    expect(sources({ INDEXER_SOURCES: undefined }).nftx).toBe(true)
    expect(sources({ INDEXER_SOURCES: "nftx,opensea" }).nftx).toBe(true)
    expect(sources({ INDEXER_SOURCES: "opensea,chimera" }).nftx).toBe(false)
  })

  it("lists a shared backfill group once", () => {
    expect(sources({ INDEXER_SOURCES: "inkypump,inkfun" }).groups).toEqual([
      "inkypump",
      "v4-swaps",
      "inkfun",
    ])
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
      "INDEXER_SOURCES: unknown platform: bogus (expected inkypump, opensea, chimera, inkfun, tsunami, hookit, nftx)",
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
  async function liveFilters(env: Record<string, string | undefined>, registered = true) {
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
        inkfunSource({ sql, chain, pools, logger: quiet, ipfs: { gateway: "https://gw.example" } }),
        tsunamiSource({
          sql,
          chain,
          pools,
          logger: quiet,
          ipfs: { gateway: "https://gw.example" },
        }),
        hookitSource({
          sql,
          chain,
          pools,
          logger: quiet,
          ipfs: { gateway: "https://gw.example" },
        }),
        v4Source({ sql, chain, pools, logger: quiet }),
        nftSource({ sql, chain, logger: quiet }),
        nftxSource({ sql, chain, logger: quiet }),
      ],
    })
    await idx.init()
    // init loads the registry from the empty database; a pool registered afterwards keeps both v4 filters on.
    if (registered)
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

  it("inkfun alone reads one filter while no pool is registered, and ink.fun's merges with InkyPump's", async () => {
    expect(await liveFilters({ INDEXER_SOURCES: "inkfun" }, false)).toHaveLength(1)
    const withPool = await liveFilters({ INDEXER_SOURCES: "inkfun" })
    expect(withPool).toHaveLength(3)
    const both = await liveFilters({ INDEXER_SOURCES: "inkypump,inkfun" })
    expect(both).toHaveLength(3)
    expect(JSON.stringify(both[0]?.topics)).toContain(INKFUN_TOPICS.bought)
  })

  it("tsunami alone reads one filter while no pool is registered, and merges with InkyPump's and ink.fun's", async () => {
    const alone = await liveFilters({ INDEXER_SOURCES: "tsunami" }, false)
    expect(alone).toHaveLength(1)
    expect(JSON.stringify(alone[0]?.topics)).toContain(TSUNAMI_TOPICS.bought)
    expect(await liveFilters({ INDEXER_SOURCES: "tsunami" })).toHaveLength(3)
    const all = await liveFilters({ INDEXER_SOURCES: "inkypump,inkfun,tsunami" })
    expect(all).toHaveLength(3)
    expect(JSON.stringify(all[0]?.topics)).toContain(TSUNAMI_TOPICS.launched)
    expect(JSON.stringify(all[0]?.topics)).toContain(INKFUN_TOPICS.bought)
  })

  it("hookit alone reads one filter while no pool is registered, and merges with the other launchpads'", async () => {
    const alone = await liveFilters({ INDEXER_SOURCES: "hookit" }, false)
    expect(alone).toHaveLength(1)
    expect(JSON.stringify(alone[0]?.topics)).toContain(HOOKIT_TOPICS.bought)
    expect(await liveFilters({ INDEXER_SOURCES: "hookit" })).toHaveLength(3)
    const all = await liveFilters({ INDEXER_SOURCES: "inkypump,inkfun,tsunami,hookit" })
    expect(all).toHaveLength(3)
    expect(JSON.stringify(all[0]?.topics)).toContain(HOOKIT_TOPICS.masterLaunched)
    expect(JSON.stringify(all[0]?.topics)).toContain(TSUNAMI_TOPICS.launched)
  })

  it("inkypump alone reads its own and the two v4 filters and no NFT filter, in 3 requests", async () => {
    const asked = await liveFilters({ INDEXER_SOURCES: "inkypump" })
    expect(asked).toHaveLength(3)
    expect(
      asked.filter((f) => JSON.stringify(f.address) === JSON.stringify([UNISWAP_V4_POOL_MANAGER])),
    ).toHaveLength(1)
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

  it("nftx alone reads the NFTX contracts and the auction factory in one address-bound request, and the auctions' events by topic in another", async () => {
    const asked = await liveFilters({ INDEXER_SOURCES: "nftx" })
    expect(asked).toHaveLength(2)
    const bound = asked.find((f) => f.address !== undefined)!
    const open = asked.find((f) => f.address === undefined)!
    expect(JSON.stringify(bound.address)).toContain(NFTX_LOCKER)
    expect(JSON.stringify(bound.address)).toContain(CCA_FACTORY)
    expect(JSON.stringify(bound.topics)).toContain(NFTX_TOPICS.CollectionCreated)
    expect(JSON.stringify(bound.topics)).toContain(CCA_TOPICS.AuctionCreated)
    expect(open.topics).toEqual([[...CCA_AUCTION_TOPICS]])
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

  it("gives the NFTX source the rank lookup while the OpenSea services run", async () => {
    const ranks: { current: Pick<Ranks, "getRank"> | null } = { current: null }
    const d = {
      ...deps({ OPENSEA_API_KEY: "wiring-test-key-0123456789" }, [], new FakeStream()),
      ranks,
    }
    const services = await startSourceServices(sources({ INDEXER_SOURCES: "opensea,nftx" }), d)
    expect(ranks.current).toHaveProperty("getRank")
    services.stop()
    expect(ranks.current).toBeNull()

    // Without a key the services are off and there is no lookup.
    const keyless = await startSourceServices(sources({}), { ...d, env: {} })
    keyless.stop()
    expect(ranks.current).toBeNull()
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

describe("SOURCE_GROUPS", () => {
  const realSources = () => {
    const chain = new FakeChain(1000n)
    const pools = new PoolRegistry()
    const ipfs = { gateway: "https://gw.example" }
    return [
      inkypumpSource({ sql, chain, pools, logger: quiet }),
      inkfunSource({ sql, chain, pools, logger: quiet, ipfs }),
      tsunamiSource({ sql, chain, pools, logger: quiet, ipfs }),
      hookitSource({ sql, chain, pools, logger: quiet, ipfs }),
      v4Source({ sql, chain, pools, logger: quiet }),
      nftSource({ sql, chain, logger: quiet }),
      nftxSource({ sql, chain, logger: quiet }),
    ]
  }

  it("covers every BACKFILL_SOURCES name exactly once", () => {
    const named = Object.values(SOURCE_GROUPS).flat()
    expect([...named].sort()).toEqual([...BACKFILL_SOURCES].sort())
  })

  it("lists the launchpad sources", () => {
    expect(LAUNCHPAD_SOURCES).toEqual(["inkypump", "inkfun", "tsunami", "hookit"])
    for (const name of LAUNCHPAD_SOURCES) expect(name in SOURCE_GROUPS).toBe(true)
  })

  it("gives each source a name that is a SOURCE_GROUPS key and that entry as its groups", () => {
    const sources = realSources()
    expect(sources.map((s) => s.name).sort()).toEqual(Object.keys(SOURCE_GROUPS).sort())
    for (const s of sources)
      expect(s.groups).toEqual(SOURCE_GROUPS[s.name as keyof typeof SOURCE_GROUPS])
  })

  it("makes each source's filters pick only its own groups", () => {
    for (const s of realSources()) {
      for (const g of BACKFILL_SOURCES) {
        const picked = s.filters([g]).some((f) => f !== null) || s.readsLate?.([g]) === true
        expect(picked, `${s.name} with ${g}`).toBe(s.groups.includes(g))
      }
    }
  })
})
