import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { inlineJson, parseHookitMetadata } from "../src/index"

const GATEWAY = "https://gw.example"
const recorded = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"))
const hkt = recorded("hookit-metadata-hkt.json")
const hmu = recorded("hookit-metadata-hmu.json")
const qcard = recorded("hookit-metadata-qcard.json")
const quillLaunch = recorded("hookit-quill-launch.json")
const EMPTY_LINKS = { telegram: null, twitter: null, website: null }

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64")
const dataUri = (v: unknown) => `data:application/json;base64,${b64(v)}`

/** The `metadataURI()` string the QUILL launch fixture recorded. */
function quillUri(): string {
  const found = JSON.stringify(quillLaunch).match(/data:application\/json;base64,[A-Za-z0-9+/=]+/)
  if (found === null) throw new Error("fixture has no inline metadata URI")
  return found[0]
}

describe("parseHookitMetadata", () => {
  it("parses $HKT's metadata", () => {
    expect(parseHookitMetadata(hkt, GATEWAY)).toEqual({
      description: "Hold one, get all",
      imageUrl: `${GATEWAY}/ipfs/QmTQYPvhm6A9gTwwrQUnHqvuRFkcvfaiGRN49BnTSawzoH`,
      links: { telegram: null, twitter: "@hookitfun", website: null },
    })
  })

  it("parses HMU's metadata", () => {
    expect(parseHookitMetadata(hmu, GATEWAY)).toEqual({
      description: "get hooked to every stock",
      imageUrl: `${GATEWAY}/ipfs/QmRqfYAsdy4tdCm2iwaJJdb6uQU6kDJiZTAxDCbMqBAq7H`,
      links: EMPTY_LINKS,
    })
  })

  it("twitter, telegram and website come from top-level keys", () => {
    expect(parseHookitMetadata(qcard, GATEWAY)?.links).toEqual({
      telegram: null,
      twitter: "qcarddotfun",
      website: "https://qcard.fun/",
    })
    expect(
      parseHookitMetadata(
        { twitter: "https://x.com/a", telegram: "t.me/b", website: "a.example" },
        GATEWAY,
      )?.links,
    ).toEqual({ telegram: "t.me/b", twitter: "https://x.com/a", website: "a.example" })
  })

  it("does not read links from nested keys", () => {
    expect(
      parseHookitMetadata(
        { socials: { twitter: "https://x.com/a" }, extensions: { x: "y" } },
        GATEWAY,
      )?.links,
    ).toEqual(EMPTY_LINKS)
  })

  it("cuts a description at 4,000 characters", () => {
    expect(
      parseHookitMetadata({ description: "a".repeat(5_000) }, GATEWAY)?.description,
    ).toHaveLength(4_000)
  })

  it("drops a link over 2,048 characters and keeps one of exactly 2,048", () => {
    const long = `https://a.example/${"p".repeat(2_048 - "https://a.example/".length)}`
    expect(long).toHaveLength(2_048)
    expect(parseHookitMetadata({ website: long }, GATEWAY)?.links.website).toBe(long)
    expect(parseHookitMetadata({ website: `${long}p` }, GATEWAY)?.links.website).toBeNull()
    expect(
      parseHookitMetadata({ website: "https://a.example/".padEnd(3_000, "p") }, GATEWAY)?.links
        .website,
    ).toBeNull()
  })

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,x",
    "http://a.example",
    "vbscript:x",
    "ftp://a.example",
  ])("drops the link %s", (website) => {
    expect(
      parseHookitMetadata({ website, twitter: website, telegram: website }, GATEWAY)?.links,
    ).toEqual(EMPTY_LINKS)
  })

  it.each([
    ["a leading space", " javascript:x"],
    ["a tab inside the scheme", "java\tscript:x"],
    ["a newline inside the scheme", "java\nscript:x"],
    ["a carriage return inside the scheme", "java\rscript:x"],
    ["a leading newline", "\njavascript:x"],
  ])("drops a link with %s", (_name, website) => {
    expect(parseHookitMetadata({ website }, GATEWAY)?.links.website).toBeNull()
  })

  it("ignores fields of the wrong type", () => {
    expect(
      parseHookitMetadata(
        { description: 5, image: 7, twitter: 1, website: {}, telegram: [] },
        GATEWAY,
      ),
    ).toEqual({ description: null, imageUrl: null, links: EMPTY_LINKS })
  })

  it.each([
    ["http", "http://images.example/a.png"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:image/png;base64,AAAA"],
    ["a relative path", "/marks/a.png"],
    ["credentials", "https://user:pw@images.example/a.png"],
    ["over 2,048 characters", `https://images.example/${"a".repeat(2_048)}.png`],
    ["a 3000-character url", `https://images.example/${"a".repeat(3_000)}`],
  ])("drops an image that is %s", (_name, image) => {
    expect(parseHookitMetadata({ image }, GATEWAY)?.imageUrl).toBeNull()
  })

  it("drops an ipfs:// image over 2,048 characters", () => {
    const cid = "b".repeat(5_000)
    expect(parseHookitMetadata({ image: `ipfs://${cid}` }, GATEWAY)?.imageUrl).toBeNull()
    const fits = "b".repeat(2_048 - `${GATEWAY}/ipfs/`.length)
    expect(parseHookitMetadata({ image: `ipfs://${fits}` }, GATEWAY)?.imageUrl).toBe(
      `${GATEWAY}/ipfs/${fits}`,
    )
  })

  it("keeps an https image", () => {
    expect(parseHookitMetadata({ image: "https://images.example/a.png" }, GATEWAY)?.imageUrl).toBe(
      "https://images.example/a.png",
    )
  })

  it("serves an ipfs:// image with a path through the gateway", () => {
    expect(parseHookitMetadata({ image: "ipfs://bafyabc/quill-logo.jpg" }, GATEWAY)?.imageUrl).toBe(
      `${GATEWAY}/ipfs/bafyabc/quill-logo.jpg`,
    )
  })

  it("drops an ipfs:// image that escapes its directory", () => {
    expect(parseHookitMetadata({ image: "ipfs://bafyabc/../x" }, GATEWAY)?.imageUrl).toBeNull()
  })

  it("a non-object JSON gives null", () => {
    for (const j of [null, "text", 3, true, [1], undefined]) {
      expect(parseHookitMetadata(j, GATEWAY)).toBeNull()
    }
  })

  it("JSON nested deeper than the limit gives null", () => {
    let deep: unknown = "x"
    for (let i = 0; i < 40; i++) deep = { a: deep }
    expect(parseHookitMetadata({ description: "d", extra: deep }, GATEWAY)).toBeNull()
    let deepArray: unknown = 1
    for (let i = 0; i < 40; i++) deepArray = [deepArray]
    expect(parseHookitMetadata({ description: "d", extra: deepArray }, GATEWAY)).toBeNull()
  })

  it("JSON nested 30,000 deep gives null without throwing", () => {
    const depth = 30_000
    const parsed = JSON.parse(`{"a":${"[".repeat(depth)}${"]".repeat(depth)}}`)
    expect(parseHookitMetadata(parsed, GATEWAY)).toBeNull()
  })

  it("keeps the nesting the recorded documents use", () => {
    const m = parseHookitMetadata(
      { description: "d", holderAirdropStepPct: [60, 40, 0], nested: { a: { b: [1] } } },
      GATEWAY,
    )
    expect(m?.description).toBe("d")
  })

  it("NUL and lone surrogates in the description are removed", () => {
    const m = parseHookitMetadata({ description: "a\u0000b\ud800c\udc00d" }, GATEWAY)
    expect(m?.description).toBe("ab�c�d")
    expect(m?.description).not.toContain("\u0000")
  })

  it("NUL and lone surrogates in a link are removed", () => {
    const m = parseHookitMetadata({ twitter: "a\u0000\ud800b" }, GATEWAY)
    expect(m?.links.twitter).toBe("a�b")
  })
})

describe("inlineJson", () => {
  it("decodes QUILL's data: URI, and its image is an ipfs link served through the gateway", () => {
    const json = inlineJson(quillUri())
    expect(json).toMatchObject({ name: "QUILL", symbol: "QL", app: "hookit" })
    expect(parseHookitMetadata(json, GATEWAY)).toEqual({
      description: null,
      imageUrl: `${GATEWAY}/ipfs/bafybeielfywpazmeiexmxoucohsso3m5b2ajscvo4pux4tdq5zd7paeaay/quill-logo.jpg`,
      links: EMPTY_LINKS,
    })
  })

  it("accepts the prefix in any case", () => {
    expect(inlineJson(`DATA:Application/JSON;BASE64,${b64({ a: 1 })}`)).toEqual({ a: 1 })
  })

  it("accepts an unpadded-free, padded and empty-object body", () => {
    expect(inlineJson(dataUri({}))).toEqual({})
    expect(inlineJson(dataUri({ a: "b" }))).toEqual({ a: "b" })
    expect(inlineJson(dataUri({ a: "bc" }))).toEqual({ a: "bc" })
  })

  // With the 29-character prefix, the longest URI whose body is a whole number of base64 groups is 8,189.
  const uriOfLength = (length: number) => {
    const prefix = "data:application/json;base64,"
    const raw = ((length - prefix.length) / 4) * 3
    const value = { p: "x".repeat(raw - 8) }
    const uri = prefix + Buffer.from(JSON.stringify(value)).toString("base64")
    expect(uri).toHaveLength(length)
    return { uri, value }
  }

  it("the longest URI under the limit is decoded", () => {
    const { uri, value } = uriOfLength(8_189)
    expect(inlineJson(uri)).toEqual(value)
  })

  it("a data: URI over 8,192 characters gives null", () => {
    const uri = dataUri({ p: "x".repeat(9 * 1024) })
    expect(uri.length).toBeGreaterThan(8_192)
    expect(inlineJson(uri)).toBeNull()
  })

  it("the shortest well-formed URI over 8,192 characters gives null", () => {
    expect(inlineJson(uriOfLength(8_193).uri)).toBeNull()
  })

  it.each([
    ["https", "https://a.example/m.json"],
    ["ipfs", "ipfs://bafkreiabc"],
    ["javascript", "javascript:alert(1)"],
    ["another media type", `data:text/html;base64,${b64({ a: 1 })}`],
    ["plain data", `data:application/json,${JSON.stringify({ a: 1 })}`],
    ["a charset parameter", `data:application/json;charset=utf-8;base64,${b64({ a: 1 })}`],
    ["a leading space", ` data:application/json;base64,${b64({ a: 1 })}`],
    ["no prefix", b64({ a: 1 })],
    ["an empty string", ""],
  ])("%s gives null", (_name, uri) => {
    expect(inlineJson(uri)).toBeNull()
  })

  it("a different 29-character prefix before a valid body gives null", () => {
    expect(inlineJson(`data:application/jsox;base64,${b64({ a: 1 })}`)).toBeNull()
    expect(inlineJson(`${"x".repeat(29)}${b64({ a: 1 })}`)).toBeNull()
  })

  it("a body that is not base64 gives null", () => {
    expect(inlineJson("data:application/json;base64,not base64 at all!")).toBeNull()
    expect(inlineJson("data:application/json;base64,====")).toBeNull()
  })

  it("a base64 body whose length is not a multiple of 4 gives null", () => {
    expect(
      inlineJson(`data:application/json;base64,${b64({ a: 1 }).replace(/=+$/, "")}`),
    ).toBeNull()
    expect(inlineJson("data:application/json;base64,eyJhIjoxfQ")).toBeNull()
    expect(inlineJson("data:application/json;base64,eyJhIjoxfQ=")).toBeNull()
  })

  it("a data: URI with characters outside base64 is refused before decoding", () => {
    // Buffer.from skips these characters, so decoding would give the valid body {"a":1}.
    const valid = b64({ a: 1 })
    expect(inlineJson(`data:application/json;base64,${valid}`)).toEqual({ a: 1 })
    for (const junk of ["!", " ", "\n", "-", "_", "%", "é", "\u0000"]) {
      const uri = `data:application/json;base64,${valid.slice(0, 4)}${junk}${valid.slice(4)}`
      expect(inlineJson(uri), JSON.stringify(junk)).toBeNull()
    }
    // A whole group of junk keeps the length a multiple of 4; decoding would still skip it.
    expect(inlineJson(`data:application/json;base64,${valid}!!!!`)).toBeNull()
  })

  it("padding in the middle gives null", () => {
    expect(inlineJson("data:application/json;base64,ey==IjoxfQ==")).toBeNull()
  })

  it("a base64 body that decodes to something that is not JSON gives null", () => {
    expect(
      inlineJson(`data:application/json;base64,${Buffer.from("not json").toString("base64")}`),
    ).toBeNull()
    expect(
      inlineJson(`data:application/json;base64,${Buffer.from("{").toString("base64")}`),
    ).toBeNull()
    expect(inlineJson("data:application/json;base64,")).toBeNull()
  })

  it("a body that is valid base64 but not valid text still does not throw", () => {
    expect(() => inlineJson("data:application/json;base64,//8A////")).not.toThrow()
    expect(inlineJson("data:application/json;base64,//8A////")).toBeNull()
  })

  it("JSON that is not an object parses and is rejected by parseHookitMetadata", () => {
    for (const v of [1, "s", [1], null, true]) {
      expect(parseHookitMetadata(inlineJson(dataUri(v)), GATEWAY)).toBeNull()
    }
  })

  it("NUL and lone surrogates in inline JSON are removed from the description", () => {
    const uri = `data:application/json;base64,${Buffer.from('{"description":"a\\u0000b\\ud800c"}').toString("base64")}`
    expect(parseHookitMetadata(inlineJson(uri), GATEWAY)?.description).toBe("ab�c")
  })
})
