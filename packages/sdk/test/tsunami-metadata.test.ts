import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { gatewayCid, parseTsunamiMetadata } from "../src/index"

const GATEWAY = "https://gw.example"
const recorded = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"))
const shitcoin = recorded("tsunami-metadata-shitcoin.json")
const gm = recorded("tsunami-metadata-gm.json")
const EMPTY_LINKS = { telegram: null, twitter: null, website: null }

describe("parseTsunamiMetadata", () => {
  it("parses the SHITCOIN metadata", () => {
    expect(parseTsunamiMetadata(shitcoin, GATEWAY)).toEqual({
      description: "Shitcoin on Ink Chain.",
      imageUrl:
        "https://images.inkjet.trade/marks/07a607d6e847662700d7ec2259ec180df663a6af2b43cce84fea22ccd8074bc2-1024.webp",
      links: { telegram: null, twitter: "https://x.com/shitcoinonink", website: null },
    })
  })

  it("parses the GM metadata", () => {
    expect(parseTsunamiMetadata(gm, GATEWAY)).toEqual({
      description: null,
      imageUrl:
        "https://images.inkjet.trade/marks/8928869bf3444cbdce574294876e7c2761103de3804c6d5c5843ecdf95cc9d9d-1024.webp",
      links: EMPTY_LINKS,
    })
  })

  it("reads the telegram and website socials", () => {
    const m = parseTsunamiMetadata(
      {
        socials: { telegram: "https://t.me/a", website: "https://a.example", x: "https://x.com/a" },
      },
      GATEWAY,
    )
    expect(m?.links).toEqual({
      telegram: "https://t.me/a",
      website: "https://a.example",
      twitter: "https://x.com/a",
    })
  })

  it.each([
    ["http", "http://images.example/a.png"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:image/png;base64,AAAA"],
    ["a relative path", "/marks/a.png"],
    ["credentials", "https://user:pw@images.example/a.png"],
    ["a non-string", 7],
    ["over 2,048 characters", `https://images.example/${"a".repeat(2_048)}.png`],
  ])("drops an image that is %s", (_name, image) => {
    expect(parseTsunamiMetadata({ image }, GATEWAY)?.imageUrl).toBeNull()
  })

  it("keeps an https image of exactly 2,048 characters", () => {
    const image = `https://images.example/${"a".repeat(2_048 - "https://images.example/".length)}`
    expect(image).toHaveLength(2_048)
    expect(parseTsunamiMetadata({ image }, GATEWAY)?.imageUrl).toBe(image)
  })

  it("maps an ipfs:// image through the gateway", () => {
    expect(parseTsunamiMetadata({ image: "ipfs://bafyimg/a.png" }, GATEWAY)?.imageUrl).toBe(
      `${GATEWAY}/ipfs/bafyimg/a.png`,
    )
    expect(parseTsunamiMetadata({ image: "ipfs://../x" }, GATEWAY)?.imageUrl).toBeNull()
  })

  it("an empty image is null", () => {
    expect(parseTsunamiMetadata({ image: "" }, GATEWAY)?.imageUrl).toBeNull()
  })

  it("removes NUL and lone surrogates from the description", () => {
    const m = parseTsunamiMetadata({ description: "a\u0000b\ud800c" }, GATEWAY)
    expect(m?.description).toBe("ab�c")
  })

  it("cuts a description at 4,000 characters and drops a link over 2,048", () => {
    const m = parseTsunamiMetadata(
      { description: "x".repeat(5_000), socials: { x: `https://x.com/${"a".repeat(2_048)}` } },
      GATEWAY,
    )
    expect(m?.description).toHaveLength(4_000)
    expect(m?.links.twitter).toBeNull()
  })

  it("is null for JSON that is not an object", () => {
    for (const v of [null, 5, "s", [], [{ image: "x" }]]) {
      expect(parseTsunamiMetadata(v, GATEWAY)).toBeNull()
    }
  })

  it("ignores fields of the wrong type and deeply nested values", () => {
    let deep: unknown = "x"
    for (let i = 0; i < 5_000; i++) deep = { a: deep }
    expect(
      parseTsunamiMetadata(
        { description: 5, socials: { x: deep, telegram: [], website: {} }, riptide: deep },
        GATEWAY,
      ),
    ).toEqual({ description: null, imageUrl: null, links: EMPTY_LINKS })
    expect(parseTsunamiMetadata({ socials: "x" }, GATEWAY)?.links).toEqual(EMPTY_LINKS)
  })
})

describe("gatewayCid", () => {
  it("takes the CID of a gateway URI and discards its host", () => {
    expect(
      gatewayCid(
        "https://ipfs.filebase.io/ipfs/bafkreid4zfy2kgmcoevjnouiybwoupmislmz6hynddono2atedb43pm5ei",
      ),
    ).toBe("bafkreid4zfy2kgmcoevjnouiybwoupmislmz6hynddono2atedb43pm5ei")
    expect(gatewayCid("https://x.example/ipfs/bafy/meta.json")).toBe("bafy/meta.json")
    expect(gatewayCid("https://x.example/ipfs/bafy?filename=a.json#top")).toBe("bafy")
  })

  it.each([
    "https://cashtagg.com/api/ipfs-meta/bafkreibizkcpzl3kqqcuj22is63w5hmufrcvffcsf3xkpkscod2afy2cwi",
    "http://x.example/ipfs/bafy",
    "ipfs://bafy",
    "https://x.example/ipfs/",
    "https://x.example/ipfs/../x",
    "https://x.example/ipfs/bafy/../x",
    "https://x.example/ipfs/%2e%2e",
    "https://x.example/ipfs/bafy%2f..%2fx",
    "https://x.example/ipfs/bafy/./x",
    "https://user@x.example/ipfs/bafy",
    "https://x.example/x/ipfs/bafy",
    "loremipsum",
  ])("refuses %s", (uri) => {
    expect(gatewayCid(uri)).toBeNull()
  })
})
