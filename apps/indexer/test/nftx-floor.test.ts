import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { combineFloor, floorParts, onNftx } from "../src/sources/nftx/floor"
import { createStats, latestFloors } from "../src/sources/opensea/stats"
import { createStore } from "../src/store"

const MIN = 60_000
const T0 = Date.parse("2026-11-19T00:00:00Z")
const A = "0x00000000000000000000000000000000000000a1"
const B = "0x00000000000000000000000000000000000000b2"

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

describe("combineFloor", () => {
  const at = new Date(T0)
  it("the lower market wins", () => {
    expect(combineFloor({ osFloorWei: 5n, osAt: at, nftxFloorWei: 3n })).toEqual({
      floorWei: 3n,
      market: "nftx",
    })
    expect(combineFloor({ osFloorWei: 3n, osAt: at, nftxFloorWei: 5n })).toEqual({
      floorWei: 3n,
      market: "opensea",
    })
  })

  it("a tie goes to OpenSea", () => {
    expect(combineFloor({ osFloorWei: 4n, osAt: at, nftxFloorWei: 4n })).toEqual({
      floorWei: 4n,
      market: "opensea",
    })
  })

  it("either missing gives the other", () => {
    expect(combineFloor({ osFloorWei: null, osAt: at, nftxFloorWei: 4n })).toEqual({
      floorWei: 4n,
      market: "nftx",
    })
    expect(combineFloor({ osFloorWei: 4n, osAt: at, nftxFloorWei: null })).toEqual({
      floorWei: 4n,
      market: "opensea",
    })
  })

  it("both missing gives null", () => {
    expect(combineFloor({ osFloorWei: null, osAt: null, nftxFloorWei: null })).toEqual({
      floorWei: null,
      market: null,
    })
  })
})

let n = 0
/** A collection with an NFTX market, open unless told otherwise, and its pool prices (newest last). */
async function addNftx(
  collection: string,
  prices: (bigint | null)[],
  opts: { initialized?: boolean; sunset?: boolean; combinedSince?: Date } = {},
) {
  n++
  await sql`insert into indexer.nftx_collections ${sql({
    collection,
    floor_token: `0x${n.toString(16).padStart(40, "f")}`,
    creator: A,
    created_block: "100",
    initialized_block: opts.initialized === false ? null : "110",
    fleth_is_currency0: true,
    sunset_block: opts.sunset ? "500" : null,
    combined_since: opts.combinedSince ?? null,
  })}`
  for (const [i, price] of prices.entries())
    await sql`insert into indexer.nftx_prices ${sql({
      collection,
      block: String(200 + i),
      log_index: 0,
      sqrt_price_x96: "1",
      price_wei: price === null ? null : price.toString(),
      at: new Date(T0 + i * MIN),
    })}`
}
/** An OpenSea stats row, as the job writes it. `raw` set means the row is from after the NFTX columns. */
async function addOs(
  contract: string,
  floor: bigint | null,
  at: number,
  raw?: { os: bigint | null; market: "opensea" | "nftx" },
) {
  await sql`insert into indexer.nft_stats ${sql({
    contract,
    at: new Date(at),
    floor_wei: floor === null ? null : floor.toString(),
    floor_market: raw?.market ?? null,
    os_floor_wei: raw?.os === null || raw === undefined ? null : raw.os.toString(),
  })}`
}

describe("floors on a collection with an NFTX market", () => {
  it("latestFloors returns the NFTX price when it is lower than the newest OpenSea floor", async () => {
    await addOs(A, 500n, T0 - 5 * MIN)
    await addNftx(A, [900n, 300n])
    expect((await latestFloors(sql, [A], true)).get(A)).toBe(300n)
  })

  it("latestFloors keeps the OpenSea floor when it is the lower one", async () => {
    await addOs(A, 200n, T0 - 5 * MIN)
    await addNftx(A, [300n])
    expect((await latestFloors(sql, [A], true)).get(A)).toBe(200n)
  })

  it("a sunset collection's NFTX price is not used", async () => {
    await addOs(A, 500n, T0)
    await addNftx(A, [300n], { sunset: true })
    expect((await latestFloors(sql, [A], true)).get(A)).toBe(500n)
    expect([...(await onNftx(sql, [A]))]).toEqual([])
  })

  it("a collection whose pool has not opened has no NFTX price", async () => {
    await addOs(A, 500n, T0)
    await addNftx(A, [300n], { initialized: false })
    expect((await latestFloors(sql, [A], true)).get(A)).toBe(500n)
  })

  it("a pool price that is not defined is skipped: the last defined price stands", async () => {
    await addOs(A, 500n, T0)
    await addNftx(A, [300n, null])
    expect((await latestFloors(sql, [A], true)).get(A)).toBe(300n)
  })

  it("a pool with no defined price gives no NFTX floor", async () => {
    await addOs(A, 500n, T0)
    await addNftx(A, [null, null])
    expect((await latestFloors(sql, [A], true)).get(A)).toBe(500n)
    await addNftx(B, [null])
    expect((await latestFloors(sql, [B], true)).has(B)).toBe(false)
  })

  it("a collection with only an NFTX price and no OpenSea row has that price", async () => {
    await addNftx(A, [300n])
    expect((await latestFloors(sql, [A], true)).get(A)).toBe(300n)
    expect((await latestFloors(sql, [B], true)).has(B)).toBe(false)
  })

  it("the OpenSea floor of a row is its os_floor_wei, or floor_wei on a row from before NFTX", async () => {
    await addNftx(A, [900n])
    await addOs(A, 100n, T0 - 2 * MIN)
    expect((await floorParts(sql, [A], true)).get(A)).toMatchObject({ osFloorWei: 100n })
    // A newer combined row: floor_wei holds the lower of the two, os_floor_wei the OpenSea floor.
    await addOs(A, 50n, T0 - MIN, { os: 400n, market: "nftx" })
    expect((await floorParts(sql, [A], true)).get(A)).toMatchObject({
      osFloorWei: 400n,
      osAt: new Date(T0 - MIN),
      nftxFloorWei: 900n,
    })
    // OpenSea had no floor at that poll.
    await addOs(A, null, T0, { os: null, market: "opensea" })
    expect((await floorParts(sql, [A], true)).get(A)).toMatchObject({ osFloorWei: null })
  })

  it("rows written from pool moves do not stand for the OpenSea row", async () => {
    await addOs(A, 400n, T0 - 10 * MIN)
    await addNftx(A, [900n])
    await sql`insert into indexer.nft_stats ${sql({
      contract: A,
      at: new Date(T0),
      floor_wei: "100",
      floor_market: "nftx",
      os_floor_wei: "400",
      block: "300",
    })}`
    expect((await floorParts(sql, [A], true)).get(A)).toMatchObject({
      osFloorWei: 400n,
      osAt: new Date(T0 - 10 * MIN),
    })
  })
})

describe("with the NFTX source off", () => {
  const stats = () =>
    createStats({
      sql,
      store: createStore(sql),
      rest: undefined as never,
      log: () => {},
      now: () => T0,
    })

  it("floors ignore the pool's price, as they did before NFTX", async () => {
    await addOs(A, 500n, T0 - 5 * MIN)
    await addNftx(A, [300n])
    expect((await latestFloors(sql, [A], false)).get(A)).toBe(500n)
    expect((await floorParts(sql, [A], false)).get(A)).toMatchObject({
      osFloorWei: 500n,
      nftxFloorWei: null,
    })
  })

  it("a collection with only a pool price has no floor", async () => {
    await addNftx(B, [300n])
    expect((await latestFloors(sql, [B], false)).has(B)).toBe(false)
    expect((await floorParts(sql, [B], false)).has(B)).toBe(false)
  })

  it("the floor a listing reads is the OpenSea row's alone", async () => {
    await addOs(A, 500n, T0 - 30 * MIN)
    await addNftx(A, [300n])
    expect(await stats().latestFloor(A, new Date(T0))).toEqual({
      floorWei: 500n,
      at: new Date(T0 - 30 * MIN),
      market: "opensea",
      osAt: new Date(T0 - 30 * MIN),
    })
    await addNftx(B, [300n])
    expect(await stats().latestFloor(B, new Date(T0))).toBeNull()
  })
})

describe("the floor the listings read", () => {
  const stats = () =>
    createStats({
      sql,
      store: createStore(sql),
      rest: undefined as never,
      log: () => {},
      now: () => T0,
      combineNftx: () => true,
    })

  it("an NFTX floor takes the time of the event, an OpenSea floor its own row's time", async () => {
    await addOs(A, 500n, T0 - 30 * MIN)
    await addNftx(A, [300n])
    const event = new Date(T0)
    expect(await stats().latestFloor(A, event)).toEqual({
      floorWei: 300n,
      at: event,
      market: "nftx",
      osAt: new Date(T0 - 30 * MIN),
    })
    await addOs(B, 500n, T0 - 30 * MIN)
    expect(await stats().latestFloor(B, event)).toEqual({
      floorWei: 500n,
      at: new Date(T0 - 30 * MIN),
      market: "opensea",
      osAt: new Date(T0 - 30 * MIN),
    })
  })

  it("a collection with neither has no floor", async () => {
    expect(await stats().latestFloor(A, new Date(T0))).toBeNull()
  })
})
