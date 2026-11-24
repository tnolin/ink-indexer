import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import type { NftCollectionEvent } from "@ink-indexer/events"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import { createLaunchImages, launchAvatar } from "../src/sources/nftx/launch-images"
import { pageColumns } from "../src/sources/opensea/discovery"
import { createSnapshots } from "../src/sources/opensea/snapshot"
import { createStore, type Store } from "../src/store"

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "nftx-launches", name), "utf8"))
const THINKERS = "0xf0eb4d1ee2278b0874fb68af83e6443c04af7300"
const AVATAR =
  "https://api.nftx.io/v1/media/ipfs/bafybeigqjmaso7abaapz3b757w47px5r2k3lm55ynhblxkec5dguhcrpui"
const T0 = Date.parse("2026-11-24T18:00:00Z")
const MIN = 60_000

describe("launchAvatar", () => {
  it("reads the avatar of the launch recorded for the collection", () => {
    expect(launchAvatar(fixture("thinkers.json"), THINKERS)).toBe(AVATAR)
  })
  it("has none when the list is empty", () => {
    expect(launchAvatar(fixture("none.json"), THINKERS)).toBeNull()
  })
  it("has none when the error body names a missing launch", () => {
    expect(launchAvatar(fixture("launch-not-found.json"), THINKERS)).toBeNull()
  })
  it("ignores a record for another collection", () => {
    expect(launchAvatar(fixture("thinkers.json"), `0x${"11".repeat(20)}`)).toBeNull()
  })
  it("ignores an avatar that is not an NFTX media link", () => {
    const body = fixture("thinkers.json")
    body.data[0].profile.avatarUrl = "https://example.com/a.png"
    expect(launchAvatar(body, THINKERS)).toBeNull()
    body.data[0].profile = null
    expect(launchAvatar(body, THINKERS)).toBeNull()
  })
})

describe("pageColumns", () => {
  it("leaves the stored image alone when OpenSea has none", () => {
    expect("image_url" in pageColumns({ slug: "s", name: "n", imageUrl: null } as never)).toBe(
      false,
    )
  })
})

let sql: Sql
let store: Store
let clock: number
let logs: [string, string][]
let reports: unknown[]
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
  store = createStore(sql)
  clock = T0
  logs = []
  reports = []
  await store.writeBatch([], [], {
    cursor: { block: 100n, hash: `0x${"11".repeat(32)}` },
    head: 100n,
  })
})
afterEach(() => sql.end())

const log: Logger = (level, msg) => void logs.push([level, msg])

type Reply = Response | Error
function setup(replies: Reply[] | ((url: string) => Reply | Promise<Reply>)) {
  const urls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const queue = Array.isArray(replies) ? [...replies] : null
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    inits.push(init)
    const r = queue
      ? queue.length > 1
        ? queue.shift()!
        : queue[0]!
      : await (replies as (u: string) => Reply | Promise<Reply>)(url)
    if (r instanceof Error) throw r
    return r.clone()
  }) as typeof fetch
  const images = createLaunchImages({
    sql,
    snapshots: createSnapshots({ sql, store, now: () => clock }),
    fetch: fetchFn,
    log,
    report: (e) => void reports.push(e),
    now: () => clock,
    retryDelayMs: 0,
  })
  return { images, urls, inits }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function addLaunch(contract = THINKERS, extra: Record<string, unknown> = {}, ended = false) {
  await sql`insert into indexer.nft_collections ${sql({ contract, standard: "erc721", launchpad: "nftx", ...extra })}`
  await sql`insert into indexer.nftx_auctions ${sql({
    auction: `0x${contract.slice(2, 22)}${"00".repeat(10)}`,
    token: `0x${"aa".repeat(20)}`,
    currency: `0x${"bb".repeat(20)}`,
    start_block: 1,
    end_block: 2,
    claim_block: 3,
    floor_price_q96: 1,
    required_raise: 1,
    amount: 1,
    sender: `0x${"cc".repeat(20)}`,
    created_block: 1,
    created_log_index: 0,
    collection: contract,
    kept: true,
    ended_block: ended ? 2 : null,
  })}`
}
const imageOf = async (c = THINKERS) =>
  (
    await sql<
      { image_url: string | null }[]
    >`select image_url from indexer.nft_collections where contract = ${c}`
  )[0]!.image_url
const collectionEvents = async () =>
  (
    await sql<
      { payload: NftCollectionEvent }[]
    >`select payload from indexer.events where type = 'nft.collection' order by id`
  ).map((r) => r.payload)

describe("launch images", () => {
  it("sets the image and emits an nft.collection event carrying it", async () => {
    await addLaunch()
    await sql`update indexer.nft_collections set verdict_dirty = false where contract = ${THINKERS}`
    const { images, urls, inits } = setup([json(fixture("thinkers.json"))])
    await images.tick()
    expect(await imageOf()).toBe(AVATAR)
    const events = await collectionEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ contract: THINKERS, imageUrl: AVATAR, verdict: "pending" })
    expect(urls).toEqual([`https://api.nftx.io/v1/57073/launches?collection=${THINKERS}`])
    expect(Object.keys(Object.fromEntries(new Headers(inits[0]?.headers))).sort()).toEqual([
      "accept",
      "user-agent",
    ])
    // The verdict is not marked for another look.
    const [row] =
      await sql`select verdict_dirty from indexer.nft_collections where contract = ${THINKERS}`
    expect(row!.verdict_dirty).toBe(false)
  })

  it("leaves a collection that has an image, and one whose auction has ended", async () => {
    await addLaunch(THINKERS, { image_url: "https://opensea.example/a.png" })
    await addLaunch(`0x${"22".repeat(20)}`, {}, true)
    const { images, urls } = setup([json(fixture("thinkers.json"))])
    await images.tick()
    expect(urls).toEqual([])
    expect(await imageOf()).toBe("https://opensea.example/a.png")
  })

  it("leaves collections of other launchpads alone", async () => {
    await addLaunch(THINKERS, { launchpad: null })
    const { images, urls } = setup([json(fixture("thinkers.json"))])
    await images.tick()
    expect(urls).toEqual([])
  })

  it("retries a missing record on a slow schedule and keeps going until it appears", async () => {
    await addLaunch()
    const { images, urls } = setup([
      json(fixture("none.json")),
      json(fixture("launch-not-found.json"), 404),
      json(fixture("thinkers.json")),
    ])
    await images.tick()
    expect(urls).toHaveLength(1)
    clock += MIN
    await images.tick()
    expect(urls).toHaveLength(1)
    expect(await imageOf()).toBeNull()
    clock += 10 * MIN
    await images.tick()
    expect(urls).toHaveLength(2)
    expect(await imageOf()).toBeNull()
    clock += 2 * 60 * MIN
    await images.tick()
    expect(await imageOf()).toBe(AVATAR)
  })

  it("retries a failed request a few times, then waits and never throws", async () => {
    await addLaunch()
    const { images, urls } = setup([new Error("down")])
    await images.tick()
    expect(urls).toHaveLength(3)
    expect(await imageOf()).toBeNull()
    await images.tick()
    expect(urls).toHaveLength(3)
  })

  it("a server error counts as a failed request", async () => {
    await addLaunch()
    const { images, urls } = setup([new Response("oops", { status: 502 })])
    await images.tick()
    expect(urls).toHaveLength(3)
  })

  it("does not overwrite an image that arrived from OpenSea meanwhile", async () => {
    await addLaunch()
    const { images } = setup(async () => {
      await sql`update indexer.nft_collections set image_url = 'https://opensea.example/b.png' where contract = ${THINKERS}`
      return json(fixture("thinkers.json"))
    })
    await images.tick()
    expect(await imageOf()).toBe("https://opensea.example/b.png")
  })

  it("treats an empty image as none", async () => {
    await addLaunch(THINKERS, { image_url: "" })
    const { images } = setup([json(fixture("thinkers.json"))])
    await images.tick()
    expect(await imageOf()).toBe(AVATAR)
  })
})
