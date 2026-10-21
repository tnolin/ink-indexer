import { describe, expect, it } from "vitest"
import { loadOpenSeaFixture } from "./fixtures"

type Saved = { status: number; body: Record<string, unknown> }
type Frames = { counts: Record<string, number>; frames: { atMs: number; frame: unknown[] }[] }

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const BURST = "0x165dcae7953657e23035c96503b2a5b51ddfa4cd"
const rest = (name: string) => loadOpenSeaFixture(name) as Saved

describe("OpenSea REST fixtures", () => {
  it("maps contracts to their collection slugs", () => {
    expect(rest(`contract/${HORNET}`).body.collection).toBe("ink-hornet")
    expect(rest(`contract/${BURST}`).body.collection).toBe("inkverse-ii")
  })

  it("holds collection details and stats", () => {
    expect(rest("collections/ink-hornet").status).toBe(200)
    const stats = rest("collections/ink-hornet/stats").body as { total: { num_owners: number } }
    expect(stats.total.num_owners).toBeGreaterThan(0)
  })

  it("holds the 404 for collections that are not drops", () => {
    expect(rest("drops/prtscn-ink").status).toBe(404)
    expect(rest("drops/wiredonink").status).toBe(404)
  })

  it("holds a ranked token with traits from Hornet and an unranked one from the burst collection", () => {
    const hornet = rest(`nfts/${HORNET}/1`).body.nft as { traits: unknown[]; rarity: unknown }
    expect(hornet.traits.length).toBeGreaterThan(0)
    expect(hornet.rarity).not.toBeNull()
    const burst = rest(`nfts/${BURST}/1`).body.nft as { traits: unknown[]; rarity: unknown }
    expect(burst.traits).toHaveLength(0)
    expect(burst.rarity).toBeNull()
  })

  it("holds a page of Hornet tokens and a page of new collections", () => {
    expect(rest("collection-nfts/ink-hornet").status).toBe(200)
    expect(rest("collections-new").status).toBe(200)
  })
})

describe("OpenSea Stream fixtures", () => {
  it("holds frames from the four collections", () => {
    const { counts, frames } = loadOpenSeaFixture("stream/collections") as Frames
    expect(frames.length).toBeGreaterThan(0)
    expect(Object.keys(counts).some((k) => k.startsWith("collection:ink-hornet "))).toBe(true)
    for (const f of frames) expect(f.frame).toHaveLength(5)
  })

  it("holds the refusal of the 51st join", () => {
    const { frames } = loadOpenSeaFixture("stream/join-limit") as Frames
    expect(frames).toHaveLength(51)
    const last = frames.at(-1)!.frame
    expect(last[3]).toBe("phx_reply")
    expect((last[4] as { status: string }).status).toBe("error")
  })

  it("holds a heartbeat reply", () => {
    const { reply } = loadOpenSeaFixture("stream/heartbeat") as { reply: unknown[] }
    expect(reply[2]).toBe("phoenix")
    expect((reply[4] as { status: string }).status).toBe("ok")
  })
})
