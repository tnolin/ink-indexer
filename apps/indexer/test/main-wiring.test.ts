import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { type ChainLog, INKYPUMP_START_BLOCK } from "@ink-indexer/sdk"
import { type Address, encodeEventTopics, type Hash, type Hex, pad, parseAbi, toHex } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import { Indexer } from "../src/loop"
import { nftSource } from "../src/sources/nft/index"
import { createStore, type Store } from "../src/store"
import { parseNftEnv, resolveHistoryStart, startNftServices } from "../src/wiring"
import { FakeChain } from "./fake-chain"
import { FakeStream } from "./opensea/fake-ws"

const KEY = "wiring-test-key-0123456789"
const NFT = "0x00000000000000000000000000000000000000a1" as Address
const OWNER = "0x0000000000000000000000000000000000000b0b" as Address
const KNOWN = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const T0 = Date.parse("2026-10-19T00:00:00Z")
const HOUR = 3_600_000

let sql: Sql
let store: Store
let logs: { level: string; msg: string; fields?: Record<string, unknown> }[]
let reports: unknown[]
let clock: number
let stop: (() => void) | undefined
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  logs = []
  reports = []
  clock = T0
  stop = undefined
})
afterEach(async () => {
  stop?.()
  // Lets a scheduler tick that was running finish before the pool closes.
  await sleep(50)
  await sql.end()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log: Logger = (level, msg, fields) => void logs.push({ level, msg, fields })
const report = (e: unknown) => void reports.push(e)
const now = () => clock
async function until(cond: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(10)
  }
}

const TRANSFER = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
])
/** An ERC-721 mint of `tokenId` to OWNER at `block`. */
function mintLog(block: bigint, tokenId: bigint): ChainLog {
  return {
    address: NFT,
    topics: encodeEventTopics({
      abi: TRANSFER,
      eventName: "Transfer",
      args: { from: "0x0000000000000000000000000000000000000000", to: OWNER, tokenId },
    }) as Hex[],
    data: "0x",
    blockNumber: block,
    blockHash: pad(toHex(block), { size: 32 }) as Hash,
    transactionHash: pad(toHex(block * 100n + tokenId), { size: 32 }) as Hash,
    logIndex: 0,
  }
}

/** A chain with mints at blocks 101 and 151, and an indexer over the NFT source. */
async function chainLoop() {
  const chain = new FakeChain(120n)
  chain.add(mintLog(101n, 1n))
  chain.add(mintLog(151n, 2n))
  const indexer = new Indexer({
    chain,
    store,
    logger: () => {},
    sources: [nftSource({ sql, chain, logger: () => {} })],
  })
  // The loop starts at the stored cursor.
  await store.writeBatch([], [], { cursor: { block: 100n, hash: chain.hashOf(100n) }, head: 100n })
  await indexer.init()
  return { chain, indexer }
}

const count = async (table: string, where = "true") =>
  Number((await sql.unsafe(`select count(*)::int as n from indexer.${table} where ${where}`))[0]!.n)

/** A collection OpenSea knows, followed by the stream, and one the discovery job will look up now. */
async function seedCollections() {
  await sql`insert into indexer.nft_collections ${sql({
    contract: KNOWN,
    standard: "erc721",
    slug: "known",
    verdict: "real",
    next_discovery_at: null,
  })}`
  await sql`insert into indexer.nft_collections ${sql({
    contract: NFT,
    standard: "erc721",
    next_discovery_at: new Date(T0 - 1000),
  })}`
}

describe("NFT and OpenSea wiring", () => {
  it("no key: chain sources run, no scheduler, no stream, one warning", async () => {
    const { chain, indexer } = await chainLoop()
    await seedCollections()
    const calls: string[] = []
    const server = new FakeStream()
    const services = await startNftServices({
      env: { OPENSEA_API_KEY: "" },
      sql,
      store,
      chain,
      log,
      report,
      fetch: async (url) => {
        calls.push(String(url))
        return new Response("{}", { status: 200 })
      },
      socket: server.factory,
      now,
      tickMs: 10,
    })
    stop = services.stop
    await indexer.trigger()
    chain.head = 160n
    await indexer.trigger()
    await sleep(100)

    expect(await count("nft_mints")).toBe(2)
    expect(calls).toEqual([])
    expect(server.sockets).toEqual([])
    // The discovery job never ran: the collection is still due.
    expect(await count("nft_collections", `contract = '${NFT}' and discovery_attempts = 0`)).toBe(1)
    expect(logs.filter((l) => l.level === "warn")).toEqual([
      {
        level: "warn",
        msg: "OPENSEA_API_KEY is not set: OpenSea collections, drops, stats and listings are off",
        fields: undefined,
      },
    ])
    expect(reports).toEqual([])
  })

  it("rejected key: OpenSea jobs pause for an hour, the chain loop keeps ingesting, no nft.listing is written", async () => {
    const { chain, indexer } = await chainLoop()
    await seedCollections()
    const calls: string[] = []
    const server = new FakeStream()
    // The real Stream closes a connection whose token it refuses.
    server.refuse = 1_000
    const services = await startNftServices({
      env: {
        OPENSEA_API_KEY: KEY,
        OPENSEA_REQUESTS_PER_HOUR: "120",
        OPENSEA_MIN_INTERVAL_MS: "0",
        NFT_HISTORY_START_BLOCK: "50",
      },
      sql,
      store,
      chain,
      log,
      report,
      fetch: async (url) => {
        calls.push(String(url))
        return new Response(null, { status: 401 })
      },
      socket: server.factory,
      now,
      tickMs: 10,
    })
    stop = services.stop

    const [budget] = await sql`select capacity, min_interval_ms from indexer.opensea_budget`
    expect(budget).toMatchObject({ capacity: 120, min_interval_ms: 0 })
    await until(() => logs.some((l) => l.msg === "opensea jobs paused: key refused"))
    expect(calls).toHaveLength(1)
    expect(server.sockets.length).toBeGreaterThan(0)

    // Paused: ticks keep coming but ask OpenSea nothing, while the chain keeps being ingested.
    clock += HOUR / 2
    await indexer.trigger()
    chain.head = 160n
    await indexer.trigger()
    await sleep(100)
    expect(calls).toHaveLength(1)
    expect(await count("nft_mints")).toBe(2)
    expect((await store.getCursor())?.block).toBe(160n)

    // An hour after the refusal the jobs try again.
    clock += HOUR / 2 + 1
    await until(() => calls.length > 1)

    expect(await count("events", "type = 'nft.listing'")).toBe(0)
    expect(logs.filter((l) => l.msg === "OPENSEA_API_KEY is not set")).toEqual([])
    for (const l of logs)
      expect(JSON.stringify(l, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(
        KEY,
      )
    for (const e of reports) expect(String(e)).not.toContain(KEY)
  })

  it("stop ends the stream, the scheduler and the timers", async () => {
    const { chain } = await chainLoop()
    await seedCollections()
    const calls: string[] = []
    const server = new FakeStream()
    const services = await startNftServices({
      env: { OPENSEA_API_KEY: KEY, NFT_HISTORY_START_BLOCK: "50" },
      sql,
      store,
      chain,
      log,
      report,
      fetch: async (url) => {
        calls.push(String(url))
        return new Response(null, { status: 404 })
      },
      socket: server.factory,
      now,
      tickMs: 10,
    })
    await until(() => calls.length > 0 && server.openSockets().length > 0)
    services.stop()
    await sleep(50)
    const n = calls.length
    expect(server.openSockets()).toEqual([])
    clock += HOUR
    await sleep(100)
    expect(calls).toHaveLength(n)
  })
})

describe("NFT settings", () => {
  it("reads the key, the hourly budget, the spacing and the history start block", () => {
    expect(parseNftEnv({})).toEqual({
      key: undefined,
      perHour: 500,
      minIntervalMs: 300,
      historyStartBlock: undefined,
      invalid: [],
    })
    expect(
      parseNftEnv({
        OPENSEA_API_KEY: ` ${KEY} `,
        OPENSEA_REQUESTS_PER_HOUR: "1200",
        OPENSEA_MIN_INTERVAL_MS: "250",
        NFT_HISTORY_START_BLOCK: "57000000",
      }),
    ).toEqual({
      key: KEY,
      perHour: 1200,
      minIntervalMs: 250,
      historyStartBlock: 57_000_000n,
      invalid: [],
    })
    expect(parseNftEnv({ OPENSEA_MIN_INTERVAL_MS: "0" })).toMatchObject({ minIntervalMs: 0 })
  })

  it("an invalid setting falls back to its default and is listed", () => {
    for (const v of ["-1", "1.5", "abc", "3600001"])
      expect(parseNftEnv({ OPENSEA_MIN_INTERVAL_MS: v }), v).toMatchObject({
        minIntervalMs: 300,
        invalid: [
          {
            variable: "OPENSEA_MIN_INTERVAL_MS",
            reason: "not a whole number from 0 to 3600000",
            using: 300,
          },
        ],
      })
    for (const v of ["0", "-1", "1.5", "abc", "1e3", "500/h"])
      expect(parseNftEnv({ OPENSEA_REQUESTS_PER_HOUR: v }), v).toMatchObject({
        perHour: 500,
        invalid: [
          {
            variable: "OPENSEA_REQUESTS_PER_HOUR",
            reason: "not a whole number from 1 to 2147483647",
            using: 500,
          },
        ],
      })
    for (const v of ["-1", "0x10", "abc"])
      expect(parseNftEnv({ NFT_HISTORY_START_BLOCK: v }), v).toMatchObject({
        historyStartBlock: undefined,
        invalid: [
          { variable: "NFT_HISTORY_START_BLOCK", reason: "not a block number", using: null },
        ],
      })
  })

  it("a key pasted into a setting is never logged, not even a prefix of it", async () => {
    const pasted = "9f2c41d07be35a68c1e09d4473fa2b6e"
    const chain = new FakeChain(100n)
    for (const variable of [
      "OPENSEA_REQUESTS_PER_HOUR",
      "OPENSEA_MIN_INTERVAL_MS",
      "NFT_HISTORY_START_BLOCK",
    ]) {
      logs = []
      const services = await startNftServices({
        env: { [variable]: pasted },
        sql,
        store,
        chain,
        log,
        report,
      })
      services.stop()
      const warning = logs.find((l) => l.fields?.variable === variable)
      expect(warning, variable).toBeDefined()
      const text = JSON.stringify(logs)
      for (let n = 5; n <= pasted.length; n++)
        for (let i = 0; i + n <= pasted.length; i++)
          expect(text, variable).not.toContain(pasted.slice(i, i + n))
    }
  })

  it("no key and OPENSEA_REQUESTS_PER_HOUR=abc: the chain loop starts and one warning names the variable", async () => {
    const { chain, indexer } = await chainLoop()
    const services = await startNftServices({
      env: { OPENSEA_REQUESTS_PER_HOUR: "abc" },
      sql,
      store,
      chain,
      log,
      report,
    })
    stop = services.stop
    await indexer.trigger()
    expect(await count("nft_mints")).toBe(1)
    const bad = logs.filter((l) => l.level === "warn" && l.fields?.variable !== undefined)
    expect(bad).toEqual([
      {
        level: "warn",
        msg: "invalid NFT setting ignored",
        fields: {
          variable: "OPENSEA_REQUESTS_PER_HOUR",
          reason: "not a whole number from 1 to 2147483647",
          using: 500,
        },
      },
    ])
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(2)
  })

  it("a key and OPENSEA_MIN_INTERVAL_MS=-5: the budget uses 300 ms and one warning names the variable", async () => {
    const chain = new FakeChain(100n)
    const services = await startNftServices({
      env: { OPENSEA_API_KEY: KEY, OPENSEA_MIN_INTERVAL_MS: "-5", NFT_HISTORY_START_BLOCK: "50" },
      sql,
      store,
      chain,
      log,
      report,
      fetch: async () => new Response(null, { status: 404 }),
      socket: new FakeStream().factory,
      now,
      tickMs: 10_000,
    })
    stop = services.stop
    const [budget] = await sql`select capacity, min_interval_ms from indexer.opensea_budget`
    expect(budget).toMatchObject({ capacity: 500, min_interval_ms: 300 })
    expect(logs.filter((l) => l.level === "warn")).toEqual([
      {
        level: "warn",
        msg: "invalid NFT setting ignored",
        fields: {
          variable: "OPENSEA_MIN_INTERVAL_MS",
          reason: "not a whole number from 0 to 3600000",
          using: 300,
        },
      },
    ])
  })

  it("history start: the configured block, else the first stored mint, else where the loop starts", async () => {
    const chain = new FakeChain(1_000n)
    // FakeChain block n has timestamp n.
    expect(await resolveHistoryStart(sql, chain, 300n)).toEqual({ block: 300n, ts: 300 })

    // No mint and no cursor: the history starts at the loop's first block.
    const fresh = await resolveHistoryStart(sql, new FakeChain(10n ** 9n), undefined)
    expect(fresh.block).toBe(INKYPUMP_START_BLOCK)

    await store.writeBatch([], [], {
      cursor: { block: 700n, hash: chain.hashOf(700n) },
      head: 700n,
    })
    expect(await resolveHistoryStart(sql, chain, undefined)).toEqual({ block: 701n, ts: 701 })
    // A configured block the chain cannot date (above head) falls back, with a warning.
    expect(await resolveHistoryStart(sql, chain, 5_000n, log)).toEqual({ block: 701n, ts: 701 })
    expect(logs).toEqual([
      {
        level: "warn",
        msg: "NFT_HISTORY_START_BLOCK cannot be dated; using the stored history",
        fields: undefined,
      },
    ])

    // The first mint's time comes from its collection row (it survives the mint rows' pruning).
    await sql`insert into indexer.nft_collections ${sql({
      contract: KNOWN,
      first_mint_block: 450,
      first_mint_ts: new Date(1_700_000_000_000),
    })}`
    await sql`insert into indexer.nft_mints ${sql({
      tx_hash: "0x01",
      log_index: 0,
      idx: 0,
      contract: NFT,
      token_id: "1",
      recipient: OWNER,
      qty: "1",
      block: 500,
    })}`
    expect(await resolveHistoryStart(sql, chain, undefined)).toEqual({
      block: 450n,
      ts: 1_700_000_000,
    })
    await sql`delete from indexer.nft_collections`
    // Only a stored mint: its time is read from the chain.
    expect(await resolveHistoryStart(sql, chain, undefined)).toEqual({ block: 500n, ts: 500 })
  })
})
