import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  type ChainLog,
  NFTX_FLETH,
  NFTX_HOOK,
  NFTX_LOCKER,
  NFTX_TOPICS,
  nftxSpotWei,
} from "@ink-indexer/sdk"
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hash,
  type Hex,
  pad,
  parseAbi,
} from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { loadNftxFixture, type NftxFixtureName } from "../../../packages/sdk/test/fixtures"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import { nftSource } from "../src/sources/nft/index"
import { createVerdictJob } from "../src/sources/nft/verdict"
import { nftxSource } from "../src/sources/nftx/index"
import { moved } from "../src/sources/nftx/stats"
import { fetchNftxSlug } from "../src/sources/nftx/slug"
import { createSnapshots } from "../src/sources/opensea/snapshot"
import { createStore, type Store } from "../src/store"
import { FakeChain } from "./fake-chain"

const LD = "0x2538d3202844e6b3852570d9ef63a916f900c373" as Address
const LD_TOKEN = "0x370e49749b9ff90004f3186aa7135487acc2a8fc" as Address
const LD_POOL = "0x01c00c5f00fba3d9c1679d4d5cf9443413f9ed018ae2dbc4ebf756e4a5283282"
const CREATOR = "0x98606955ca2474ac2efd5164bd6360c54d043b40" as Address
const CREATED_BLOCK = 59_737_309n
const INIT_BLOCK = 59_737_336n

let sql: Sql
let store: Store
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

type Fetch = typeof fetch
type Setup = {
  both?: boolean
  launchpad?: Address | null
  fetch?: Fetch
  now?: () => number
}

/** A chain over the fixtures' logs, an indexer running the sources, and helpers to drive it. */
function setup(fixtures: NftxFixtureName[], opts: Setup = {}) {
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
  const logger: Logger = (level, msg, fields) => {
    if (level === "warn") warnings.push({ msg, fields })
  }
  const loaded = fixtures.map((n) => loadNftxFixture(n))
  const head = loaded.reduce((m, f) => (f.blockNumber > m ? f.blockNumber : m), 0n) + 100n
  const chain = new FakeChain(head)
  chain.maxSpan = 10_000_000n
  for (const f of loaded) addFixture(chain, f)
  const nftx = nftxSource({
    sql,
    chain,
    logger,
    fetch: opts.fetch ?? noSlug,
    now: opts.now,
    launchpad: opts.launchpad ?? null,
  })
  const sources = opts.both ? [nftSource({ sql, chain, logger }), nftx] : [nftx]
  const idx = new Indexer({ chain, store, logger, sources })
  /** The lowest block holding a log, including ones a test adds. */
  const firstBlock = () =>
    chain.logs.reduce((m, l) => (l.blockNumber < m ? l.blockNumber : m), head)
  /** Reads the chain from the first fixture's block up to the head as backfill spans. */
  const backfill = async () => {
    await idx.init()
    await idx.backfill(firstBlock(), chain.head)
  }
  /** Reads it as the live tick does, from the block before the first fixture. */
  const live = async () => {
    await idx.init()
    await store.writeBatch([], [], {
      cursor: { block: firstBlock() - 1n, hash: chain.hashOf(firstBlock() - 1n) },
      head: chain.head,
    })
    await idx.trigger()
  }
  return { chain, idx, warnings, backfill, live, nftx, firstBlock, head }
}

/** Adds a fixture's logs and its block's senders and targets, and the block time it recorded. */
function addFixture(chain: FakeChain, f: ReturnType<typeof loadNftxFixture>) {
  for (const l of f.logs) chain.add(l)
  const prev = chain.senders.get(f.blockNumber)
  const senders = prev?.senders ?? new Map<Hash, Address>()
  const targets = prev?.targets ?? new Map<Hash, Address | null>()
  senders.set(f.txHash, f.from)
  targets.set(f.txHash, f.to)
  chain.senders.set(f.blockNumber, {
    hash: chain.hashOf(f.blockNumber),
    senders,
    targets,
    timestamp: f.timestamp,
  })
}

const noSlug: Fetch = (async () => new Response("{}", { status: 404 })) as unknown as Fetch
const slugFetch = (slug: string, calls: string[] = []): Fetch =>
  (async (url: string) => {
    calls.push(String(url))
    return Response.json({ slug })
  }) as unknown as Fetch

const one = async <T extends object>(query: Promise<T[]>) => (await query)[0]!
const events = (type: string) =>
  sql<{ payload: Record<string, unknown>; block: string; tx_hash: string }[]>`
    select payload, block, tx_hash from indexer.events where type = ${type} order by id`
const collectionRow = () =>
  one(
    sql<Record<string, unknown>[]>`select * from indexer.nftx_collections where collection = ${LD}`,
  )
const nftRow = () =>
  one(sql<Record<string, unknown>[]>`select * from indexer.nft_collections where contract = ${LD}`)

const CHIMERA_ABI = parseAbi([
  "event CampaignCreated(uint256 indexed campaignId, bytes32 indexed poolId, address indexed creator, address token, address core, address collection, address rewards, address vault, uint256 chainId)",
])
const CHIMERA_TOKEN = "0x00000000000000000000000000000000000c0001" as Address

/** A synthetic Chimera `CampaignCreated` that launches `collection`. */
function chimeraLaunch(collection: Address, block: bigint): ChainLog {
  const topics = encodeEventTopics({
    abi: CHIMERA_ABI,
    eventName: "CampaignCreated",
    args: { campaignId: 7n, poolId: pad("0x07", { size: 32 }), creator: CREATOR },
  }) as Hex[]
  const zero = "0x0000000000000000000000000000000000000001" as Address
  const data = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
    ],
    [CHIMERA_TOKEN, zero, collection, zero, zero, 57073n],
  )
  return {
    address: "0xa66c05f14e79f40952531c20de0b60282e3800be",
    topics,
    data,
    blockNumber: block,
    blockHash: pad("0x01", { size: 32 }),
    transactionHash: pad(`0x${block.toString(16)}`, { size: 32 }),
    logIndex: 0,
  } as ChainLog
}

describe("Lil Dudes", () => {
  it("CollectionCreated writes the NFTX row and sets launchpad nftx with the floor token", async () => {
    const t = setup(["lildudes-created"])
    await t.backfill()
    expect(await collectionRow()).toMatchObject({
      collection: LD,
      floor_token: LD_TOKEN,
      creator: CREATOR,
      name: "Lil Dudes",
      symbol: "LILDUDES",
      created_block: CREATED_BLOCK,
      initialized_block: null,
      launchpad_created: false,
    })
    expect(await nftRow()).toMatchObject({
      standard: "erc721",
      launchpad: "nftx",
      launch_token: LD_TOKEN,
      verdict_dirty: true,
      // The creator that ran the transaction is not the collection's creator.
      creator_address: null,
    })
  })

  it("CollectionInitialized emits nft.launch with poolCount 35, nftxFloorWei 899999999999999 and its poolId", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    await t.backfill()
    const [launch, ...rest] = await events("nft.launch")
    expect(rest).toEqual([])
    expect(launch!.payload).toMatchObject({
      type: "nft.launch",
      contract: LD,
      launchpad: "nftx",
      campaignId: LD_TOKEN,
      token: LD_TOKEN,
      tokenName: "Lil Dudes",
      tokenSymbol: "LILDUDES",
      creator: CREATOR,
      poolId: LD_POOL,
      nftxFloorWei: "899999999999999",
      poolCount: 35,
      nftxSlug: null,
      blockNumber: String(INIT_BLOCK),
      blockTimestamp: 1793235747,
    })
    expect(await collectionRow()).toMatchObject({
      initialized_block: INIT_BLOCK,
      pool_id: LD_POOL,
      fleth_is_currency0: true,
      seeded: 35,
    })
    expect(
      await one(sql`select * from indexer.nft_launches where collection = ${LD}`),
    ).toMatchObject({
      launchpad: "nftx",
      token: LD_TOKEN,
      pool_id: LD_POOL,
      creator: CREATOR,
      campaign_id: null,
      core: null,
      rewards: null,
      vault: null,
    })
  })

  it("its two PoolStateUpdated logs write two price rows", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    await t.backfill()
    const prices = await sql<{ log_index: number; price_wei: string; at: Date }[]>`
      select log_index, price_wei::text, at from indexer.nftx_prices where collection = ${LD}
      order by log_index`
    expect(prices.map((p) => [p.log_index, p.price_wei])).toEqual([
      [41, "899999999999999"],
      [49, "899999999999999"],
    ])
    expect(prices[0]!.at.getTime()).toBe(1793235747 * 1000)
  })

  it("the arbitrage transaction writes one price row of 308559859825663 and no NFTX sale", async () => {
    const t = setup(["lildudes-created", "lildudes-init", "arbitrage-lildudes"])
    await t.backfill()
    const rows = await sql<{ block: bigint; price_wei: string }[]>`
      select block, price_wei::text from indexer.nftx_prices where collection = ${LD}
      order by block, log_index`
    expect(rows.filter((r) => r.block === 60_998_579n)).toEqual([
      { block: 60_998_579n, price_wei: "308559859825663" },
    ])
    expect((await events("nft.sale")).filter((e) => e.payload.market === "nftx")).toEqual([])
  })

  it("a price at the extremes is stored with a null price and no row fails (synthetic)", async () => {
    const t = setup(["lildudes-created", "lildudes-init", "arbitrage-lildudes"])
    const moved = t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.PoolStateUpdated)!
    const zero = { ...moved, logIndex: 70, data: setWord(moved.data, 0, 0n) }
    const max = { ...moved, logIndex: 71, data: setWord(moved.data, 0, (1n << 160n) - 1n) }
    t.chain.add(zero)
    t.chain.add(max)
    await t.backfill()
    const rows = await sql<{ log_index: number; price_wei: string | null }[]>`
      select log_index, price_wei::text from indexer.nftx_prices
      where collection = ${LD} and log_index in (70, 71)`
    expect(rows.sort((a, b) => a.log_index - b.log_index)).toEqual([
      { log_index: 70, price_wei: null },
      { log_index: 71, price_wei: null },
    ])
  })
})

describe("an opening at the extremes of the price range", () => {
  const SQRT_WORD = 2
  it.each([
    ["0", 0n],
    ["1", 1n],
    ["2^160 − 1", (1n << 160n) - 1n],
  ])(
    "a sqrt price of %s opens the pool without failing the batch (synthetic)",
    async (_n, sqrt) => {
      const t = setup(["lildudes-created", "lildudes-init"])
      const init = t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.CollectionInitialized)!
      init.data = setWord(init.data, SQRT_WORD, sqrt)
      await t.backfill()
      expect(await collectionRow()).toMatchObject({ initialized_block: INIT_BLOCK, seeded: 35 })
      expect(await sql`select 1 from indexer.nft_launches`).toHaveLength(1)
      const [launch, ...rest] = await events("nft.launch")
      expect(rest).toEqual([])
      // Zero has no price. The others give whatever the formula gives, never a throw.
      expect(launch!.payload.nftxFloorWei).toBe(nftxSpotWei(sqrt, true)?.toString() ?? null)
      if (sqrt === 0n) expect(launch!.payload.nftxFloorWei).toBeNull()
      // The opening's own price is not announced; the pool's first PoolStateUpdated is.
      const stats = await events("nft.stats")
      expect(stats).toHaveLength(1)
      expect(stats[0]!.payload.nftxFloorWei).toBe("899999999999999")
      expect(await sql`select 1 from indexer.nftx_prices`).toHaveLength(2)
    },
  )
})

describe("a collection the Locker created", () => {
  it("has a snapshot before any mint is indexed, because its standard is set (synthetic)", async () => {
    const t = setup(["lildudes-created"])
    await t.live()
    expect((await nftRow()).standard).toBe("erc721")
    await sql`insert into indexer.nft_overrides (contract, verdict, note) values (${LD}, 'real', 'hand')`
    await sql`update indexer.nft_collections set verdict_dirty = true where contract = ${LD}`
    const snapshots = createSnapshots({ sql, store, now: () => 1_800_000_000_000 })
    const job = createVerdictJob({
      sql,
      store,
      snapshots,
      chain: t.chain,
      historyStartTs: 0,
      historyStartBlock: 0n,
      log: () => {},
      now: () => 1_800_000_000_000,
    })
    await job.run(LD)
    expect(await events("nft.collection")).toHaveLength(1)
  })

  it("keeps a standard an indexed mint already gave it", async () => {
    await sql`insert into indexer.nft_collections (contract, standard) values (${LD}, 'erc1155')`
    const t = setup(["lildudes-created"])
    await t.backfill()
    expect((await nftRow()).standard).toBe("erc1155")
  })
})

/** Replaces one 32-byte word of ABI-encoded data. */
function setWord(data: Hex, index: number, value: bigint): Hex {
  const body = data.slice(2)
  const word = value.toString(16).padStart(64, "0")
  return `0x${body.slice(0, index * 64)}${word}${body.slice(index * 64 + 64)}` as Hex
}

describe("a collection on Chimera and on NFTX", () => {
  const both = (fixtures: NftxFixtureName[]) => setup(fixtures, { both: true })

  it("a Chimera collection opened on NFTX keeps launchpad chimera and its token, and gets both launch rows (synthetic)", async () => {
    const t = both(["lildudes-created", "lildudes-init"])
    t.chain.add(chimeraLaunch(LD, 59_737_000n))
    await t.backfill()
    expect(await nftRow()).toMatchObject({ launchpad: "chimera", launch_token: CHIMERA_TOKEN })
    const launches = await sql<{ launchpad: string }[]>`
      select launchpad from indexer.nft_launches where collection = ${LD} order by launchpad`
    expect(launches.map((l) => l.launchpad)).toEqual(["chimera", "nftx"])
    expect((await events("nft.launch")).map((e) => e.payload.launchpad).sort()).toEqual([
      "chimera",
      "nftx",
    ])
  })

  it("an NFTX collection later launched on Chimera takes launchpad chimera and the Chimera token (synthetic)", async () => {
    const t = both(["lildudes-created", "lildudes-init"])
    t.chain.add(chimeraLaunch(LD, 59_737_400n))
    await t.backfill()
    expect(await nftRow()).toMatchObject({ launchpad: "chimera", launch_token: CHIMERA_TOKEN })
  })

  it("a Chimera launch in a later span replaces the floor token as launch_token (synthetic)", async () => {
    const t = both(["lildudes-created", "lildudes-init"])
    await t.live()
    expect(await nftRow()).toMatchObject({ launchpad: "nftx", launch_token: LD_TOKEN })
    t.chain.head += 20n
    const block = t.chain.head - 5n
    const launch = chimeraLaunch(LD, block)
    t.chain.add(launch)
    t.chain.senders.set(block, {
      hash: t.chain.hashOf(block),
      senders: new Map([[launch.transactionHash, CREATOR]]),
    })
    await t.idx.trigger()
    expect(await nftRow()).toMatchObject({ launchpad: "chimera", launch_token: CHIMERA_TOKEN })
  })

  it("rolling back the NFTX open leaves the Chimera launch, launchpad and launch_token", async () => {
    const t = both(["lildudes-created", "lildudes-init"])
    t.chain.add(chimeraLaunch(LD, 59_737_000n))
    await t.live()
    expect((await nftRow()).launchpad).toBe("chimera")
    t.chain.reorg(CREATED_BLOCK)
    await t.idx.trigger()
    expect(await nftRow()).toMatchObject({ launchpad: "chimera", launch_token: CHIMERA_TOKEN })
    expect(
      (await sql<{ launchpad: string }[]>`select launchpad from indexer.nft_launches`).map(
        (l) => l.launchpad,
      ),
    ).toEqual(["chimera"])
    expect(await sql`select 1 from indexer.nftx_collections`).toHaveLength(0)
  })

  it("rolling back the Chimera launch of a collection on NFTX restores launchpad nftx and the floor token", async () => {
    const t = both(["lildudes-created", "lildudes-init"])
    t.chain.add(chimeraLaunch(LD, 59_737_400n))
    await t.live()
    expect((await nftRow()).launchpad).toBe("chimera")
    t.chain.reorg(59_737_400n)
    await t.idx.trigger()
    expect(await nftRow()).toMatchObject({ launchpad: "nftx", launch_token: LD_TOKEN })
    expect(await sql`select 1 from indexer.nft_launches where launchpad = 'nftx'`).toHaveLength(1)
  })
})

describe("the NFTX launchpad", () => {
  /** Runs the created fixture with the launchpad set to the address that sent it. */
  const withLaunchpad = (launchpad: Address | null) =>
    setup(["lildudes-created", "lildudes-init"], { both: true, launchpad })

  function verdictJob(chain: FakeChain) {
    const snapshots = createSnapshots({ sql, store, now: () => 1_800_000_000_000 })
    return createVerdictJob({
      sql,
      store,
      snapshots,
      chain,
      historyStartTs: 0,
      historyStartBlock: 0n,
      log: () => {},
      now: () => 1_800_000_000_000,
    })
  }

  it("with the launchpad set, a collection it creates is real without the gates and its snapshot reads manual (synthetic)", async () => {
    const t = withLaunchpad(CREATOR)
    await t.live()
    expect(await collectionRow()).toMatchObject({ launchpad_created: true })
    expect(
      await one(sql`select verdict, note from indexer.nft_overrides where contract = ${LD}`),
    ).toEqual({ verdict: "real", note: "nftx-launchpad" })
    await verdictJob(t.chain).run(LD)
    const [snap] = await events("nft.collection")
    expect(snap!.payload).toMatchObject({ verdict: "real", manual: true, launchpad: "nftx" })
  })

  it("the launchpad is matched on the transaction's target too (synthetic)", async () => {
    const t = withLaunchpad(NFTX_LOCKER)
    await t.backfill()
    expect((await collectionRow()).launchpad_created).toBe(true)
  })

  it("with it empty nothing changes", async () => {
    const t = withLaunchpad(null)
    await t.backfill()
    expect((await collectionRow()).launchpad_created).toBe(false)
    expect(await sql`select 1 from indexer.nft_overrides`).toHaveLength(0)
  })

  it("another sender is not the launchpad", async () => {
    const t = withLaunchpad("0x00000000000000000000000000000000000000ee")
    await t.backfill()
    expect((await collectionRow()).launchpad_created).toBe(false)
    expect(await sql`select 1 from indexer.nft_overrides`).toHaveLength(0)
  })

  it("a manual filtered mark is not overwritten", async () => {
    await sql`insert into indexer.nft_overrides (contract, verdict, note) values (${LD}, 'filtered', 'hand')`
    const t = withLaunchpad(CREATOR)
    await t.backfill()
    expect(
      await one(sql`select verdict, note from indexer.nft_overrides where contract = ${LD}`),
    ).toEqual({ verdict: "filtered", note: "hand" })
  })

  it("an NFTX collection with no slug marked real emits nft.collection with verdict real and manual true", async () => {
    const t = setup(["lildudes-created", "lildudes-init"], { both: true })
    await t.live()
    await sql`insert into indexer.nft_overrides (contract, verdict, note) values (${LD}, 'real', 'hand')`
    await sql`update indexer.nft_collections set verdict_dirty = true where contract = ${LD}`
    await verdictJob(t.chain).run(LD)
    const [snap] = await events("nft.collection")
    expect(snap!.payload).toMatchObject({
      verdict: "real",
      manual: true,
      name: null,
      imageUrl: null,
      slug: null,
      launchpad: "nftx",
      launchToken: LD_TOKEN,
    })
  })
})

/** A new PoolStateUpdated of Lil Dudes a few blocks above the chain's head, read by the live tick. */
async function priceMove(t: ReturnType<typeof setup>) {
  const base = t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.PoolStateUpdated)!
  t.chain.head += 20n
  const block = t.chain.head - 5n
  const tx = pad(`0x${block.toString(16)}`, { size: 32 })
  t.chain.add({ ...base, blockNumber: block, logIndex: 1, transactionHash: tx })
  t.chain.senders.set(block, {
    hash: t.chain.hashOf(block),
    senders: new Map([[tx, CREATOR]]),
    targets: new Map([[tx, NFTX_HOOK]]),
  })
  await t.idx.trigger()
}

describe("the NFTX slug", () => {
  it("the slug lil-dudes is stored and the launch event carries it", async () => {
    const calls: string[] = []
    const t = setup(["lildudes-created", "lildudes-init"], {
      both: true,
      fetch: slugFetch("lil-dudes", calls),
    })
    await t.backfill()
    expect((await nftRow()).nftx_slug).toBe("lil-dudes")
    expect(calls).toEqual([`https://api.nftx.io/v1/ink/collections/${LD}`])
    const [launch] = await events("nft.launch")
    expect(launch!.payload.nftxSlug).toBe("lil-dudes")
  })

  it.each([
    ["a 404", async () => new Response("{}", { status: 404 })],
    ["a non-JSON body", async () => new Response("<html>", { status: 200 })],
    ["a 404 that names a slug", async () => Response.json({ slug: "lil-dudes" }, { status: 404 })],
    [
      "a 70 KB body",
      async () => new Response(JSON.stringify({ slug: "lil-dudes", note: "x".repeat(70_000) })),
    ],
    ["a slug with a space and capitals", async () => Response.json({ slug: "Lil Dudes" })],
    ["a slug with a path", async () => Response.json({ slug: "../x" })],
    ["a slug of 101 characters", async () => Response.json({ slug: "a".repeat(101) })],
    ["a slug that is not a string", async () => Response.json({ slug: 5 })],
    ["a slug with a trailing newline", async () => Response.json({ slug: "lil-dudes\n" })],
  ])("%s stores nothing and the batch is written", async (_name, answer) => {
    const t = setup(["lildudes-created", "lildudes-init"], {
      both: true,
      fetch: answer as unknown as Fetch,
    })
    await t.backfill()
    expect((await nftRow()).nftx_slug).toBeNull()
    expect(await collectionRow()).toMatchObject({ initialized_block: INIT_BLOCK })
  })

  it("a fetch that fails or never answers is a miss and the batch is written", async () => {
    for (const answer of [
      async () => {
        throw new Error("down")
      },
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
        ),
    ]) {
      await resetDb(inject("databaseUrl"))
      expect(
        await fetchNftxSlug(LD, { fetch: answer as unknown as Fetch, timeoutMs: 20 }),
      ).toBeNull()
    }
  })

  it("a miss is retried after 5 minutes, not on the next batch", async () => {
    let clock = 1_000_000
    const calls: string[] = []
    const t = setup(["lildudes-created", "lildudes-init"], {
      fetch: (async (u: string) => {
        calls.push(u)
        return new Response("{}", { status: 404 })
      }) as unknown as Fetch,
      now: () => clock,
    })
    await t.live()
    expect(calls).toHaveLength(1)
    // A price move a minute later: no new attempt.
    clock += 60_000
    await priceMove(t)
    expect(calls).toHaveLength(1)
    // Five minutes after the attempt, the next one asks again.
    clock += 5 * 60_000
    await priceMove(t)
    expect(calls).toHaveLength(2)
  })

  it("processing the same span twice writes identical rows and fetches the slug once", async () => {
    const calls: string[] = []
    const t = setup(["lildudes-created", "lildudes-init"], {
      fetch: slugFetch("lil-dudes", calls),
    })
    await t.live()
    const rows = async () => ({
      prices: await sql`select * from indexer.nftx_prices order by block, log_index`,
      collections: await sql`select * from indexer.nftx_collections`,
      launches: await sql`select * from indexer.nft_launches`,
      events: await sql`select type, payload from indexer.events order by id`,
    })
    const before = await rows()
    // The same span again, as a backfill over rows the live tick wrote.
    await t.idx.backfill(t.firstBlock(), t.chain.head)
    expect(await rows()).toEqual(before)
    expect(calls.length).toBe(1)
  })
})

describe("trusted emitters", () => {
  it("a CollectionCreated from another address is ignored", async () => {
    const t = setup(["lildudes-created"])
    for (const l of t.chain.logs)
      if (l.topics[0] === NFTX_TOPICS.CollectionCreated)
        l.address = "0x00000000000000000000000000000000000000bb" as Address
    await t.backfill()
    expect(await sql`select 1 from indexer.nftx_collections`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nft_collections`).toHaveLength(0)
  })

  it.each([
    ["the hook", NFTX_HOOK],
    ["a Zap", "0x000000144106c1bfc69fbbd04d56220e1a0a9a3c"],
  ])("a CollectionCreated or CollectionInitialized emitted by %s is ignored", async (_n, from) => {
    const t = setup(["lildudes-created", "lildudes-init"])
    for (const l of t.chain.logs)
      if (
        l.topics[0] === NFTX_TOPICS.CollectionCreated ||
        l.topics[0] === NFTX_TOPICS.CollectionInitialized
      )
        l.address = from as Address
    await t.backfill()
    expect(await sql`select 1 from indexer.nftx_collections`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nft_launches`).toHaveLength(0)
  })

  it("a PoolStateUpdated emitted by the Locker stores no price", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    for (const l of t.chain.logs)
      if (l.topics[0] === NFTX_TOPICS.PoolStateUpdated) l.address = NFTX_LOCKER
    await t.backfill()
    expect(await sql`select 1 from indexer.nftx_prices`).toHaveLength(0)
  })

  it("a PoolStateUpdated of a collection before its pool opened stores no price (synthetic)", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    const state = t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.PoolStateUpdated)!
    const block = CREATED_BLOCK + 5n
    const tx = pad("0x7001", { size: 32 })
    t.chain.add({ ...state, blockNumber: block, transactionHash: tx, logIndex: 1 })
    t.chain.senders.set(block, {
      hash: t.chain.hashOf(block),
      senders: new Map([[tx, CREATOR]]),
      targets: new Map([[tx, NFTX_HOOK]]),
    })
    await t.backfill()
    const blocks = await sql<{ block: bigint }[]>`select block from indexer.nftx_prices`
    expect(blocks.map((b) => b.block)).not.toContain(block)
    expect(blocks).toHaveLength(2)
  })

  it("a PoolStateUpdated from another address stores no price", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    for (const l of t.chain.logs)
      if (l.topics[0] === NFTX_TOPICS.PoolStateUpdated)
        l.address = "0x00000000000000000000000000000000000000bb" as Address
    await t.backfill()
    expect(await sql`select 1 from indexer.nftx_prices`).toHaveLength(0)
  })

  it("a pool key with another hook stores no side and no prices (synthetic)", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    const init = t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.CollectionInitialized)!
    // The key's last word is the hook; replace it inside the ABI-encoded bytes.
    init.data = init.data.replace(
      NFTX_HOOK.slice(2),
      "00000000000000000000000000000000000000dd",
    ) as Hex
    await t.backfill()
    expect(await collectionRow()).toMatchObject({
      initialized_block: INIT_BLOCK,
      fleth_is_currency0: null,
    })
    expect(await sql`select 1 from indexer.nftx_prices`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nft_launches`).toHaveLength(0)
    expect(await events("nft.launch")).toHaveLength(0)
    expect(t.warnings.filter((w) => w.msg.includes("pool"))).toHaveLength(1)
  })

  it("a pool with neither currency flETH stores no side, no launch and no prices (synthetic)", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    const init = t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.CollectionInitialized)!
    init.data = init.data.replace(
      NFTX_FLETH.slice(2),
      "00000000000000000000000000000000000000dd",
    ) as Hex
    await t.backfill()
    expect((await collectionRow()).fleth_is_currency0).toBeNull()
    expect(await sql`select 1 from indexer.nftx_prices`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nft_launches`).toHaveLength(0)
    expect(await events("nft.launch")).toHaveLength(0)
    expect(t.warnings.filter((w) => w.msg.includes("pool"))).toHaveLength(1)
  })

  it("a pool with flETH as currency1 reads the price the other way round (synthetic)", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    const init = t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.CollectionInitialized)!
    // Swap the two currencies in the key; flETH becomes currency1.
    const fleth = NFTX_FLETH.slice(2).padStart(64, "0")
    const token = LD_TOKEN.slice(2).padStart(64, "0")
    init.data = init.data.replace(fleth + token, token + fleth) as Hex
    await t.backfill()
    expect((await collectionRow()).fleth_is_currency0).toBe(false)
    const [row] = await sql<{ price_wei: string }[]>`
      select price_wei::text from indexer.nftx_prices where log_index = 41`
    const sqrt = 2640938750475477919784798344622n
    expect(BigInt(row!.price_wei)).toBe(nftxSpotWei(sqrt, false))
  })
})

describe("sunset and rollback", () => {
  it("logs after CollectionSunset add no prices (synthetic)", async () => {
    const t = setup(["lildudes-created", "lildudes-init", "arbitrage-lildudes"])
    const sunset: ChainLog = {
      ...t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.CollectionCreated)!,
      topics: [
        NFTX_TOPICS.CollectionSunset,
        t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.CollectionCreated)!.topics[1]!,
      ],
      data: encodeAbiParameters([{ type: "address" }, { type: "address" }], [LD_TOKEN, CREATOR]),
      blockNumber: 60_000_000n,
      logIndex: 0,
      transactionHash: pad("0x5555", { size: 32 }),
    }
    t.chain.add(sunset)
    t.chain.senders.set(60_000_000n, {
      hash: t.chain.hashOf(60_000_000n),
      senders: new Map([[sunset.transactionHash, CREATOR]]),
      targets: new Map([[sunset.transactionHash, NFTX_LOCKER]]),
    })
    await t.backfill()
    expect((await collectionRow()).sunset_block).toBe(60_000_000n)
    const blocks = await sql<{ block: bigint }[]>`select block from indexer.nftx_prices`
    expect(blocks.map((b) => b.block)).not.toContain(60_998_579n)
  })

  it("rollback above CollectionCreated removes the NFTX rows and resets launchpad", async () => {
    const t = setup(["lildudes-created", "lildudes-init"], { both: true })
    await t.live()
    expect((await nftRow()).launchpad).toBe("nftx")
    t.chain.reorg(CREATED_BLOCK)
    await t.idx.trigger()
    expect(await sql`select 1 from indexer.nftx_collections`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nftx_prices`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nft_launches`).toHaveLength(0)
    expect(await nftRow()).toMatchObject({ launchpad: null, launch_token: null })
  })

  it("rollback above CollectionInitialized keeps the collection and clears its opening", async () => {
    const t = setup(["lildudes-created", "lildudes-init"], { both: true })
    await t.live()
    t.chain.reorg(INIT_BLOCK)
    await t.idx.trigger()
    expect(await collectionRow()).toMatchObject({
      initialized_block: null,
      pool_id: null,
      sunset_block: null,
    })
    expect(await sql`select 1 from indexer.nftx_prices`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nft_launches`).toHaveLength(0)
    expect((await nftRow()).launchpad).toBe("nftx")
  })
})

// Stats from pool moves.

const ARB_BLOCK = 60_998_579n
const ARB_PRICE = 308_559_859_825_663n

/** The sqrt price that gives `price` wei per NFT with flETH as currency0. */
function sqrtFor(price: bigint): bigint {
  const target = ((10n ** 18n) << 192n) / price
  let x = 1n << (BigInt(target.toString(2).length) / 2n + 1n)
  for (;;) {
    const y = (x + target / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

/** Lil Dudes' opening read live, then its stored last announced price set, then the arbitrage block read live. */
async function arbitrageAfter(
  t: ReturnType<typeof setup>,
  previous: bigint | null,
  extra: (t: ReturnType<typeof setup>) => void = () => {},
) {
  await t.live()
  if (previous !== null)
    await sql`
      update indexer.nftx_collections set stats_price_wei = ${previous.toString()},
        stats_block = ${INIT_BLOCK.toString()}
      where collection = ${LD}`
  addFixture(t.chain, loadNftxFixture("arbitrage-lildudes"))
  extra(t)
  t.chain.head = ARB_BLOCK + 100n
  await t.idx.trigger()
}
const statsEvents = () => events("nft.stats")
const statRows = () =>
  sql<Record<string, unknown>[]>`
    select contract, at, floor_wei::text, floor_market, os_floor_wei::text, nftx_floor_wei::text,
      pool_count, owners, volume_24h_wei::text, sales_24h, block::text
    from indexer.nft_stats where block is not null order by block, at`

describe("stats from pool moves", () => {
  const ARB_STATS = (e: { block: string | bigint }) => String(e.block) === ARB_BLOCK.toString()

  it.each([
    ["a 0.9% move emits no stats", (ARB_PRICE * 1000n) / 991n, 0],
    ["a 3.4% move does", (ARB_PRICE * 1000n) / 966n, 1],
  ])("%s (arbitrage fixture with a stored previous price)", async (_name, previous, emitted) => {
    const t = setup(["lildudes-created", "lildudes-init"])
    t.chain.nftxPoolCounts.set(LD, 61)
    await arbitrageAfter(t, previous)
    expect((await statsEvents()).filter(ARB_STATS)).toHaveLength(emitted)
    expect((await statRows()).filter((r) => r.block === ARB_BLOCK.toString())).toHaveLength(emitted)
  })

  it("a move of exactly 1% up or down is announced, and one just under it is not", () => {
    expect(moved(10_000n, 10_100n)).toBe(true)
    expect(moved(10_000n, 9_900n)).toBe(true)
    expect(moved(10_000n, 10_099n)).toBe(false)
    expect(moved(10_000n, 9_901n)).toBe(false)
    expect(moved(10_000n, 10_000n)).toBe(false)
  })

  // The only older row is the opening's, 14.6 days before the move. A history that begins after
  // it has no 24h-ago floor.
  it.each([
    ["begins 10 hours before the move: none", 10 * 3600, null],
    ["begins before the opening: the opening's", 15 * 86400, "899999999999999"],
  ])("a combined history that %s", async (_name, before, expected) => {
    const arb = loadNftxFixture("arbitrage-lildudes")
    const t = setup(["lildudes-created", "lildudes-init"])
    t.chain.nftxPoolCounts.set(LD, 61)
    await t.live()
    await sql`update indexer.nftx_collections set combined_since = ${new Date((arb.timestamp - before) * 1000)}
      where collection = ${LD}`
    addFixture(t.chain, arb)
    t.chain.head = ARB_BLOCK + 100n
    await t.idx.trigger()
    const [event] = (await statsEvents()).filter(ARB_STATS)
    expect(event!.payload.floor24hAgoWei).toBe(expected)
  })

  it("announces a move with the combined floor, the pool size read at its block and its own id", async () => {
    const t = setup(["lildudes-created", "lildudes-init"], { fetch: slugFetch("lil-dudes") })
    t.chain.nftxPoolCounts.set(LD, (b) => (b >= ARB_BLOCK ? 61 : 60))
    await arbitrageAfter(t, null)
    const [first, second] = await statsEvents()
    expect(String(first!.block)).toBe(INIT_BLOCK.toString())
    expect(second).toMatchObject({
      tx_hash: `nftx:stats:${LD}:${ARB_BLOCK}:11`,
      block: ARB_BLOCK,
      payload: {
        type: "nft.stats",
        source: "chain",
        floorWei: ARB_PRICE.toString(),
        nftxFloorWei: ARB_PRICE.toString(),
        floorMarket: "nftx",
        poolCount: 61,
        nftxSlug: "lil-dudes",
        // Combined history began with the opening's row, more than a day before.
        floor24hAgoWei: "899999999999999",
        maxSupply: null,
      },
    })
    expect(t.chain.poolCountReads.map((r) => r.block)).toEqual([INIT_BLOCK, ARB_BLOCK])
    expect(await collectionRow()).toMatchObject({
      stats_price_wei: String(ARB_PRICE),
      stats_block: ARB_BLOCK,
      pool_count: 61,
      pool_count_block: ARB_BLOCK,
    })
  })

  it("two qualifying moves in one block keep both events and one row per second", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    t.chain.nftxPoolCounts.set(LD, 60)
    await arbitrageAfter(t, ARB_PRICE * 2n, (t) => {
      const real = t.chain.logs.find(
        (l) => l.blockNumber === ARB_BLOCK && l.topics[0] === NFTX_TOPICS.PoolStateUpdated,
      )!
      t.chain.add({ ...real, logIndex: 14, data: setWord(real.data, 0, sqrtFor(ARB_PRICE * 3n)) })
    })
    const atBlock = (await statsEvents()).filter(ARB_STATS)
    expect(atBlock.map((e) => e.tx_hash.split(":").at(-1))).toEqual(["11", "14"])
    const rows = (await statRows()).filter((r) => r.block === ARB_BLOCK.toString())
    expect(rows).toHaveLength(1)
    // The later move is the row.
    expect(BigInt(rows[0]!.nftx_floor_wei as string)).toBe(
      BigInt(atBlock[1]!.payload.nftxFloorWei as string),
    )
  })

  it("with no OpenSea row the nftx stats event has floorMarket nftx and null owners, volume and sales", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    await t.live()
    const [event] = await statsEvents()
    expect(event!.payload).toMatchObject({
      floorMarket: "nftx",
      owners: null,
      volume24hWei: null,
      sales24h: null,
      totalSupply: null,
      listedCount: null,
      listedCapped: false,
      nftxSlug: null,
    })
  })

  it("after the stats table is pruned, a 0.5% move emits no stats", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    await t.live()
    await sql`delete from indexer.nft_stats`
    await sql`
      update indexer.nftx_collections set stats_price_wei = ${((ARB_PRICE * 1000n) / 995n).toString()},
        stats_block = ${INIT_BLOCK.toString()}`
    addFixture(t.chain, loadNftxFixture("arbitrage-lildudes"))
    t.chain.head = ARB_BLOCK + 100n
    await t.idx.trigger()
    expect((await statsEvents()).filter(ARB_STATS)).toHaveLength(0)
  })

  it("a backfilled stats row copies the OpenSea row at or before its own time, not a newer one", async () => {
    const arbitrage = loadNftxFixture("arbitrage-lildudes")
    const osRow = (offsetS: number, owners: number) => ({
      contract: LD,
      at: new Date((arbitrage.timestamp + offsetS) * 1000),
      floor_wei: "500000000000000",
      owners,
      volume_24h_wei: "7",
      sales_24h: owners,
      total_supply: 827,
    })
    await sql`insert into indexer.nft_stats ${sql([osRow(-60, 10), osRow(60, 99)])}`
    const t = setup(["lildudes-created", "lildudes-init", "arbitrage-lildudes"])
    t.chain.nftxPoolCounts.set(LD, 61)
    await t.backfill()
    const row = (await statRows()).find((r) => r.block === ARB_BLOCK.toString())!
    expect(row).toMatchObject({ owners: 10, sales_24h: 10, os_floor_wei: "500000000000000" })
    // The OpenSea floor is the higher one, so the pool's price is the floor.
    expect(row.floor_market).toBe("nftx")
  })

  it("a backfill of earlier blocks leaves the last announced price of later ones", async () => {
    const t = setup(["lildudes-created", "lildudes-init", "arbitrage-lildudes"])
    t.chain.nftxPoolCounts.set(LD, (b) => (b >= ARB_BLOCK ? 61 : 60))
    await t.live()
    await t.idx.backfill(t.firstBlock(), INIT_BLOCK + 10n)
    expect(await collectionRow()).toMatchObject({
      stats_block: ARB_BLOCK,
      stats_price_wei: String(ARB_PRICE),
      pool_count: 61,
      pool_count_block: ARB_BLOCK,
    })
  })

  it("a move in the same second as an OpenSea row leaves that row alone", async () => {
    const arbitrage = loadNftxFixture("arbitrage-lildudes")
    await sql`insert into indexer.nft_stats ${sql({
      contract: LD,
      at: new Date(arbitrage.timestamp * 1000),
      floor_wei: "500000000000000",
      owners: 5,
      volume_24h_wei: "7",
      sales_24h: 1,
      total_supply: 827,
    })}`
    const t = setup(["lildudes-created", "lildudes-init", "arbitrage-lildudes"])
    t.chain.nftxPoolCounts.set(LD, 61)
    await t.backfill()
    const [row] = await sql<{ owners: number; block: bigint | null; floor_wei: string }[]>`
      select owners, block, floor_wei::text from indexer.nft_stats
      where contract = ${LD} and at = ${new Date(arbitrage.timestamp * 1000)}`
    expect(row).toEqual({ owners: 5, block: null, floor_wei: "500000000000000" })
  })

  it("after a backfill (live false) combined history has not begun; the first live row begins it", async () => {
    const t = setup(["lildudes-created", "lildudes-init", "arbitrage-lildudes"])
    t.chain.nftxPoolCounts.set(LD, 60)
    await t.backfill()
    expect((await statsEvents()).length).toBeGreaterThan(0)
    expect((await collectionRow()).combined_since).toBeNull()
    t.chain.head += 20n
    const block = t.chain.head - 5n
    const base = t.chain.logs.find((l) => l.topics[0] === NFTX_TOPICS.PoolStateUpdated)!
    const tx = pad("0x7002", { size: 32 })
    t.chain.add({
      ...base,
      blockNumber: block,
      logIndex: 1,
      transactionHash: tx,
      data: setWord(base.data, 0, sqrtFor(ARB_PRICE * 2n)),
    })
    t.chain.senders.set(block, {
      hash: t.chain.hashOf(block),
      senders: new Map([[tx, CREATOR]]),
      targets: new Map([[tx, NFTX_HOOK]]),
    })
    await t.live()
    expect((await collectionRow()).combined_since).not.toBeNull()
    expect((await statsEvents()).at(-1)!.payload.floor24hAgoWei).toBeNull()
  })

  it("the same span twice writes one row and one event per move", async () => {
    const t = setup(["lildudes-created", "lildudes-init", "arbitrage-lildudes"])
    t.chain.nftxPoolCounts.set(LD, (b) => (b >= ARB_BLOCK ? 61 : 60))
    await t.live()
    const rows = async () => ({
      stats: await statRows(),
      events: await sql`select type, tx_hash, payload from indexer.events order by id`,
      collection: await collectionRow(),
    })
    const before = await rows()
    await t.idx.backfill(t.firstBlock(), t.chain.head)
    expect(await rows()).toEqual(before)
    expect(before.stats).toHaveLength(2)
  })

  it("a transport error from readNftxPoolCounts fails the span and writes no price or stats row", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    t.chain.poolCountError = new Error("rpc down")
    await expect(t.live()).rejects.toThrow("rpc down")
    expect(await sql`select 1 from indexer.nftx_prices`).toHaveLength(0)
    expect(await sql`select 1 from indexer.nft_stats`).toHaveLength(0)
    expect(await sql`select 1 from indexer.events where type = 'nft.stats'`).toHaveLength(0)
    // The loop retries the span once the read works.
    t.chain.poolCountError = undefined
    await t.idx.trigger()
    expect(await sql`select 1 from indexer.nftx_prices`).toHaveLength(2)
    expect((await statsEvents()).length).toBe(1)
  })

  it("a move whose pool size read reverts is announced with a null pool size", async () => {
    const t = setup(["lildudes-created", "lildudes-init"])
    t.chain.nftxPoolCounts.set(LD, null)
    await t.live()
    expect((await statsEvents())[0]!.payload.poolCount).toBeNull()
  })
})

describe("rolling back stats", () => {
  it("removes the moves above the fork, restores the pool size and the last announced price", async () => {
    const t = setup(["lildudes-created", "lildudes-init", "arbitrage-lildudes"], { both: true })
    t.chain.nftxPoolCounts.set(LD, (b) => (b >= ARB_BLOCK ? 61 : 60))
    await t.live()
    expect(await collectionRow()).toMatchObject({ stats_block: ARB_BLOCK, pool_count: 61 })
    t.chain.reorg(ARB_BLOCK)
    await t.idx.trigger()
    expect((await statRows()).map((r) => r.block)).toEqual([INIT_BLOCK.toString()])
    expect(await collectionRow()).toMatchObject({
      stats_block: INIT_BLOCK,
      stats_price_wei: "899999999999999",
      pool_count: 60,
      // The fork is the last block the loop has on record: the opening's.
      pool_count_block: INIT_BLOCK,
    })
    expect(
      await sql`select 1 from indexer.events where type = 'nft.stats' and block >= ${ARB_BLOCK.toString()}`,
    ).toHaveLength(0)
  })

  it("rolling back to before the first announcement clears the last announced price", async () => {
    const t = setup(["lildudes-created", "lildudes-init"], { both: true })
    t.chain.nftxPoolCounts.set(LD, 60)
    await t.live()
    t.chain.reorg(INIT_BLOCK)
    await t.idx.trigger()
    expect(await sql`select 1 from indexer.nft_stats where block is not null`).toHaveLength(0)
    expect(await collectionRow()).toMatchObject({ stats_price_wei: null, stats_block: null })
  })
})
