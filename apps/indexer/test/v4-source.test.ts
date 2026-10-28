import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  DEAD_ADDRESS,
  decodeSwap,
  marketCap,
  NATIVE_QUOTE_ASSET,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import { type Address, type Hash, HttpRequestError, pad, toHex } from "viem"
import { describe, expect, inject, it } from "vitest"
import { swapLog, transferLog } from "../../../packages/sdk/test/builders"
import { loadV4Fixture } from "../../../packages/sdk/test/fixtures"
import { BlockNotServedError } from "../src/errors"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { type PoolEntry, PoolRegistry } from "../src/sources/pools"
import { v4Source } from "../src/sources/v4/index"
import { createStore } from "../src/store"
import { FakeChain } from "./fake-chain"
import { bond, launch, launchIdOf, tokenOf, trade } from "./scenario"

const B = 45_300_000n
const Q96 = 1n << 96n
const SUPPLY = 10n ** 27n
const TOKEN = tokenOf(1)
const POOL = launchIdOf(1)
const ROUTER: Address = "0x00000000000000000000000000000000000000f1"
const BUYER: Address = "0x00000000000000000000000000000000000000b1"
const DEAD_KEY = `${TOKEN}:${DEAD_ADDRESS}`

const entry = (n: number): PoolEntry => ({
  poolId: launchIdOf(n),
  poolManager: UNISWAP_V4_POOL_MANAGER,
  token: tokenOf(n),
  launchId: launchIdOf(n),
  launchpad: "inkypump",
  quoteAsset: NATIVE_QUOTE_ASSET,
  // The native quote is the zero address, so the token is always currency1.
  tokenIsCurrency0: false,
  createdBlock: B - 10n,
})

let txCounter = 0
const nextTx = () => pad(toHex(0xc0ffee000 + ++txCounter), { size: 32 }) as Hash

/** Records `trader` as the sender of `tx` in `block`, with the block's own hash. */
function sender(chain: FakeChain, block: bigint, tx: Hash, trader: Address) {
  const s = chain.senders.get(block) ?? { hash: chain.hashOf(block), senders: new Map() }
  s.senders.set(tx, trader)
  chain.senders.set(block, s)
}

/**
 * A buy in `poolId` (default the registered pool). With the token as currency1, a √P of 2⁹⁶
 * values the token at one quote unit, so the market cap equals the supply; half that √P is four
 * times the market cap.
 */
function swap(
  chain: FakeChain,
  a: {
    block: bigint
    sqrtPriceX96?: bigint
    logIndex?: number
    tx?: Hash
    poolId?: Hash
    trader?: Address
    side?: "buy" | "sell"
  },
): Hash {
  const tx = a.tx ?? nextTx()
  const buy = (a.side ?? "buy") === "buy"
  chain.add(
    swapLog(
      {
        poolId: a.poolId ?? POOL,
        sender: ROUTER,
        amount0: buy ? -(10n ** 15n) : 10n ** 15n,
        amount1: buy ? 10n ** 20n : -(10n ** 20n),
        sqrtPriceX96: a.sqrtPriceX96 ?? Q96,
        liquidity: 10n ** 21n,
      },
      { blockNumber: a.block, transactionHash: tx, logIndex: a.logIndex ?? 0 },
    ),
  )
  sender(chain, a.block, tx, a.trader ?? BUYER)
  return tx
}

function burn(chain: FakeChain, a: { block: bigint; value: bigint; logIndex?: number }) {
  chain.add(
    transferLog(
      { from: BUYER, to: DEAD_ADDRESS, value: a.value },
      {
        address: TOKEN,
        blockNumber: a.block,
        transactionHash: nextTx(),
        logIndex: a.logIndex ?? 0,
      },
    ),
  )
}

function setup(head = B + 20n, registered: PoolEntry[] = [entry(1)]) {
  const chain = new FakeChain(head)
  const pools = new PoolRegistry()
  for (const p of registered) pools.add(p, SUPPLY)
  const source = v4Source({ sql: {} as Sql, chain, logger: () => {}, pools })
  /** Processes [from, to] as a backfill span, or as the live tick's with `live`. */
  const run = (to: bigint, from = B - 100n, live = false) =>
    source.process(
      source.filters().map((f) => (f ? chain.logsIn(from, to, f) : [])),
      { toBlock: to, live },
    )
  return { chain, pools, source, run }
}

describe("v4 source", () => {
  it("emits launchpad.swap for a registered pool with trader from the block", async () => {
    const f = loadV4Fixture("v4-inkypump-buy")
    const swapLogOf = f.logs.find((l) => decodeSwap(l) !== null)!
    const decoded = decodeSwap(swapLogOf)!
    const token = f.logs.find((l) => l.address !== UNISWAP_V4_POOL_MANAGER)!.address
    const { chain, run } = setup(f.blockNumber + 10n, [
      { ...entry(9), poolId: decoded.poolId, token },
    ])
    for (const l of f.logs) chain.add(l)
    chain.senders.set(f.blockNumber, {
      hash: chain.hashOf(f.blockNumber),
      senders: new Map(Object.entries(f.senders) as [Hash, Address][]),
    })
    const batch = await run(f.blockNumber, f.blockNumber)
    expect(batch.events).toHaveLength(1)
    expect(batch.events[0]).toMatchObject({
      block: f.blockNumber,
      blockHash: chain.hashOf(f.blockNumber),
      event: {
        type: "launchpad.swap",
        launchpad: "inkypump",
        token,
        launchId: launchIdOf(9),
        poolId: decoded.poolId,
        poolManager: UNISWAP_V4_POOL_MANAGER,
        side: "buy",
        trader: f.senders[f.txHash],
        router: decoded.sender,
        quoteAsset: NATIVE_QUOTE_ASSET,
        supply: String(SUPPLY),
        txHash: f.txHash,
        logIndex: swapLogOf.logIndex,
        blockNumber: String(f.blockNumber),
        blockTimestamp: Number(f.blockNumber),
      },
    })
    expect(batch.trades).toEqual([
      {
        txHash: f.txHash,
        logIndex: swapLogOf.logIndex,
        token,
        poolId: decoded.poolId,
        side: "buy",
        trader: f.senders[f.txHash],
        amountIn: -decoded.amount0,
        amountOut: decoded.amount1,
        block: f.blockNumber,
      },
    ])
  })

  it("ignores swaps in unregistered pools and makes no sender read", async () => {
    const { chain, source } = setup()
    swap(chain, { block: B, poolId: launchIdOf(2) })
    const batch = await source.process([chain.logsIn(0n, B), []], { toBlock: B, live: false })
    expect(batch.events).toEqual([])
    expect(batch.trades).toEqual([])
    expect(batch.blocks).toEqual([])
    expect(chain.getBlockSendersCalls).toBe(0)
  })

  it("ignores transfers that do not go to the dead address", async () => {
    const { chain, source, pools } = setup()
    chain.add(
      transferLog(
        { from: BUYER, to: ROUTER, value: 5n },
        { address: TOKEN, blockNumber: B, transactionHash: nextTx() },
      ),
    )
    const batch = await source.process([[], chain.logsIn(0n, B)], { toBlock: B, live: false })
    expect(batch.blocks).toEqual([])
    expect(pools.marks(TOKEN)?.deadBalance).toBe(0n)
  })

  it("one getBlockSenders call per block with tracked swaps", async () => {
    const { chain, run } = setup()
    swap(chain, { block: B, logIndex: 0 })
    swap(chain, { block: B, logIndex: 1 })
    swap(chain, { block: B + 1n })
    const batch = await run(B + 1n)
    expect(batch.events).toHaveLength(3)
    expect(chain.getBlockSendersCalls).toBe(2)
  })

  it("a block hash that differs from the logs fails the span", async () => {
    const { chain, run } = setup()
    const tx = swap(chain, { block: B })
    chain.senders.set(B, { hash: chain.hashOf(B + 1n), senders: new Map([[tx, BUYER]]) })
    await expect(run(B)).rejects.toBeInstanceOf(BlockNotServedError)
  })

  it("a block the endpoint does not serve fails the span", async () => {
    const { chain, run } = setup()
    swap(chain, { block: B })
    chain.senders.delete(B)
    await expect(run(B)).rejects.toBeInstanceOf(BlockNotServedError)
  })

  it("a swap whose tx has no sender fails the span", async () => {
    const { chain, run } = setup()
    swap(chain, { block: B })
    chain.senders.set(B, { hash: chain.hashOf(B), senders: new Map() })
    await expect(run(B)).rejects.toBeInstanceOf(BlockNotServedError)
  })

  it("the batch lists each block with a kept log and its hash", async () => {
    const { chain, pools, run } = setup()
    pools.setDead(TOKEN, 0n, B - 50n)
    swap(chain, { block: B })
    burn(chain, { block: B + 1n, value: 1n })
    swap(chain, { block: B + 2n, poolId: launchIdOf(2) })
    const batch = await run(B + 2n)
    expect(batch.blocks).toEqual([
      { number: B, hash: chain.hashOf(B) },
      { number: B + 1n, hash: chain.hashOf(B + 1n) },
    ])
  })

  it("market cap subtracts the dead balance", async () => {
    const { chain, run } = setup()
    chain.balances.set(DEAD_KEY, SUPPLY / 4n)
    swap(chain, { block: B })
    const batch = await run(B)
    expect(batch.events[0]!.event).toMatchObject({
      supply: String((SUPPLY * 3n) / 4n),
      marketCap: String((SUPPLY * 3n) / 4n),
    })
  })

  it("in a backfill, the first dead balance is read at the head and stamped there", async () => {
    const { chain, pools, run } = setup(B + 120n)
    chain.balances.set(DEAD_KEY, 100n)
    burn(chain, { block: B + 110n, value: 7n })
    const first = await run(B + 100n)
    expect(first.dead).toEqual([{ token: TOKEN, balance: 100n, block: B + 120n }])
    expect(pools.marks(TOKEN)).toMatchObject({ deadBalance: 100n, deadBalanceBlock: B + 120n })
    expect(chain.getBlockNumberCalls).toBe(1)
    expect(chain.balanceReads).toEqual([B + 120n])

    const second = await run(B + 120n, B + 101n)
    expect(second.dead).toEqual([])
    expect(pools.marks(TOKEN)).toMatchObject({ deadBalance: 100n, deadBalanceBlock: B + 120n })
    expect(chain.balanceReads).toEqual([B + 120n])
  })

  it("in the live tick, the first dead balance is read at the span's end and stamped there", async () => {
    const { chain, pools, run } = setup(B + 120n)
    chain.balances.set(DEAD_KEY, 100n)
    burn(chain, { block: B + 90n, value: 7n })
    burn(chain, { block: B + 110n, value: 5n })
    const first = await run(B + 100n, B - 100n, true)
    expect(first.dead).toEqual([{ token: TOKEN, balance: 100n, block: B + 100n }])
    expect(pools.marks(TOKEN)).toMatchObject({ deadBalance: 100n, deadBalanceBlock: B + 100n })
    expect(chain.getBlockNumberCalls).toBe(0)
    expect(chain.balanceReads).toEqual([B + 100n])

    // A burn after the read block raises the balance.
    const second = await run(B + 120n, B + 101n, true)
    expect(second.dead).toEqual([{ token: TOKEN, balance: 105n, block: B + 110n }])
    expect(chain.balanceReads).toEqual([B + 100n])
  })

  it("a dead balance read the endpoint refuses fails the span as not served", async () => {
    const { chain, run } = setup()
    chain.readBalances = async () => {
      throw Object.assign(new Error("header not found"), { code: -32000 })
    }
    swap(chain, { block: B })
    await expect(run(B, B - 100n, true)).rejects.toEqual(new BlockNotServedError(B))
  })

  it("a block read the endpoint refuses fails the span as not served", async () => {
    const { chain, pools, run } = setup()
    pools.setDead(TOKEN, 0n, B - 50n)
    chain.getBlockSenders = async () => {
      throw Object.assign(new Error("header not found"), { code: -32000 })
    }
    swap(chain, { block: B })
    await expect(run(B, B - 100n, true)).rejects.toEqual(new BlockNotServedError(B))
  })

  it("a refused read stays a transport error when every endpoint is down", async () => {
    const { chain, run } = setup()
    const down = new HttpRequestError({ url: "http://rpc.test", details: "fetch failed" })
    chain.readBalances = async () => {
      throw down
    }
    swap(chain, { block: B })
    await expect(run(B, B - 100n, true)).rejects.toBe(down)
  })

  it("a transfer to the dead address lowers the next swap's market cap", async () => {
    const { chain, pools, run } = setup()
    pools.setDead(TOKEN, 0n, B - 50n)
    swap(chain, { block: B - 1n })
    burn(chain, { block: B, value: SUPPLY / 4n, logIndex: 0 })
    burn(chain, { block: B, value: SUPPLY / 4n, logIndex: 1 })
    swap(chain, { block: B, logIndex: 2 })
    const batch = await run(B)
    expect(batch.events.map((e) => e.event)).toMatchObject([
      { marketCap: String(SUPPLY) },
      { marketCap: String(SUPPLY / 2n) },
    ])
    expect(batch.dead).toEqual([{ token: TOKEN, balance: SUPPLY / 2n, block: B }])
    expect(chain.readBalancesCalls).toBe(0)
  })

  it("ath carries over from the curve", async () => {
    const { chain, pools, run } = setup()
    pools.bumpAth(TOKEN, SUPPLY * 10n, B - 5n)
    swap(chain, { block: B })
    swap(chain, { block: B + 1n, sqrtPriceX96: Q96 / 4n })
    const batch = await run(B + 1n)
    expect(batch.events.map((e) => e.event)).toMatchObject([
      { marketCap: String(SUPPLY), athMarketCap: String(SUPPLY * 10n) },
      { marketCap: String(SUPPLY * 16n), athMarketCap: String(SUPPLY * 16n) },
    ])
    expect(batch.ath).toEqual([{ token: TOKEN, marketCap: SUPPLY * 16n, block: B + 1n }])
  })

  it("ath rows are empty when no swap passes the ath", async () => {
    const { chain, pools, run } = setup()
    pools.bumpAth(TOKEN, SUPPLY * 10n, B - 5n)
    swap(chain, { block: B })
    expect((await run(B)).ath).toEqual([])
  })

  it("two swaps in one transaction get their own events and one trader", async () => {
    const { chain, run } = setup()
    const tx = nextTx()
    swap(chain, { block: B, tx, logIndex: 3 })
    swap(chain, { block: B, tx, logIndex: 5, side: "sell" })
    const batch = await run(B)
    expect(batch.events.map((e) => e.event)).toMatchObject([
      { txHash: tx, logIndex: 3, trader: BUYER, side: "buy" },
      { txHash: tx, logIndex: 5, trader: BUYER, side: "sell" },
    ])
    expect(batch.trades.map((t) => [t.logIndex, t.side, t.amountIn, t.amountOut])).toEqual([
      [3, "buy", 10n ** 15n, 10n ** 20n],
      [5, "sell", 10n ** 20n, 10n ** 15n],
    ])
    expect(chain.getBlockSendersCalls).toBe(1)
  })

  it("reads swaps of a pool registered after the filters were built", async () => {
    const { chain, pools, source } = setup(B + 20n, [])
    const filters = source.filters()
    expect(filters).toEqual([null, null])
    swap(chain, { block: B + 3n })
    pools.add({ ...entry(1), createdBlock: B + 2n }, SUPPLY)
    const batch = await source.process([[], []], { toBlock: B + 5n, live: false })
    expect(batch.events.map((e) => e.event.type)).toEqual(["launchpad.swap"])
    expect(chain.getLogsCalls).toEqual([[B + 2n, B + 5n]])
  })
})

describe("v4 source through the database", () => {
  /** The InkyPump and v4 sources sharing one registry, in the order `main.ts` runs them. */
  async function db() {
    const sql: Sql = await resetDb(inject("databaseUrl"))
    const chain = new FakeChain(B + 10n)
    const pools = new PoolRegistry()
    const ink = inkypumpSource({ sql, chain, logger: () => {}, pools })
    const v4 = v4Source({ sql, chain, logger: () => {}, pools })
    const store = createStore(sql)
    await ink.reload()
    await v4.reload()
    const logs = (fs: ReturnType<typeof ink.filters>, from: bigint, to: bigint) =>
      fs.map((f) => (f ? chain.logsIn(from, to, f) : []))
    const ingest = async (from: bigint, to: bigint) => {
      const inkFilters = ink.filters()
      const v4Filters = v4.filters()
      const a = await ink.process(logs(inkFilters, from, to), { toBlock: to, live: false })
      const b = await v4.process(logs(v4Filters, from, to), { toBlock: to, live: false })
      await store.writeBatch([a, b], [(tx) => ink.write(tx, a), (tx) => v4.write(tx, b)], {
        cursor: { block: to, hash: chain.hashOf(to) },
        head: to,
      })
      return b
    }
    const rollback = async (fork: bigint) => {
      const pi = await ink.prepareRollback(fork)
      const pv = await v4.prepareRollback(fork)
      await store.rollback(fork, chain.hashOf(fork), [
        (tx) => ink.rollback(tx, fork, pi),
        (tx) => v4.rollback(tx, fork, pv),
      ])
      await ink.reload()
      await v4.reload()
    }
    /** Launch at B, a curve trade at B+1, bond at B+2. */
    const bonded = async () => {
      launch(chain, { n: 1, block: B })
      trade(chain, { n: 1, block: B + 1n, sold: 1n, price: 1000n })
      bond(chain, { n: 1, block: B + 2n })
      await ingest(0n, B + 2n)
    }
    return { sql, chain, pools, v4, ingest, rollback, bonded }
  }

  it("writing a pool trade twice keeps one row", async () => {
    const { sql, chain, v4, ingest, bonded } = await db()
    try {
      await bonded()
      swap(chain, { block: B + 3n })
      const batch = await ingest(B + 3n, B + 3n)
      await sql.begin((tx) => v4.write(tx, batch))
      expect(
        await sql`select venue, pool_id, side, trader, block from indexer.trades where venue = 'pool'`,
      ).toEqual([{ venue: "pool", pool_id: POOL, side: "buy", trader: BUYER, block: B + 3n }])
    } finally {
      await sql.end()
    }
  })

  it("rollback below the swap that set the ath restores it", async () => {
    const { sql, chain, pools, ingest, rollback, bonded } = await db()
    try {
      await bonded()
      expect(pools.marks(TOKEN)?.ath).toBe(marketCap(1000n, SUPPLY))
      swap(chain, { block: B + 3n })
      await ingest(B + 3n, B + 3n)
      swap(chain, { block: B + 6n, sqrtPriceX96: Q96 / 2n })
      await ingest(B + 4n, B + 6n)
      const ath = () => sql`select ath_market_cap::text as ath, ath_block from indexer.tokens`
      expect(await ath()).toEqual([{ ath: String(SUPPLY * 4n), ath_block: B + 6n }])

      await rollback(B + 4n)
      expect(await ath()).toEqual([{ ath: String(SUPPLY), ath_block: B + 3n }])
      expect(pools.marks(TOKEN)).toMatchObject({ ath: SUPPLY, athBlock: B + 3n })
      expect(await sql`select block from indexer.trades where venue = 'pool'`).toEqual([
        { block: B + 3n },
      ])
    } finally {
      await sql.end()
    }
  })

  it("rollback re-reads the dead balance at the fork", async () => {
    const { sql, chain, pools, ingest, rollback, bonded } = await db()
    try {
      chain.balances.set(DEAD_KEY, 50n)
      await bonded()
      await ingest(B + 3n, B + 3n)
      const dead = () =>
        sql`select dead_balance::text as balance, dead_balance_block as block from indexer.tokens`
      expect(await dead()).toEqual([{ balance: "50", block: B + 10n }])

      chain.balances.set(DEAD_KEY, 20n)
      chain.balanceReads = []
      await rollback(B + 4n)
      expect(chain.balanceReads).toEqual([B + 4n])
      expect(await dead()).toEqual([{ balance: "20", block: B + 4n }])
      expect(pools.marks(TOKEN)).toMatchObject({ deadBalance: 20n, deadBalanceBlock: B + 4n })
    } finally {
      await sql.end()
    }
  })
})
