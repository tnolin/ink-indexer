import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ethToWei,
  parseAccount,
  parseCollection,
  parseContract,
  parseDrop,
  parseNft,
  parseStats,
  parseStreamFrame,
} from "../src/index"

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const BURST = "0x165dcae7953657e23035c96503b2a5b51ddfa4cd"

/** The body of a recorded OpenSea response (the fixtures are `{ status, body }`). */
function body(name: string): unknown {
  const file = join(
    import.meta.dirname,
    "../../../apps/indexer/test/fixtures/opensea",
    `${name}.json`,
  )
  return (JSON.parse(readFileSync(file, "utf8")) as { body: unknown }).body
}

describe("ethToWei", () => {
  it("converts decimal ETH exactly, without float multiplication", () => {
    expect(ethToWei(0.562)).toBe(562000000000000000n)
    expect(ethToWei("0.562")).toBe(562000000000000000n)
    expect(ethToWei(0.42)).toBe(420000000000000000n)
    expect(ethToWei(1)).toBe(10n ** 18n)
    expect(ethToWei(0)).toBe(0n)
    expect(ethToWei(8.888e-5)).toBe(88880000000000n)
    expect(ethToWei(0.1 + 0.2)).toBe(300000000000000040n) // prints as 0.30000000000000004
  })

  it("handles exponent notation and long fractions", () => {
    expect(ethToWei(1e-7)).toBe(100000000000n)
    expect(ethToWei(1e-18)).toBe(1n)
    expect(ethToWei(1e-19)).toBe(0n)
    expect(ethToWei(1.5e21)).toBe(15n * 10n ** 38n)
    expect(ethToWei("1.0000000000000000019")).toBe(10n ** 18n + 1n)
    expect(ethToWei(123456.789)).toBe(123456789000000000000000n)
  })

  it("returns null for anything that is not a non-negative decimal", () => {
    for (const bad of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "",
      "abc",
      "1e999",
      null,
      undefined,
      {},
      true,
    ])
      expect(ethToWei(bad)).toBeNull()
  })
})

describe("parseContract", () => {
  it("reads the collection slug and token standard", () => {
    expect(parseContract(body(`contract/${HORNET}`))).toEqual({
      slug: "ink-hornet",
      standard: "erc721",
    })
    expect(parseContract(body(`contract/${BURST}`))).toEqual({
      slug: "inkverse-ii",
      standard: "erc721",
    })
  })

  it("returns a null slug when there is none, and null for unusable input", () => {
    expect(parseContract({ contract_standard: "erc1155" })).toEqual({
      slug: null,
      standard: "erc1155",
    })
    expect(parseContract({ collection: "", contract_standard: "erc721" })?.slug).toBeNull()
    for (const bad of [null, undefined, 3, "x", []]) expect(parseContract(bad)).toBeNull()
  })
})

describe("parseCollection", () => {
  it("reads the Hornet collection with its socials and rank range", () => {
    expect(parseCollection(body("collections/ink-hornet"))).toEqual({
      slug: "ink-hornet",
      name: "Ink Hornet",
      imageUrl: expect.stringMatching(/^https:\/\/i2c\.seadn\.io\/collection\/ink-hornet\//),
      twitter: "inkthehornet",
      website: "https://www.inkhornet.com/",
      discord: null,
      safelist: "not_requested",
      createdDate: "2026-09-01",
      totalSupply: 2222,
      rarityCalculatedAt: "2026-10-18T12:08:38.783124",
      maxRank: 2222,
      openseaUrl: "https://opensea.io/collection/ink-hornet",
      owner: "0x7a24f0206ed3493fa89ffb8a6e937e1f6378cbb2",
    })
  })

  it("lowercases the owner and leaves it null when absent", () => {
    expect(parseCollection({ collection: "x", owner: "0xABCDEF" })?.owner).toBe("0xabcdef")
    expect(parseCollection({ collection: "x", owner: "" })?.owner).toBeNull()
    expect(parseCollection({ collection: "x" })?.owner).toBeNull()
  })

  it("leaves rank fields null for a collection without rarity, and empty socials null", () => {
    const c = parseCollection(body("collections/inkverse-ii"))
    expect(c).toMatchObject({
      slug: "inkverse-ii",
      twitter: null,
      website: null,
      maxRank: null,
      rarityCalculatedAt: null,
      totalSupply: 30917,
    })
    expect(parseCollection(body("collections/wiredonink"))).toMatchObject({
      safelist: "verified",
      twitter: "WiredonInk",
      maxRank: 866,
    })
  })

  it("parses every recorded collection and every entry of a page of new ones", () => {
    for (const s of ["ink-hornet", "inkverse-920024436", "inkverse-ii", "prtscn-ink", "wiredonink"])
      expect(parseCollection(body(`collections/${s}`))?.slug).toBe(s)
    const page = body("collections-new") as { collections: unknown[] }
    expect(page.collections.length).toBeGreaterThan(0)
    for (const c of page.collections) expect(parseCollection(c)?.slug).toEqual(expect.any(String))
  })

  it("returns null without a slug and never throws", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { collection: 5 }, { name: "x" }])
      expect(parseCollection(bad)).toBeNull()
    expect(
      parseCollection({ collection: "x", total_supply: "many", rarity: "none" }),
    ).toMatchObject({
      slug: "x",
      totalSupply: null,
      maxRank: null,
    })
  })
})

describe("parseStats", () => {
  it("converts a float ETH floor to wei exactly", () => {
    expect(
      parseStats({ total: { floor_price: 0.562, num_owners: 10, sales: 3 }, intervals: [] })
        ?.floorWei,
    ).toBe(562000000000000000n)
  })

  it("reads WIRED: floor, owners and the last day", () => {
    expect(parseStats(body("collections/wiredonink/stats"))).toEqual({
      floorWei: 420000000000000000n,
      owners: 209,
      volume24hWei: 3231000000000000300n,
      sales24h: 6,
      totalSupply: null,
    })
  })

  it("reads a tiny floor written in exponent form", () => {
    expect(parseStats(body("collections/inkverse-ii/stats"))).toMatchObject({
      floorWei: 88880000000000n,
      owners: 891,
      volume24hWei: 0n,
      sales24h: 0,
    })
  })

  it("returns nulls for missing fields and null for unusable input", () => {
    expect(
      parseStats({ total: {}, intervals: [{ interval: "seven_day", volume: 1, sales: 2 }] }),
    ).toEqual({
      floorWei: null,
      owners: null,
      volume24hWei: null,
      sales24h: null,
      totalSupply: null,
    })
    expect(parseStats({})).toEqual({
      floorWei: null,
      owners: null,
      volume24hWei: null,
      sales24h: null,
      totalSupply: null,
    })
    for (const bad of [null, undefined, 1, "x", []]) expect(parseStats(bad)).toBeNull()
  })
})

describe("parseDrop", () => {
  it("reads the Hornet drop: 4 stages in order of start, GTD at 588 wallets", () => {
    const drop = parseDrop(body("drops/ink-hornet"))!
    expect(drop).toMatchObject({
      slug: "ink-hornet",
      contract: HORNET,
      isMinting: false,
      maxSupply: 2222n,
      totalSupply: 2222n,
      feeBps: 1000,
    })
    expect(drop.stages.map((s) => s.label)).toEqual(["Team", "GTD", "FCFS", "Public stage"])
    const gtd = drop.stages[1]!
    expect(gtd).toEqual({
      type: "signed_presale",
      label: "GTD",
      priceWei: 0n,
      startTime: Date.parse("2026-09-06T10:00:00Z") / 1000,
      endTime: Date.parse("2026-09-06T13:00:00Z") / 1000,
      maxPerWallet: 1,
      allowlistCount: 588,
    })
    expect(drop.stages[2]).toMatchObject({
      priceWei: 250000000000000n,
      allowlistCount: 2152,
      maxPerWallet: 4,
    })
    expect(drop.stages[3]).toMatchObject({
      type: "public_sale",
      priceWei: 500000000000000n,
      allowlistCount: null,
      maxPerWallet: 10,
    })
  })

  it("reads a live drop", () => {
    expect(parseDrop(body("drops/inkverse-ii"))).toMatchObject({
      isMinting: true,
      maxSupply: 33333n,
      totalSupply: 30917n,
      stages: [{ label: "Public stage", priceWei: 700000000000000n }],
    })
  })

  it("returns null for a 404 body, a bad stage, or unusable input", () => {
    expect(parseDrop(body("drops/prtscn-ink"))).toBeNull()
    const ok = body("drops/inkverse-ii") as { stages: Record<string, unknown>[] }
    expect(parseDrop({ ...ok, stages: [{ ...ok.stages[0], price: "free" }] })).toBeNull()
    expect(parseDrop({ ...ok, stages: [{ ...ok.stages[0], start_time: "soon" }] })).toBeNull()
    // A time that names no zone would depend on the host's timezone.
    expect(
      parseDrop({ ...ok, stages: [{ ...ok.stages[0], start_time: "2026-10-14T18:54:47" }] }),
    ).toBeNull()
    expect(
      parseDrop({ ...ok, stages: [{ ...ok.stages[0], start_time: "2026-10-14T18:54:47+02:00" }] })
        ?.stages[0]?.startTime,
    ).toBe(Date.parse("2026-10-14T16:54:47Z") / 1000)
    for (const bad of [null, undefined, 1, "x", [], {}]) expect(parseDrop(bad)).toBeNull()
  })

  it("keeps a stage with no end and no cap", () => {
    const ok = body("drops/inkverse-ii") as { stages: Record<string, unknown>[] }
    const d = parseDrop({
      ...ok,
      stages: [{ ...ok.stages[0], end_time: null, max_per_wallet: null }],
      max_supply: null,
    })!
    expect(d.stages[0]).toMatchObject({ endTime: null, maxPerWallet: null })
    expect(d.maxSupply).toBeNull()
  })
})

describe("parseNft", () => {
  it("reads a ranked Hornet token with its traits", () => {
    const nft = parseNft(body(`nfts/${HORNET}/1`))!
    expect(nft).toMatchObject({ rank: 1734, name: "Hornet #1" })
    expect(nft.imageUrl).toMatch(/^https:\/\/i2c\.seadn\.io\//)
    expect(nft.traits).toHaveLength(8)
    expect(nft.traits.slice(0, 2)).toEqual([
      { type: "Type", value: "Accessory" },
      { type: "Force", value: "Iron" },
    ])
  })

  it("reads the burst token: rank null, no traits, no image", () => {
    expect(parseNft(body(`nfts/${BURST}/1`))).toEqual({
      rank: null,
      traits: [],
      name: "#1",
      imageUrl: null,
    })
  })

  it("reads a token from a page listing, which has no rarity", () => {
    const page = body("collection-nfts/ink-hornet") as { nfts: unknown[] }
    expect(parseNft(page.nfts[0])).toMatchObject({ rank: null, name: "Hornet #2222" })
  })

  it("keeps numeric trait values as text and skips malformed traits", () => {
    expect(
      parseNft({
        nft: {
          traits: [
            { trait_type: "Level", value: 5 },
            { trait_type: "x" },
            null,
            { value: "y" },
            { trait_type: "Hat", value: "Red" },
          ],
        },
      }),
    ).toEqual({
      rank: null,
      traits: [
        { type: "Level", value: "5" },
        { type: "Hat", value: "Red" },
      ],
      name: null,
      imageUrl: null,
    })
  })

  it("returns null for unusable input", () => {
    for (const bad of [null, undefined, 1, "x", []]) expect(parseNft(bad)).toBeNull()
    expect(parseNft({ nft: { rarity: { rank: "high" }, traits: "none" } })).toMatchObject({
      rank: null,
      traits: [],
    })
  })
})

describe("parseAccount", () => {
  it("reads the username and verified flag of the Hornet owner", () => {
    expect(
      parseAccount(body("accounts/0x7a24f0206ed3493fa89ffb8a6e937e1f6378cbb2-handmade")),
    ).toEqual({
      username: "INKHornetDEV",
      verified: false,
    })
  })

  it("an account with no username has none, and verified needs a literal true", () => {
    expect(parseAccount({ address: "0x1", username: "", is_verified: true })).toEqual({
      username: null,
      verified: true,
    })
    expect(parseAccount({ address: "0x1", username: null })).toEqual({
      username: null,
      verified: false,
    })
    expect(parseAccount({ username: "a", is_verified: "true" })).toEqual({
      username: "a",
      verified: false,
    })
  })

  it("returns null for anything that is not an object and never throws", () => {
    for (const bad of [null, undefined, 3, "x", []]) expect(parseAccount(bad)).toBeNull()
  })
})

describe("parseStreamFrame", () => {
  /** A recorded Stream fixture (frames as received). */
  const stream = (name: string) =>
    JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../apps/indexer/test/fixtures/opensea/stream",
          `${name}.json`,
        ),
        "utf8",
      ),
    )

  it("reads the topic, event, ref and body of a recorded heartbeat reply", () => {
    const { reply } = stream("heartbeat")
    expect(parseStreamFrame(JSON.stringify(reply))).toEqual({
      topic: "phoenix",
      event: "phx_reply",
      ref: "100",
      body: { status: "ok", response: {} },
    })
  })

  it("reads a pushed event, whose ref is null", () => {
    const { frames } = stream("collections") as { frames: { frame: unknown[] }[] }
    const listed = frames.find((f) => f.frame[3] === "item_listed")!.frame
    const out = parseStreamFrame(JSON.stringify(listed))!
    expect(out.topic).toBe("collection:prtscn-ink")
    expect(out.event).toBe("item_listed")
    expect(out.ref).toBeNull()
    expect((out.body as { event_type: string }).event_type).toBe("item_listed")
  })

  it("returns null for anything that is not a five-element frame and never throws", () => {
    for (const bad of [
      "",
      "not json",
      "{}",
      "null",
      "[]",
      '[null, "1", "phoenix", "phx_reply"]',
      '[null, "1", 5, "phx_reply", {}]',
      '[null, "1", "phoenix", null, {}]',
      '[null, 7, "phoenix", "phx_reply", {}]',
    ])
      expect(parseStreamFrame(bad)).toBeNull()
  })
})
