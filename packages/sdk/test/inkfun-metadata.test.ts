import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ipfsCid, parseInkfunMetadata } from "../src/index"

const GATEWAY = "https://gw.example"
const knuckleCreek = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "inkfun-metadata-knuckle-creek.json"), "utf8"),
)

describe("parseInkfunMetadata", () => {
  it("parses the Knuckle Creek metadata", () => {
    expect(parseInkfunMetadata(knuckleCreek, GATEWAY)).toEqual({
      description: null,
      imageUrl: `${GATEWAY}/ipfs/bafkreidozgeqkam2pa7gkw6s3yeei6k3wkhzpp5ffjy7oqtuemteafya5y`,
      links: {
        telegram: null,
        twitter: "https://x.com/ClaymaticGames",
        website: "https://claymatic.games/",
      },
    })
  })

  it("keeps link values as given, including ones that are not URLs", () => {
    const m = parseInkfunMetadata(
      { description: "hi", extensions: { twitter: "wwww.x.com/a", telegram: "t.me/b" } },
      GATEWAY,
    )
    expect(m?.description).toBe("hi")
    expect(m?.links).toEqual({ telegram: "t.me/b", twitter: "wwww.x.com/a", website: null })
  })

  it("has no image unless it is an ipfs:// URI", () => {
    expect(
      parseInkfunMetadata({ image: "https://evil.example/a.png" }, GATEWAY)?.imageUrl,
    ).toBeNull()
    expect(parseInkfunMetadata({ image: 7 }, GATEWAY)?.imageUrl).toBeNull()
    expect(parseInkfunMetadata({}, GATEWAY)?.imageUrl).toBeNull()
  })

  it("ignores fields of the wrong type", () => {
    const m = parseInkfunMetadata(
      { description: 5, extensions: { twitter: 1, website: {} } },
      GATEWAY,
    )
    expect(m).toEqual({
      description: null,
      imageUrl: null,
      links: { telegram: null, twitter: null, website: null },
    })
  })

  it("is null when the JSON is not an object", () => {
    for (const j of [null, "text", 3, [1]]) expect(parseInkfunMetadata(j, GATEWAY)).toBeNull()
  })
})

describe("ipfsCid", () => {
  it("returns the CID and path of an ipfs:// URI", () => {
    expect(ipfsCid("ipfs://bafkreiabc")).toBe("bafkreiabc")
    expect(ipfsCid("ipfs://bafybeiabc/meta/1.json")).toBe("bafybeiabc/meta/1.json")
  })

  it("rejects https and data URIs", () => {
    expect(ipfsCid("https://gw.example/ipfs/bafkreiabc")).toBeNull()
    expect(ipfsCid("data:application/json;base64,e30=")).toBeNull()
    expect(ipfsCid("")).toBeNull()
  })

  it("rejects an empty CID and paths that leave the CID", () => {
    expect(ipfsCid("ipfs://")).toBeNull()
    expect(ipfsCid("ipfs://bafy/../x")).toBeNull()
    expect(ipfsCid("ipfs://bafy?x=1")).toBeNull()
    expect(ipfsCid("ipfs://bafy abc")).toBeNull()
  })
})
