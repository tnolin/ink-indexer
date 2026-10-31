import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  CALAMARI_POOL_MANAGER,
  type ChainLog,
  decodeTsunamiLog,
  TSUNAMI_FACTORY,
  TSUNAMI_FACTORY_2,
  TSUNAMI_HOOKS,
  TSUNAMI_TOPICS,
  tsunamiLaunchId,
  tsunamiMarketCap,
} from "@ink-indexer/sdk"
import { type Address, pad } from "viem"
import { describe, expect, inject, it } from "vitest"
import { loadTsunamiFixture } from "../../../packages/sdk/test/fixtures"
import { BlockNotServedError } from "../src/errors"
import type { Logger } from "../src/log"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import { tsunamiSource } from "../src/sources/tsunami/index"
import { createStore } from "../src/store"
import { FakeChain } from "./fake-chain"
import { addFixture, ETH, seedToken } from "./tsunami-scenario"

const GATEWAY = "https://gw.example"
const SHITCOIN_CID = "QmcaeX23WJnjF1khSSyHcA9MdrK9ryz6uu4KN3zfE1kdiK"
const GM_CID = "QmNZaPhzN42DT4Z4XkuCF6fgK9sS1XR7zEoDzyH7Mmtw7V"
const recorded = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../packages/sdk/test/fixtures", name), "utf8"),
  )
const DOCS: Record<string, unknown> = {
  [SHITCOIN_CID]: recorded("tsunami-metadata-shitcoin.json"),
  [GM_CID]: recorded("tsunami-metadata-gm.json"),
}

type Fetch = typeof fetch
const metadataFetch = (docs: Record<string, unknown> = DOCS, calls: string[] = []): Fetch =>
  (async (url: string) => {
    calls.push(url)
    const doc = docs[url.replace(`${GATEWAY}/ipfs/`, "")]
    return doc === undefined ? new Response("nope", { status: 404 }) : Response.json(doc)
  }) as unknown as Fetch

const unknownWarnings = <T extends { msg: string }>(w: T[]) =>
  w.filter((x) => x.msg === "ignoring Tsunami-shaped event from an unknown contract")

async function setup(opts: { fetch?: Fetch } = {}) {
  const sql: Sql = await resetDb(inject("databaseUrl"))
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
  const logger: Logger = (level, msg, fields) => {
    if (level === "warn") warnings.push({ msg, fields })
  }
  const chain = new FakeChain(60_000_000n)
  const pools = new PoolRegistry()
  const source = tsunamiSource({
    sql,
    chain,
    logger,
    pools,
    ipfs: { gateway: GATEWAY, fetch: opts.fetch ?? metadataFetch() },
  })
  // InkyPump's rollback removes the token, trade, pool and bond rows above a fork for every launchpad.
  const inkypump = inkypumpSource({ sql, chain, logger, pools })
  const store = createStore(sql)
  await inkypump.reload()
  await source.reload()
  const batchOf = (to: bigint, from = 0n) =>
    source.process([chain.logsIn(from, to)], { toBlock: to, live: false })
  const ingest = async (to: bigint, from = 0n) => {
    const batch = await batchOf(to, from)
    await store.writeBatch([batch], [(tx) => source.write(tx, batch)], {
      cursor: { block: to, hash: chain.hashOf(to) },
      head: to,
    })
    return batch
  }
  const rollback = async (fork: bigint) => {
    const base = await inkypump.prepareRollback(fork)
    const prepared = await source.prepareRollback(fork)
    await store.rollback(fork, chain.hashOf(fork), [
      (tx) => inkypump.rollback(tx, fork, base),
      (tx) => source.rollback(tx, fork, prepared),
    ])
    await inkypump.reload()
    await source.reload()
  }
  return { sql, chain, pools, source, warnings, batchOf, ingest, rollback }
}

const eventsOf = (batch: { events: { event: { type: string } }[] }, type: string) =>
  batch.events.map((e) => e.event).filter((e) => e.type === type)

describe("Tsunami launches", () => {
  it("a launch emits launchpad.launch with metadata and the hook from its Initialize", async () => {
    const calls: string[] = []
    const t = await setup({ fetch: metadataFetch(DOCS, calls) })
    try {
      const f = addFixture(t.chain, "tsunami-launch-gm")
      const batch = await t.batchOf(f.blockNumber)
      const [launch] = eventsOf(batch, "launchpad.launch")
      expect(launch).toMatchObject({
        launchpad: "tsunami",
        token: f.curves[0]?.token,
        launchId: tsunamiLaunchId(f.curves[0]!.curve),
        hook: TSUNAMI_HOOKS.current,
        quoteAsset: ETH,
        targetRaise: "4200000000000000000",
        totalSupply: "1000000000000000000000000000",
        name: "GM",
        ticker: "GM",
        description: null,
        imageUrl:
          "https://images.inkjet.trade/marks/8928869bf3444cbdce574294876e7c2761103de3804c6d5c5843ecdf95cc9d9d-1024.webp",
      })
      expect(calls).toEqual([`${GATEWAY}/ipfs/${GM_CID}`])
    } finally {
      await t.sql.end()
    }
  })

  it("the hook is the one the launch transaction's Initialize names, here the first hook (legacy SMOKE)", async () => {
    const t = await setup({ fetch: metadataFetch({}) })
    try {
      const f = addFixture(t.chain, "tsunami-legacy-smoke")
      const batch = await t.batchOf(f.blockNumber)
      const [launch] = eventsOf(batch, "launchpad.launch")
      expect(launch).toMatchObject({
        hook: TSUNAMI_HOOKS.first,
        totalSupply: "1000000000000000000000000000",
      })
      expect(batch.tokens[0]?.hook).toBe(TSUNAMI_HOOKS.first)
    } finally {
      await t.sql.end()
    }
  })

  it("the seed buy in the launch transaction is a trade by the creator, after the launch event", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-riptide")
      const batch = await t.batchOf(f.blockNumber)
      expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.launch", "launchpad.trade"])
      const [launch, trade] = batch.events.map((e) => e.event)
      expect(launch?.logIndex).toBeLessThan(trade?.logIndex ?? 0)
      expect(trade).toMatchObject({
        side: "buy",
        trader: f.sender,
        // The seed buy's buyer is the factory; the trader is the transaction's sender.
        token: f.curves[0]?.token,
        quoteAsset: ETH,
      })
      expect(batch.trades).toHaveLength(1)
      expect(batch.trades[0]?.trader).toBe(f.sender)
    } finally {
      await t.sql.end()
    }
  })

  it("a Riptide launch's market cap uses 1B, not 2B", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-riptide")
      const c = f.curves[0]!
      expect(c.totalSupply).toBe(2n * 10n ** 27n)
      expect(c.vaultBalance).toBe(10n ** 27n)
      const batch = await t.batchOf(f.blockNumber)
      const [launch, trade] = batch.events.map((e) => e.event)
      expect(launch).toMatchObject({ totalSupply: String(10n ** 27n) })
      const seed = decodeTsunamiLog(f.logs.find((l) => l.topics[0] === TSUNAMI_TOPICS.bought)!)
      if (seed?.kind !== "bought") throw new Error("no seed buy")
      expect(trade).toMatchObject({
        marketCap: tsunamiMarketCap(seed.state, 10n ** 27n).toString(),
      })
      expect(batch.tokens[0]?.totalSupply).toBe(10n ** 27n)
      expect(t.chain.balanceReads).toHaveLength(1)
      expect(batch.curve[0]?.marketCap).toBe(tsunamiMarketCap(seed.state, 10n ** 27n))
    } finally {
      await t.sql.end()
    }
  })

  it("a launch without an Initialize uses the current hook and warns once (synthetic)", async () => {
    const t = await setup()
    try {
      const f = loadTsunamiFixture("tsunami-launch-riptide")
      addFixture(t.chain, "tsunami-launch-riptide")
      t.chain.logs = t.chain.logs.filter((l) => l.address !== CALAMARI_POOL_MANAGER)
      const batch = await t.batchOf(f.blockNumber)
      expect(eventsOf(batch, "launchpad.launch")[0]).toMatchObject({ hook: TSUNAMI_HOOKS.current })
      expect(
        t.warnings.filter((w) => w.msg === "launch without a Calamari Initialize"),
      ).toHaveLength(1)
    } finally {
      await t.sql.end()
    }
  })

  it("an Initialize in the launch transaction for another token is not used as the launch's hook (synthetic)", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-riptide")
      const other = pad("0x00000000000000000000000000000000000000ab", { size: 32 })
      t.chain.logs = t.chain.logs.map((l) => {
        if (l.address !== CALAMARI_POOL_MANAGER) return l
        // Name another pair, and give it another hook.
        const data =
          l.data.slice(0, 2 + 64 * 2) +
          pad(TSUNAMI_HOOKS.first, { size: 32 }).slice(2) +
          l.data.slice(2 + 64 * 3)
        return {
          ...l,
          topics: [l.topics[0]!, l.topics[1]!, other, other],
          data: data as ChainLog["data"],
        }
      })
      const batch = await t.batchOf(f.blockNumber)
      expect(eventsOf(batch, "launchpad.launch")[0]).toMatchObject({ hook: TSUNAMI_HOOKS.current })
    } finally {
      await t.sql.end()
    }
  })

  it("an Initialize from a contract other than Calamari's PoolManager is not used as the hook (synthetic)", async () => {
    const t = await setup({ fetch: metadataFetch({}) })
    try {
      const f = addFixture(t.chain, "tsunami-legacy-smoke")
      // SMOKE's own Initialize names the first hook; from another emitter it must not count.
      t.chain.logs = t.chain.logs.map((l) =>
        l.address === CALAMARI_POOL_MANAGER
          ? { ...l, address: "0x360e68faccca8ca495c1b759fd9eee466db9fb32" }
          : l,
      )
      const batch = await t.batchOf(f.blockNumber)
      expect(eventsOf(batch, "launchpad.launch")[0]).toMatchObject({ hook: TSUNAMI_HOOKS.current })
    } finally {
      await t.sql.end()
    }
  })

  it("a launch whose metadata fetch fails is written text-only", async () => {
    const t = await setup({ fetch: metadataFetch({}) })
    try {
      const f = addFixture(t.chain, "tsunami-launch-riptide")
      const batch = await t.batchOf(f.blockNumber)
      expect(eventsOf(batch, "launchpad.launch")[0]).toMatchObject({
        name: "Shitcoin",
        description: null,
        imageUrl: null,
      })
      expect(t.warnings.filter((w) => w.msg === "token metadata not fetched")).toHaveLength(1)
    } finally {
      await t.sql.end()
    }
  })

  it("a launch with a creator-hosted https URI is written text-only without a fetch", async () => {
    const calls: string[] = []
    const t = await setup({ fetch: metadataFetch(DOCS, calls) })
    try {
      const f = addFixture(t.chain, "tsunami-launch-gm")
      // Same transaction, but the URI now points at a host of the creator's choosing.
      const d = decodeTsunamiLog(f.logs.find((l) => l.topics[0] === TSUNAMI_TOPICS.launched)!)
      if (d?.kind !== "launched") throw new Error("no launch")
      const swapped = f.logs.map((l) =>
        l.topics[0] === TSUNAMI_TOPICS.launched
          ? {
              ...l,
              data: l.data.replace(
                Buffer.from(d.uri).toString("hex"),
                Buffer.from("https://evil.example/m.json".padEnd(d.uri.length, " ")).toString(
                  "hex",
                ),
              ),
            }
          : l,
      )
      t.chain.logs = swapped as ChainLog[]
      const batch = await t.batchOf(f.blockNumber)
      expect(eventsOf(batch, "launchpad.launch")[0]).toMatchObject({
        description: null,
        imageUrl: null,
      })
      expect(calls).toEqual([])
    } finally {
      await t.sql.end()
    }
  })
})

describe("Tsunami trust", () => {
  const readdressed = (logs: ChainLog[], from: Address, to: Address) =>
    logs.map((l) => (l.address === from ? { ...l, address: to } : l))

  it("a TokenBought from an unknown contract is ignored with one warning", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-riptide")
      const curve = f.curves[0]!.curve
      const stranger = "0x00000000000000000000000000000000000000f1" as Address
      t.chain.logs = readdressed(t.chain.logs, curve, stranger)
      t.chain.logs = t.chain.logs.concat(
        t.chain.logs.filter((l) => l.address === stranger).map((l) => ({ ...l, logIndex: 99 })),
      )
      const batch = await t.batchOf(f.blockNumber)
      expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.launch"])
      expect(unknownWarnings(t.warnings)).toHaveLength(1)
      expect(t.warnings[0]?.fields).toMatchObject({ address: stranger })
    } finally {
      await t.sql.end()
    }
  })

  it("a TokenLaunched from the second factory is accepted (synthetic)", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-gm")
      t.chain.logs = readdressed(t.chain.logs, TSUNAMI_FACTORY, TSUNAMI_FACTORY_2)
      const batch = await t.batchOf(f.blockNumber)
      expect(eventsOf(batch, "launchpad.launch")).toHaveLength(1)
    } finally {
      await t.sql.end()
    }
  })

  it("a TokenLaunched from any other address is ignored", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-gm")
      t.chain.logs = readdressed(
        t.chain.logs,
        TSUNAMI_FACTORY,
        "0x00000000000000000000000000000000000000f2",
      )
      const batch = await t.batchOf(f.blockNumber)
      expect(batch.events).toEqual([])
      expect(batch.tokens).toEqual([])
      expect(unknownWarnings(t.warnings).length).toBeGreaterThan(0)
    } finally {
      await t.sql.end()
    }
  })

  it("an Initialize outside a launch transaction is ignored without a warning", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-pool-move")
      t.chain.logs = t.chain.logs.filter((l) => l.address === CALAMARI_POOL_MANAGER)
      expect(t.chain.logs).toHaveLength(1)
      const batch = await t.batchOf(f.blockNumber)
      expect(batch.events).toEqual([])
      expect(t.warnings).toEqual([])
      expect(t.chain.getBlockSendersCalls).toBe(0)
    } finally {
      await t.sql.end()
    }
  })

  it("one getBlockSenders per block with Tsunami logs", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-riptide")
      await t.batchOf(f.blockNumber)
      expect(f.logs).toHaveLength(3)
      expect(t.chain.getBlockSendersCalls).toBe(1)
      expect(t.chain.readBalancesCalls).toBe(1)
    } finally {
      await t.sql.end()
    }
  })

  it("a block the endpoint does not serve fails the span, and so does a mismatched hash", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-gm")
      t.chain.senders.delete(f.blockNumber)
      await expect(t.batchOf(f.blockNumber)).rejects.toBeInstanceOf(BlockNotServedError)
      t.chain.senders.set(f.blockNumber, {
        hash: pad("0x01", { size: 32 }),
        senders: new Map([[f.txHash, f.sender]]),
      })
      await expect(t.batchOf(f.blockNumber)).rejects.toBeInstanceOf(BlockNotServedError)
    } finally {
      await t.sql.end()
    }
  })

  it("a malformed Tsunami log is skipped and the rest of the span is written", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-gm")
      const bad = f.logs.find((l) => l.topics[0] === TSUNAMI_TOPICS.bought)!
      t.chain.logs = t.chain.logs.map((l) => (l === bad ? { ...l, data: "0x1234" } : l))
      const batch = await t.batchOf(f.blockNumber)
      expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.launch"])
    } finally {
      await t.sql.end()
    }
  })
})

describe("Tsunami curve trades", () => {
  it("a sell through a router has the transaction sender as trader", async () => {
    const t = await setup()
    try {
      const f = loadTsunamiFixture("tsunami-sell")
      const c = f.curves[0]!
      await seedToken(t.sql, { curve: c.curve, token: c.token })
      await t.source.reload()
      addFixture(t.chain, "tsunami-sell")
      const sell = decodeTsunamiLog(f.logs[0]!)
      if (sell?.kind !== "sold") throw new Error("no sell")
      expect(sell.buyer).not.toBe(f.sender)
      const batch = await t.batchOf(f.blockNumber, f.blockNumber)
      expect(batch.events[0]?.event).toMatchObject({
        type: "launchpad.trade",
        side: "sell",
        trader: f.sender,
        tokenAmount: sell.amount.toString(),
        quoteAmount: sell.amountOut.toString(),
      })
      expect(batch.trades[0]).toMatchObject({
        side: "sell",
        trader: f.sender,
        amountIn: sell.amount,
        amountOut: sell.amountOut,
      })
    } finally {
      await t.sql.end()
    }
  })

  it("curve trades carry SHITCOIN's progress as the site shows it", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-riptide")
      const batch = await t.batchOf(f.blockNumber)
      const trade = eventsOf(batch, "launchpad.trade")[0]
      // 0.015048 ETH raised of 4.2: 35 bps.
      expect(trade).toMatchObject({
        curveValue: "15048000000000000",
        target: "4200000000000000000",
        progressBpsBefore: 0,
        progressBpsAfter: 35,
        soldBps: 35,
      })
      expect(batch.curve[0]).toMatchObject({ progressBps: 35, curveValue: 15_048_000_000_000_000n })
    } finally {
      await t.sql.end()
    }
  })

  it("a trade on a curve created in an earlier span is accepted after a reload (synthetic)", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-riptide")
      await t.ingest(f.blockNumber)
      await t.source.reload()
      t.warnings.length = 0
      // The seed buy's log moved to a later block and transaction.
      const seed = f.logs.find((l) => l.topics[0] === TSUNAMI_TOPICS.bought)!
      const later = f.blockNumber + 10n
      const tx = pad("0xabc1", { size: 32 })
      t.chain.add({ ...seed, blockNumber: later, transactionHash: tx, logIndex: 3 })
      t.chain.senders.set(later, {
        hash: t.chain.hashOf(later),
        senders: new Map([[tx, "0x00000000000000000000000000000000000000b2"]]),
      })
      const batch = await t.batchOf(later, later)
      expect(unknownWarnings(t.warnings)).toEqual([])
      expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.trade"])
      expect(batch.events[0]?.event).toMatchObject({
        token: f.curves[0]?.token,
        progressBpsBefore: 35,
        trader: "0x00000000000000000000000000000000000000b2",
      })
    } finally {
      await t.sql.end()
    }
  })
})

describe("Tsunami through the database", () => {
  const rows = async (sql: Sql) => ({
    tokens:
      await sql`select address, hook, launch_id, launchpad, target_raise::text, sale_supply::text,
      total_supply::text, gain_bps, quote_asset, ath_market_cap::text, ath_block, phase from indexer.tokens order by address`,
    state:
      await sql`select token, progress_bps, curve_value::text, market_cap::text, updated_block from indexer.curve_state order by token`,
    trades:
      await sql`select tx_hash, log_index, side, trader, amount_in::text, amount_out::text, block, venue from indexer.trades order by block, log_index`,
    events:
      await sql`select type, entity, payload, block, tx_hash, log_index from indexer.events order by id`,
  })

  it("writes the token, its curve state and trades", async () => {
    const t = await setup()
    try {
      const f = addFixture(t.chain, "tsunami-launch-riptide")
      await t.ingest(f.blockNumber)
      const r = await rows(t.sql)
      expect(r.tokens).toMatchObject([
        {
          address: f.curves[0]?.token,
          hook: TSUNAMI_HOOKS.current,
          launchpad: "tsunami",
          launch_id: tsunamiLaunchId(f.curves[0]!.curve),
          target_raise: "4200000000000000000",
          sale_supply: "793100000000000000000000000",
          total_supply: String(10n ** 27n),
          gain_bps: null,
          quote_asset: ETH,
          phase: "curve",
        },
      ])
      expect(r.state).toMatchObject([{ progress_bps: 35, curve_value: "15048000000000000" }])
      expect(r.trades).toMatchObject([{ side: "buy", trader: f.sender, venue: "curve" }])
      expect(r.events.map((e) => e.type)).toEqual(["launchpad.launch", "launchpad.trade"])
    } finally {
      await t.sql.end()
    }
  })

  it("processing the same span twice writes identical rows", async () => {
    const t = await setup()
    try {
      const a = addFixture(t.chain, "tsunami-launch-riptide")
      const b = addFixture(t.chain, "tsunami-launch-usdc-buyer")
      const c = addFixture(t.chain, "tsunami-usdc-buy")
      const to = [a, b, c].map((f) => f.blockNumber).reduce((x, y) => (x > y ? x : y))
      const first = await t.ingest(to)
      expect(first.ath.length).toBeGreaterThan(0)
      const before = await rows(t.sql)
      expect(before.trades).toHaveLength(2)
      const top = first.ath.find((x) => x.token === a.curves[0]?.token)!
      expect(before.tokens.find((x) => x.address === top.token)?.ath_market_cap).toBe(
        top.marketCap.toString(),
      )
      const second = await t.ingest(to)
      expect(second.ath).toEqual([])
      expect(await rows(t.sql)).toEqual(before)
    } finally {
      await t.sql.end()
    }
  })

  it("rollback restores curve state read at the fork", async () => {
    const t = await setup()
    try {
      const a = addFixture(t.chain, "tsunami-launch-riptide")
      const c = a.curves[0]!
      const atFork = c.state
      await t.ingest(a.blockNumber)
      // A later span moved the curve; the fork is the launch block.
      await t.sql`update indexer.curve_state set progress_bps = 4000, curve_value = 1, market_cap = 1, updated_block = ${(a.blockNumber + 50n).toString()}`
      t.chain.tsunamiCurves.set(c.curve, atFork)
      await t.rollback(a.blockNumber)
      expect(t.chain.tsunamiCurveReads).toEqual([{ curves: [c.curve], block: a.blockNumber }])
      const [state] =
        await t.sql`select progress_bps, curve_value::text, market_cap::text, updated_block from indexer.curve_state`
      expect(state).toMatchObject({ progress_bps: 35, curve_value: "15048000000000000" })
      expect(BigInt(state?.market_cap)).toBe(tsunamiMarketCap(atFork, 10n ** 27n))
      expect(state?.updated_block).toBe(a.blockNumber)
    } finally {
      await t.sql.end()
    }
  })

  it("rollback below a launch removes the token and reads nothing", async () => {
    const t = await setup()
    try {
      const a = addFixture(t.chain, "tsunami-launch-gm")
      await t.ingest(a.blockNumber)
      await t.rollback(a.blockNumber - 5n)
      expect(t.chain.tsunamiCurveReads).toEqual([])
      expect(await t.sql`select address from indexer.tokens where launchpad = 'tsunami'`).toEqual(
        [],
      )
    } finally {
      await t.sql.end()
    }
  })
})
