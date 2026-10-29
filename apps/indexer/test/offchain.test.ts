import { connect, type Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  type NftEvent,
  type NftListingEvent,
  type NftMintEvent,
  type NftSaleEvent,
  type NftStatsEvent,
  SCHEMA_VERSION,
} from "@ink-indexer/events"
import { type Address, type Hash, pad, toHex } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { EventRow } from "../src/sources/source"
import { type Cursor, createStore, type Store } from "../src/store"

const B = 46_000_000n
const CONTRACT = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b" as Address
const MAKER = "0x00000000000000000000000000000000000000aa" as Address
const BUYER = "0x00000000000000000000000000000000000000bb" as Address
const h32 = (n: bigint | number) => pad(toHex(n), { size: 32 }) as Hash
/** A block hash; `fork` gives a different hash for the same number. */
const hashOf = (n: bigint, fork = 0n) => h32(n * 10n + fork)
const cursorAt = (n: bigint, fork = 0n): Cursor => ({ block: n, hash: hashOf(n, fork) })

let sql: Sql
let store: Store

beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
})
afterEach(() => sql.end())

const base = {
  v: SCHEMA_VERSION,
  chainId: 57073,
  contract: CONTRACT,
  logIndex: 0,
  blockTimestamp: 1_760_000_000,
} as const

function listing(n: number): NftListingEvent {
  const orderHash = h32(1_000 + n)
  return {
    ...base,
    type: "nft.listing",
    source: "opensea",
    txHash: `os:list:${orderHash}`,
    blockNumber: "0",
    tokenId: String(n),
    priceWei: "500000000000000",
    currency: "ETH",
    maker: MAKER,
    expiresAt: 1_760_086_400,
    orderHash,
    itemName: `Item #${n}`,
    imageUrl: null,
    floorWei: null,
    floorAt: null,
    rank: null,
    maxRank: null,
  }
}

function stats(n: number): NftStatsEvent {
  return {
    ...base,
    type: "nft.stats",
    source: "opensea",
    txHash: `os:stats:${CONTRACT}:${n}`,
    blockNumber: "0",
    floorWei: "400000000000000",
    floor24hAgoWei: null,
    owners: 100 + n,
    volume24hWei: "0",
    sales24h: 0,
    totalSupply: "2222",
    maxSupply: null,
    listedCount: null,
    listedCapped: false,
  }
}

function mintStart(): NftMintEvent {
  return {
    ...base,
    type: "nft.mint",
    source: "chain",
    txHash: `nft:start:${CONTRACT}`,
    blockNumber: "0",
    kind: "stage_start",
    stageIndex: 0,
    stageLabel: "Mint",
    stagePriceWei: "0",
    markBps: null,
    minted: "1",
    maxSupply: "2222",
    mintStartTs: 1_760_000_000,
    stageStartTs: 1_760_000_000,
    minters: 1,
  }
}

/** A chain sale at `block`, as the NFT source would emit it. `fork` gives a different block. */
function sale(block: bigint, logIndex = 0, fork = 0n): EventRow {
  const event: NftSaleEvent = {
    ...base,
    type: "nft.sale",
    source: "chain",
    txHash: h32(block * 100n + fork * 10n + BigInt(logIndex) + 7n),
    logIndex,
    blockNumber: block.toString(),
    tokenId: "1",
    priceWei: "500000000000000",
    currency: "ETH",
    buyer: BUYER,
    seller: MAKER,
    orderHash: h32(block),
    itemName: null,
    imageUrl: null,
    rank: null,
    maxRank: null,
    floorWei: null,
  }
  return { event, block, blockHash: hashOf(block, fork), sub: `sale:${logIndex}` }
}

/** One chain span through the store, as the loop writes it. */
const chainSpan = (rows: EventRow[], cursor: Cursor, head: bigint) =>
  store.writeBatch([{ events: rows, blocks: [] }], [], { cursor, head })

const offchain = (events: NftEvent[], extra?: Parameters<Store["writeOffchain"]>[1]) =>
  store.writeOffchain(
    events.map((event) => ({ event })),
    extra,
  )

type Row = { id: bigint; tx_hash: string; block: bigint; block_hash: string; confirmed: boolean }
const rows = () =>
  sql<Row[]>`select id, tx_hash, block, block_hash, confirmed from indexer.events order by id`

/** The bot's read: `confirmed and id > cursor order by id`, from its own last id. */
function reader(db: Sql) {
  let cursor = 0n
  const read: bigint[] = []
  return {
    read,
    async poll() {
      const got = await db<{ id: bigint }[]>`
        select id from indexer.events where confirmed and id > ${cursor.toString()} order by id`
      for (const r of got) read.push(r.id)
      if (got.length > 0) cursor = got.at(-1)!.id
    },
  }
}

/** An `extra` step that records its start, then waits for `release()`. */
function gatedExtra(order: string[]) {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let entered!: () => void
  const inside = new Promise<void>((r) => {
    entered = r
  })
  const extra = async () => {
    order.push("extra-start")
    entered()
    await gate
    order.push("extra-end")
  }
  return { extra, inside, release }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("store.writeOffchain", () => {
  it("off-chain rows take the cursor block and confirm on the next confirm(head)", async () => {
    await chainSpan([sale(B + 9n)], cursorAt(B + 10n), B + 10n)
    const events = [listing(1), stats(1)]
    await offchain(events)

    const written = await sql`
      select type, entity, payload, block, block_hash, tx_hash, log_index, sub, confirmed
      from indexer.events where tx_hash like 'os:%' order by id`
    expect(written).toEqual(
      events.map((e) => ({
        type: e.type,
        entity: CONTRACT,
        payload: { ...e, blockNumber: (B + 10n).toString() },
        block: B + 10n,
        block_hash: hashOf(B + 10n),
        tx_hash: e.txHash,
        log_index: 0,
        sub: "",
        confirmed: false,
      })),
    )
    await store.confirm(B + 10n)
    expect((await rows()).map((r) => r.confirmed)).toEqual([true, false, false])
    await store.confirm(B + 11n)
    expect((await rows()).map((r) => r.confirmed)).toEqual([true, true, true])
  })

  it("keeps sub, ignores a repeated synthetic id and runs extra in the same transaction", async () => {
    await chainSpan([], cursorAt(B), B)
    await store.writeOffchain([{ event: listing(1), sub: "x" }], async (tx) => {
      await tx`insert into indexer.nft_listing_state (contract, token_id, last_price_wei, order_hash, expires_at)
        values (${CONTRACT}, '1', 500000000000000, ${h32(1_001)}, now())`
    })
    await store.writeOffchain([{ event: listing(1), sub: "x" }])
    expect(await sql`select tx_hash, sub from indexer.events`).toEqual([
      { tx_hash: listing(1).txHash, sub: "x" },
    ])
    expect(await sql`select token_id from indexer.nft_listing_state`).toEqual([{ token_id: "1" }])

    await expect(
      offchain([stats(1)], async () => {
        throw new Error("extra failed")
      }),
    ).rejects.toThrow("extra failed")
    expect(await sql`select count(*)::int as n from indexer.events`).toEqual([{ n: 1 }])
  })

  it("throws before any chain cursor exists", async () => {
    await expect(offchain([listing(1)])).rejects.toThrow(/cursor/)
    expect(await sql`select count(*)::int as n from indexer.events`).toEqual([{ n: 0 }])
  })

  it("a reader of confirmed and id > cursor never passes an unconfirmed off-chain row", async () => {
    // The bot's read, polled after every step.
    const { read, poll } = reader(sql)
    const step = async (fn: () => Promise<unknown>) => {
      await fn()
      await poll()
    }

    // B+1 confirms, B+2 does not.
    await step(() => chainSpan([sale(B + 1n), sale(B + 2n)], cursorAt(B + 2n), B + 2n))
    // Stamped B+2 and unconfirmed: confirmed-at-write would let the reader pass the B+2 sale.
    await step(() => offchain([listing(1), stats(1)]))
    // A later span confirms B+2 and the off-chain rows before adding a confirmed B+3 row.
    await step(() => chainSpan([sale(B + 3n)], cursorAt(B + 3n), B + 4n))
    // Old enough to confirm, but written unconfirmed; the next confirm takes it.
    await step(() => offchain([listing(2)]))
    await step(() => store.confirm(B + 4n))
    // An off-chain row at B+4, confirmed and read before the reorg moves it.
    await step(() => chainSpan([], cursorAt(B + 4n), B + 5n))
    await step(() => offchain([stats(3)]))
    await step(() => store.confirm(B + 5n))
    const readStats3 = (await rows()).find((r) => r.tx_hash === stats(3).txHash)!
    expect(read).toContain(readStats3.id)
    // Unconfirmed chain and off-chain rows at B+5, then a reorg back to B+3.
    await step(() => chainSpan([sale(B + 5n)], cursorAt(B + 5n), B + 5n))
    await step(() => offchain([listing(3), mintStart()]))
    const orphan = (await rows()).find((r) => r.tx_hash === sale(B + 5n).event.txHash)!
    await step(() => store.rollback(B + 3n, hashOf(B + 3n), []))
    // The new branch: B+4' to B+6' confirm the moved off-chain rows first.
    await step(() =>
      chainSpan(
        [sale(B + 4n, 0, 1n), sale(B + 5n, 0, 1n), sale(B + 6n, 0, 1n)],
        cursorAt(B + 6n, 1n),
        B + 6n,
      ),
    )
    await step(() => offchain([stats(2)]))
    await step(() => chainSpan([sale(B + 7n, 0, 1n)], cursorAt(B + 7n, 1n), B + 7n))
    await step(() => store.confirm(B + 8n))

    const final = await rows()
    expect(final.every((r) => r.confirmed)).toBe(true)
    expect(final.map((r) => r.id)).not.toContain(orphan.id)
    expect(read).not.toContain(orphan.id)
    // Every surviving row, read exactly once and in id order: the moved stats(3) is not read again.
    expect(read).toEqual(final.map((r) => r.id))
    const offchainIds = final.filter((r) => !r.tx_hash.startsWith("0x")).map((r) => r.tx_hash)
    expect(offchainIds).toEqual([
      listing(1).txHash,
      stats(1).txHash,
      listing(2).txHash,
      stats(3).txHash,
      listing(3).txHash,
      mintStart().txHash,
      stats(2).txHash,
    ])
  })

  it("rollback moves off-chain rows to the fork and deletes chain rows above it", async () => {
    await chainSpan([sale(B + 1n), sale(B + 3n)], cursorAt(B + 3n), B + 3n)
    await offchain([listing(1)]) // B+3
    await chainSpan([sale(B + 5n)], cursorAt(B + 5n), B + 6n)
    await offchain([listing(2), mintStart()]) // B+5
    await store.confirm(B + 6n)
    expect((await rows()).every((r) => r.confirmed)).toBe(true)

    const fork = B + 2n
    await store.rollback(fork, hashOf(fork), [])

    expect(
      (await rows()).map(({ tx_hash, block, block_hash, confirmed }) => ({
        tx_hash,
        block,
        block_hash,
        confirmed,
      })),
    ).toEqual([
      {
        tx_hash: sale(B + 1n).event.txHash,
        block: B + 1n,
        block_hash: hashOf(B + 1n),
        confirmed: true,
      },
      { tx_hash: listing(1).txHash, block: fork, block_hash: hashOf(fork), confirmed: false },
      { tx_hash: listing(2).txHash, block: fork, block_hash: hashOf(fork), confirmed: false },
      { tx_hash: mintStart().txHash, block: fork, block_hash: hashOf(fork), confirmed: false },
    ])
    expect(
      await sql`select tx_hash, payload->>'blockNumber' as n from indexer.events order by id`,
    ).toEqual([
      { tx_hash: sale(B + 1n).event.txHash, n: (B + 1n).toString() },
      { tx_hash: listing(1).txHash, n: fork.toString() },
      { tx_hash: listing(2).txHash, n: fork.toString() },
      { tx_hash: mintStart().txHash, n: fork.toString() },
    ])
    expect(await store.getCursor()).toEqual(cursorAt(fork))
    await store.confirm(fork + 1n)
    expect((await rows()).every((r) => r.confirmed)).toBe(true)
  })

  it("writeOffchain and writeBatch never interleave", async () => {
    await chainSpan([], cursorAt(B), B)
    const order: string[] = []
    const { extra, inside, release } = gatedExtra(order)
    const off = offchain([listing(1)], extra)
    await inside
    const batch = store.writeBatch(
      [{ events: [sale(B + 1n)], blocks: [] }],
      [async () => void order.push("write")],
      { cursor: cursorAt(B + 1n), head: B + 1n },
    )
    await sleep(30)
    expect(order).toEqual(["extra-start"])
    release()
    await Promise.all([off, batch])
    expect(order).toEqual(["extra-start", "extra-end", "write"])
    expect((await rows()).map((r) => [r.tx_hash, r.block])).toEqual([
      [listing(1).txHash, B],
      [sale(B + 1n).event.txHash, B + 1n],
    ])
  })

  it("serialises writeOffchain and writeBatch from separate processes", async () => {
    // A second connection pool and store stand in for a CLI process beside the running indexer.
    const other = connect(inject("databaseUrl"))
    const order: string[] = []
    const { extra, inside, release } = gatedExtra(order)
    try {
      const cli = createStore(other)
      await chainSpan([], cursorAt(B), B)
      const { read, poll } = reader(sql)
      const off = cli.writeOffchain([{ event: listing(1) }], extra)
      await inside
      // Confirmed at insert: committing it first would let the reader pass the off-chain row.
      const batch = store.writeBatch(
        [{ events: [sale(B + 1n)], blocks: [] }],
        [async () => void order.push("write")],
        { cursor: cursorAt(B + 1n), head: B + 2n },
      )
      await sleep(50)
      await poll()
      expect(order).toEqual(["extra-start"])
      expect(read).toEqual([])
      release()
      await Promise.all([off, batch])
      await store.confirm(B + 2n)
      await poll()
      expect(order).toEqual(["extra-start", "extra-end", "write"])
      const final = await rows()
      expect(final.map((r) => [r.tx_hash, r.confirmed])).toEqual([
        [listing(1).txHash, true],
        [sale(B + 1n).event.txHash, true],
      ])
      expect(read).toEqual(final.map((r) => r.id))
    } finally {
      release()
      await other.end()
    }
  })
})
