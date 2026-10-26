import {
  decodeNftTransfers,
  decodeSeaDropLog,
  parseCollection,
  parseDrop,
  parseNft,
} from "@ink-indexer/sdk"
import { describe, expect, it } from "vitest"
import {
  loadFarmWallets,
  loadNftFixture,
  type NftFixtureName,
} from "../../../packages/sdk/test/fixtures"
import { classifyKind, type KindFacts } from "../src/sources/nft/kind"
import { SHARED_LINK_MAX } from "../src/sources/nft/policy"
import {
  evaluateGates,
  type GateFacts,
  mintLiveDue,
  nextVerdictAt,
  pageReason,
  traitsSchedule,
} from "../src/sources/nft/verdict"
import { loadOpenSeaFixture } from "./opensea/fixtures"

const MIN = 60
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const INKVERSE = "0xfffbd67f37e1e9fd9d9ebef9b687daa72a33da64"
const PRTSCN = "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448"
const WIRED = "0x7c701c0148e0e965065aa05e008ac9341e6efc6c"
const BURST = "0x165dcae7953657e23035c96503b2a5b51ddfa4cd"

/** Facts of a collection that passes every gate it can, minted an hour ago and still minting. */
function facts(over: Partial<GateFacts> = {}): GateFacts {
  const now = 1_000_000
  return {
    kind: "drop",
    override: null,
    safelist: null,
    creatorVerified: false,
    page: {
      slug: "x",
      name: "X",
      imageUrl: "https://img",
      twitter: "x",
      website: null,
    },
    sharedLinks: { twitter: false, website: false },
    nameCopy: false,
    discoveryRetrying: false,
    dropStages: [{ type: "signed_presale" }, { type: "public_sale" }],
    stageIndexes: [0, 1],
    firstMintTs: now - HOUR,
    lastMintTs: now - MIN,
    soldOutTs: null,
    now,
    traits: { state: "pending", checks: 0 },
    farmShareBps: 0,
    distinctMinters: 100,
    ...over,
  }
}

const kindFacts = (over: Partial<KindFacts> = {}): KindFacts => ({
  launchpad: null,
  mints7d: 500,
  burns7d: 0,
  seadrop: false,
  maxSupply: null,
  maxSupplyChecked: true,
  firstMintTs: 2_000_000,
  historyStartTs: 1_000_000,
  priorMinted: false,
  ...over,
})

// ---- Reference collections, from their recorded mints and OpenSea responses ----

/** Fixture block n has time n (as in FakeChain), so differences between blocks are seconds. */
function chainFacts(name: NftFixtureName, contract: string) {
  let first: number | null = null
  let last: number | null = null
  let mints = 0
  let burns = 0
  const minters = new Set<string>()
  const stages = new Set<number>()
  for (const l of loadNftFixture(name)) {
    const sd = decodeSeaDropLog(l)
    if (sd?.kind === "seadropMint" && sd.contract === contract) stages.add(sd.stage)
    for (const t of decodeNftTransfers(l)) {
      if (t.contract !== contract) continue
      if (t.kind === "burn") {
        burns++
        continue
      }
      const ts = Number(l.blockNumber)
      first ??= ts
      last = ts
      mints++
      minters.add(t.account)
    }
  }
  return { first: first!, last: last!, mints, burns, minters, stages: [...stages] }
}

const body = (name: string) => (loadOpenSeaFixture(name) as { status: number; body: unknown }).body

function pageOf(slug: string) {
  const c = parseCollection(body(`collections/${slug}`))!
  return {
    page: {
      slug: c.slug,
      name: c.name,
      imageUrl: c.imageUrl,
      twitter: c.twitter,
      website: c.website,
    },
    safelist: c.safelist,
  }
}

function dropStagesOf(slug: string) {
  const r = loadOpenSeaFixture(`drops/${slug}`) as { status: number; body: unknown }
  return r.status === 200 ? parseDrop(r.body)!.stages.map((s) => ({ type: s.type })) : []
}

function traitsOf(contract: string, id: string): GateFacts["traits"] {
  const nft = parseNft(body(`nfts/${contract}/${id}`))!
  return {
    // As the traits job stores it: traits or a rank pass, neither is empty.
    state: nft.traits.length > 0 || nft.rank !== null ? "pass" : "empty",
    checks: 4,
  }
}

/** Farm share by the gate's definition, over the recorded recipient sets of the ten largest bursts. */
function farmShare(contract: string, minters: Set<string>) {
  const sets = Object.entries(loadFarmWallets())
    .filter(([k]) => k !== "farmWallets" && k !== contract)
    .map(([, v]) => new Set<string>(v))
  let farm = 0
  for (const w of minters) if (sets.filter((s) => s.has(w)).length >= 5) farm++
  return Math.floor((farm * 10_000) / minters.size)
}

describe("reference collections", () => {
  it("burst: single free public stage, done in 2 minutes → structure fail → filtered", () => {
    const c = chainFacts("burst-mints", BURST)
    const recorded = new Set(loadFarmWallets()[BURST])
    const f = facts({
      ...pageOf("inkverse-ii"),
      dropStages: dropStagesOf("inkverse-ii"),
      stageIndexes: c.stages,
      firstMintTs: c.first,
      lastMintTs: c.first + 2 * MIN,
      soldOutTs: c.first + 2 * MIN,
      now: c.first + 35 * MIN,
      traits: { state: "pending", checks: 0 },
      farmShareBps: farmShare(BURST, recorded),
      distinctMinters: recorded.size,
    })
    expect(c.stages).toEqual([0])
    const { gates, verdict } = evaluateGates(f)
    expect(gates.structure).toBe("fail")
    expect(gates.page).toBe("fail")
    expect(gates.farm).toBe("fail")
    expect(gates.farmShareBps).toBeGreaterThan(3000)
    expect(verdict).toBe("filtered")

    // Not sold out but stopped after two minutes: the same once 30 minutes have passed.
    const stopped = evaluateGates({ ...f, soldOutTs: null })
    expect(stopped.gates.structure).toBe("fail")
    // Its sampled item has no traits and no rank: gate 3 fails 72 hours after the sell-out.
    const later = evaluateGates({
      ...f,
      traits: traitsOf(BURST, "1"),
      now: c.first + 2 * MIN + 72 * HOUR,
    })
    expect(later.gates.traits).toBe("fail")
  })

  it("hornet: 4 stages → structure pass; page pass; traits pending → real", () => {
    const c = chainFacts("hornet-mints", HORNET)
    const f = facts({
      ...pageOf("ink-hornet"),
      dropStages: dropStagesOf("ink-hornet"),
      stageIndexes: c.stages,
      firstMintTs: c.first,
      lastMintTs: c.last,
      soldOutTs: c.last,
      now: c.last + HOUR,
      traits: { state: "pending", checks: 0 },
      farmShareBps: farmShare(HORNET, c.minters),
      distinctMinters: c.minters.size,
    })
    expect(f.dropStages).toHaveLength(4)
    expect(c.mints).toBe(2222)
    const { gates, verdict } = evaluateGates(f)
    expect(gates).toEqual({
      page: "pass",
      structure: "pass",
      traits: "pending",
      farm: "pass",
      farmShareBps: 0,
    })
    expect(verdict).toBe("real")
    // With its sampled item (traits present) the verdict stays real.
    expect(evaluateGates({ ...f, traits: traitsOf(HORNET, "1") }).gates.traits).toBe("pass")
  })

  it("inkverse: signed presale stages → real", () => {
    const c = chainFacts("inkverse-mints", INKVERSE)
    const f = facts({
      ...pageOf("inkverse-920024436"),
      dropStages: dropStagesOf("inkverse-920024436"),
      stageIndexes: c.stages,
      firstMintTs: c.first,
      lastMintTs: c.last,
      soldOutTs: c.last,
      now: c.last + HOUR,
      traits: traitsOf(INKVERSE, "1"),
      farmShareBps: farmShare(INKVERSE, c.minters),
      distinctMinters: c.minters.size,
    })
    // Sold out before the public stage: only signed stages minted.
    expect(c.stages.sort()).toEqual([1, 2, 3])
    // Even a single signed stage passes gate 2.
    expect(
      evaluateGates({ ...f, dropStages: [{ type: "signed_presale" }], stageIndexes: [1] }).gates
        .structure,
    ).toBe("pass")
    const { gates, verdict } = evaluateGates(f)
    expect(gates.structure).toBe("pass")
    expect(gates.page).toBe("pass")
    expect(gates.traits).toBe("pass")
    expect(gates.farm).toBe("pass")
    expect(gates.farmShareBps).toBeLessThan(100)
    expect(verdict).toBe("real")
  })

  it("prtscn non-SeaDrop, 46 minutes → structure pass by duration", () => {
    const c = chainFacts("prtscn-mints", PRTSCN)
    expect(c.last - c.first).toBeGreaterThan(46 * MIN)
    const base = facts({
      ...pageOf("prtscn-ink"),
      dropStages: dropStagesOf("prtscn-ink"),
      stageIndexes: [],
      firstMintTs: c.first,
      lastMintTs: c.last,
      soldOutTs: c.last,
      now: c.last + HOUR,
      traits: traitsOf(PRTSCN, "489"),
      farmShareBps: farmShare(PRTSCN, c.minters),
      distinctMinters: c.minters.size,
    })
    expect(base.safelist).toBe("verified")
    // Judged on its gates alone, without the verified shortcut.
    const { gates, verdict } = evaluateGates({ ...base, safelist: null })
    expect(gates).toMatchObject({ page: "pass", structure: "pass", traits: "pass", farm: "pass" })
    expect(verdict).toBe("real")
    expect(evaluateGates(base).verdict).toBe("real")

    // Thirty minutes in, still minting: passes; ten minutes in: pending.
    const early = { ...base, safelist: null, soldOutTs: null }
    expect(
      evaluateGates({ ...early, lastMintTs: c.first + 29 * MIN, now: c.first + 30 * MIN }).gates
        .structure,
    ).toBe("pass")
    expect(
      evaluateGates({ ...early, lastMintTs: c.first + 9 * MIN, now: c.first + 10 * MIN }).gates
        .structure,
    ).toBe("pending")
  })

  it("wired: continuous → structure n/a, farm n/a → real when page and traits pass", () => {
    const c = chainFacts("wired-transfers", WIRED)
    const kind = classifyKind(
      kindFacts({
        mints7d: c.mints,
        burns7d: c.burns,
        firstMintTs: c.first,
        historyStartTs: c.first - DAY,
      }),
    )
    expect(kind).toBe("continuous")
    const f = facts({
      ...pageOf("wiredonink"),
      safelist: null,
      kind,
      dropStages: dropStagesOf("wiredonink"),
      stageIndexes: [],
      firstMintTs: c.first,
      lastMintTs: c.last,
      now: c.last + MIN,
      traits: traitsOf(WIRED, "4164"),
      farmShareBps: null,
      distinctMinters: c.minters.size,
    })
    const { gates, verdict } = evaluateGates(f)
    expect(gates).toEqual({
      page: "pass",
      structure: "n/a",
      traits: "pass",
      farm: "n/a",
      farmShareBps: null,
    })
    expect(verdict).toBe("real")
    // Never judged on mint grounds: minting stopped after a minute, a farm share would fail.
    expect(
      evaluateGates({ ...f, lastMintTs: c.first + MIN, now: c.first + HOUR, farmShareBps: 9000 })
        .verdict,
    ).toBe("real")
  })
})

describe("kind", () => {
  it("a chimera collection is continuous from its first block, with zero burns", () => {
    expect(classifyKind(kindFacts({ launchpad: "chimera", mints7d: 1, burns7d: 0 }))).toBe(
      "continuous",
    )
    // Before any mint and before the history starts, too.
    expect(classifyKind(kindFacts({ launchpad: "chimera", mints7d: 0, firstMintTs: null }))).toBe(
      "continuous",
    )
    expect(classifyKind(kindFacts({ launchpad: "chimera", firstMintTs: 1 }))).toBe("continuous")
    // A manual mark still wins.
    expect(classifyKind(kindFacts({ launchpad: "chimera", override: "drop" }))).toBe("drop")
  })

  it("a non-chimera WIRED-like history is continuous by the burn fallback", () => {
    const c = chainFacts("wired-transfers", WIRED)
    const f = kindFacts({ mints7d: c.mints, burns7d: c.burns })
    expect(c.mints).toBeGreaterThanOrEqual(100)
    expect(classifyKind(f)).toBe("continuous")
    // Each condition is needed: a max supply, SeaDrop, too few mints, too few burns.
    expect(classifyKind({ ...f, maxSupply: 1000n })).toBe("pending_kind")
    expect(classifyKind({ ...f, maxSupplyChecked: false })).toBe("pending_kind")
    expect(classifyKind({ ...f, seadrop: true })).toBe("drop")
    expect(classifyKind({ ...f, mints7d: 99, burns7d: 99 })).toBe("pending_kind")
    expect(classifyKind({ ...f, mints7d: 1000, burns7d: 199 })).toBe("pending_kind")
    expect(classifyKind({ ...f, mints7d: 1000, burns7d: 200 })).toBe("continuous")
    expect(classifyKind({ ...f, override: "drop" })).toBe("drop")
  })

  it("pending_kind when burns ≥ 5% and no SeaDrop", () => {
    expect(classifyKind(kindFacts({ mints7d: 20, burns7d: 1 }))).toBe("pending_kind")
    expect(classifyKind(kindFacts({ mints7d: 21, burns7d: 1 }))).toBe("drop")
    expect(classifyKind(kindFacts({ mints7d: 20, burns7d: 1, seadrop: true }))).toBe("drop")
    expect(classifyKind(kindFacts({ mints7d: 20, burns7d: 0 }))).toBe("drop")
  })

  it("legacy when the collection had a supply before its first stored mint", () => {
    // An old collection that mints again: its first stored mint is inside the history.
    expect(classifyKind(kindFacts({ priorMinted: true }))).toBe("legacy")
    expect(classifyKind(kindFacts({ priorMinted: true, seadrop: true }))).toBe("legacy")
    expect(classifyKind(kindFacts({ priorMinted: true, mints7d: 969, burns7d: 971 }))).toBe(
      "legacy",
    )
    // Chimera stays continuous, and a manual mark still wins.
    expect(classifyKind(kindFacts({ priorMinted: true, launchpad: "chimera" }))).toBe("continuous")
    expect(classifyKind(kindFacts({ priorMinted: true, override: "drop" }))).toBe("drop")
  })

  it("legacy when the first mint predates history", () => {
    expect(classifyKind(kindFacts({ firstMintTs: 999_999 }))).toBe("legacy")
    expect(classifyKind(kindFacts({ firstMintTs: 1_000_000 }))).toBe("drop")
    // No stored mint: legacy, unless SeaDrop says a mint is coming.
    expect(classifyKind(kindFacts({ firstMintTs: null }))).toBe("legacy")
    expect(classifyKind(kindFacts({ firstMintTs: null, seadrop: true }))).toBe("drop")
    expect(classifyKind(kindFacts({ firstMintTs: 1, override: "continuous" }))).toBe("continuous")
  })
})

describe("gates", () => {
  it("a chimera collection with a failing page gate is pending or filtered, never judged on structure or farm share", () => {
    const chimera = facts({
      kind: "continuous",
      dropStages: [],
      stageIndexes: [],
      lastMintTs: 1_000_000 - 50 * MIN,
      farmShareBps: 9000,
    })
    expect(evaluateGates(chimera)).toEqual({
      gates: { page: "pass", structure: "n/a", traits: "pending", farm: "n/a", farmShareBps: null },
      verdict: "real",
    })
    const noSocials = { ...chimera, page: { ...chimera.page, twitter: null, website: null } }
    expect(evaluateGates(noSocials).verdict).toBe("filtered")
    expect(evaluateGates(noSocials).gates.structure).toBe("n/a")
    const noSlug = {
      ...chimera,
      page: { slug: null, name: null, imageUrl: null, twitter: null, website: null },
      discoveryRetrying: true,
    }
    expect(evaluateGates(noSlug).verdict).toBe("pending")
  })

  it("verified overrides failing gates", () => {
    const failing = facts({
      page: { slug: "x", name: "X", imageUrl: null, twitter: null, website: null },
      dropStages: [{ type: "public_sale" }],
      stageIndexes: [0],
      lastMintTs: 1_000_000 - 59 * MIN,
      farmShareBps: 9000,
    })
    expect(evaluateGates(failing).verdict).toBe("filtered")
    const v = evaluateGates({ ...failing, safelist: "verified" })
    expect(v.verdict).toBe("real")
    expect(v.gates.page).toBe("pass")
    expect(v.gates.structure).toBe("pass")
  })

  it("manual filtered overrides verified", () => {
    expect(evaluateGates(facts({ safelist: "verified", override: "filtered" })).verdict).toBe(
      "filtered",
    )
    expect(evaluateGates(facts({ creatorVerified: true, override: "filtered" })).verdict).toBe(
      "filtered",
    )
    // And a manual real overrides failing gates.
    const failing = facts({ farmShareBps: 9000 })
    expect(evaluateGates(failing).verdict).toBe("filtered")
    expect(evaluateGates({ ...failing, override: "real" }).verdict).toBe("real")
  })

  it("gate 1 pending inside 7 days with no slug, fail after", () => {
    const none = { slug: null, name: null, imageUrl: null, twitter: null, website: null }
    const retrying = evaluateGates(facts({ page: none, discoveryRetrying: true }))
    expect(retrying.gates.page).toBe("pending")
    expect(retrying.verdict).toBe("pending")
    const gaveUp = evaluateGates(facts({ page: none, discoveryRetrying: false }))
    expect(gaveUp.gates.page).toBe("fail")
    expect(gaveUp.verdict).toBe("filtered")
  })

  it("gate 1 fail turns pass when socials appear", () => {
    const bare = facts({
      page: { slug: "x", name: "X", imageUrl: "https://img", twitter: null, website: null },
    })
    expect(evaluateGates(bare).gates.page).toBe("fail")
    expect(evaluateGates(bare).verdict).toBe("filtered")
    const site = evaluateGates({ ...bare, page: { ...bare.page, website: "https://x.art" } })
    expect(site.gates.page).toBe("pass")
    expect(site.verdict).toBe("real")
    // A name and an image are needed as well.
    expect(
      evaluateGates({ ...bare, page: { ...bare.page, twitter: "x", name: null } }).gates.page,
    ).toBe("fail")
  })

  describe("gate 1 shared links and copied names", () => {
    const page = (over: Partial<GateFacts["page"]> = {}) => ({
      slug: "x",
      name: "X",
      imageUrl: "https://img",
      twitter: "x",
      website: null,
      ...over,
    })

    it("counts a link on more than 5 collections as missing", () => {
      expect(SHARED_LINK_MAX).toBe(5)
      const shared = facts({ sharedLinks: { twitter: true, website: false } })
      expect(evaluateGates(shared).gates.page).toBe("fail")
      expect(evaluateGates(shared).verdict).toBe("filtered")
      expect(pageReason(shared)).toBe(
        "page: X shared by more than 5 collections (limit: 5 collections or fewer per link)",
      )
    })

    it("passes on a link that is not shared, even when the other one is", () => {
      const f = facts({
        page: page({ website: "https://x.art" }),
        sharedLinks: { twitter: true, website: false },
      })
      expect(evaluateGates(f).gates.page).toBe("pass")
      expect(pageReason(f)).toBeNull()
    })

    it("names both links when both are shared, and the website alone when only it is", () => {
      const both = facts({
        page: page({ website: "https://x.art" }),
        sharedLinks: { twitter: true, website: true },
      })
      expect(evaluateGates(both).gates.page).toBe("fail")
      expect(pageReason(both)).toBe(
        "page: X and website shared by more than 5 collections (limit: 5 collections or fewer per link)",
      )
      const site = facts({
        page: page({ twitter: null, website: "https://x.art" }),
        sharedLinks: { twitter: false, website: true },
      })
      expect(pageReason(site)).toMatch(/^page: website shared by more than 5 collections/)
    })

    it("keeps the existing reason for a page with no links", () => {
      const bare = facts({ page: page({ twitter: null }) })
      expect(pageReason(bare)).toBe(
        "page: missing X or website (limit: name, image, and X or website)",
      )
    })

    it("fails a collection whose name copies a verified or manually real collection", () => {
      const copy = facts({ nameCopy: true })
      expect(evaluateGates(copy).gates.page).toBe("fail")
      expect(evaluateGates(copy).verdict).toBe("filtered")
      expect(pageReason(copy)).toBe(
        "page: name copies a verified or manually real collection (limit: a name those collections do not hold)",
      )
    })

    it("never fails a verified collection or creator on either rule", () => {
      const both = { nameCopy: true, sharedLinks: { twitter: true, website: true } }
      expect(evaluateGates(facts({ ...both, safelist: "verified" })).gates.page).toBe("pass")
      expect(evaluateGates(facts({ ...both, creatorVerified: true })).gates.page).toBe("pass")
      expect(pageReason(facts({ ...both, safelist: "verified" }))).toBeNull()
    })

    it("lets a manual real mark override both rules", () => {
      const f = facts({
        nameCopy: true,
        sharedLinks: { twitter: true, website: false },
        override: "real",
      })
      expect(evaluateGates(f).verdict).toBe("real")
      expect(evaluateGates({ ...f, override: null }).verdict).toBe("filtered")
    })
  })

  it("traits fail only 72h after mint end", () => {
    const end = 1_000_000
    const ended = facts({
      firstMintTs: end - 2 * HOUR,
      lastMintTs: end,
      soldOutTs: end,
      traits: { state: "empty", checks: 3 },
    })
    // Before the last checkpoint: pending, and the verdict stays real.
    const before = evaluateGates({ ...ended, now: end + 71 * HOUR })
    expect(before.gates.traits).toBe("pending")
    expect(before.verdict).toBe("real")
    const after = evaluateGates({
      ...ended,
      now: end + 72 * HOUR,
      traits: { state: "empty", checks: 4 },
    })
    expect(after.gates.traits).toBe("fail")
    expect(after.verdict).toBe("filtered")
    // A pass at any checkpoint holds.
    expect(
      evaluateGates({ ...ended, now: end + 80 * HOUR, traits: { state: "pass", checks: 2 } }).gates
        .traits,
    ).toBe("pass")
    // Not sold out: the mint ends after a day with no mints.
    const idle = facts({
      firstMintTs: end - 2 * HOUR,
      lastMintTs: end,
      soldOutTs: null,
      traits: { state: "empty", checks: 4 },
    })
    expect(evaluateGates({ ...idle, now: end + DAY + 71 * HOUR }).gates.traits).toBe("pending")
    expect(evaluateGates({ ...idle, now: end + DAY + 72 * HOUR }).gates.traits).toBe("fail")
  })

  it("farm share 31% with 60 minters → filtered; 31% with 40 minters → pending farm", () => {
    const sixty = evaluateGates(facts({ farmShareBps: 3100, distinctMinters: 60 }))
    expect(sixty.gates.farm).toBe("fail")
    expect(sixty.gates.farmShareBps).toBe(3100)
    expect(sixty.verdict).toBe("filtered")
    const forty = evaluateGates(facts({ farmShareBps: 3100, distinctMinters: 40 }))
    expect(forty.gates.farm).toBe("pending")
    expect(forty.verdict).toBe("real")
    expect(evaluateGates(facts({ farmShareBps: 3000, distinctMinters: 60 })).gates.farm).toBe(
      "pass",
    )
    // Not measured yet.
    expect(evaluateGates(facts({ farmShareBps: null, distinctMinters: 60 })).gates.farm).toBe(
      "pending",
    )
  })

  it("verified creator passes gates 1 and 2 immediately", () => {
    const young = facts({
      page: { slug: null, name: null, imageUrl: null, twitter: null, website: null },
      discoveryRetrying: true,
      dropStages: [],
      stageIndexes: [],
      firstMintTs: 1_000_000 - MIN,
      lastMintTs: 1_000_000,
    })
    expect(evaluateGates(young).verdict).toBe("pending")
    const v = evaluateGates({ ...young, creatorVerified: true })
    expect(v.gates.page).toBe("pass")
    expect(v.gates.structure).toBe("pass")
    expect(v.verdict).toBe("real")
  })

  it("pending_kind: never judged on mint grounds", () => {
    const f = facts({
      kind: "pending_kind",
      dropStages: [],
      stageIndexes: [],
      lastMintTs: 1_000_000 - 55 * MIN,
      farmShareBps: 9000,
    })
    const { gates, verdict } = evaluateGates(f)
    expect(gates.structure).toBe("pending")
    expect(gates.farm).toBe("n/a")
    expect(verdict).toBe("pending")
  })

  it("legacy: gates 2 and 4 do not apply", () => {
    const { gates, verdict } = evaluateGates(
      facts({ kind: "legacy", firstMintTs: null, lastMintTs: null, farmShareBps: null }),
    )
    expect(gates.structure).toBe("n/a")
    expect(gates.farm).toBe("n/a")
    expect(verdict).toBe("real")
  })
})

describe("MINT LIVE", () => {
  const live = (over: Partial<Parameters<typeof mintLiveDue>[0]> = {}) => ({
    ...facts({
      dropStages: [],
      stageIndexes: [],
      firstMintTs: 1_000_000 - 2 * MIN,
      lastMintTs: 1_000_000,
    }),
    seadrop: false,
    mintStartEmitted: false,
    minted: 12,
    ...over,
  })

  it("non-SeaDrop mint with a verified creator emits MINT LIVE after 10 mints, not 30 minutes", () => {
    expect(mintLiveDue(live())).toBe(false)
    expect(mintLiveDue(live({ creatorVerified: true }))).toBe(true)
    expect(mintLiveDue(live({ creatorVerified: true, minted: 9 }))).toBe(false)
    expect(mintLiveDue(live({ safelist: "verified", minted: 10 }))).toBe(true)
  })

  it("an unverified mint is announced once gate 2 passes by duration", () => {
    const first = 1_000_000 - 30 * MIN
    expect(
      mintLiveDue(
        live({ firstMintTs: first, lastMintTs: first + 28 * MIN, now: first + 29 * MIN }),
      ),
    ).toBe(false)
    expect(
      mintLiveDue(
        live({ firstMintTs: first, lastMintTs: first + 29 * MIN, now: first + 30 * MIN }),
      ),
    ).toBe(true)
    // Stopped minting after five minutes: gate 2 fails, nothing to announce.
    expect(
      mintLiveDue(live({ firstMintTs: first, lastMintTs: first + 5 * MIN, now: first + 30 * MIN })),
    ).toBe(false)
  })

  it("never for SeaDrop, pending_kind, other kinds, a finished mint or a second time", () => {
    const verified = { creatorVerified: true }
    expect(mintLiveDue(live({ ...verified, seadrop: true }))).toBe(false)
    expect(mintLiveDue(live({ ...verified, kind: "pending_kind" }))).toBe(false)
    expect(mintLiveDue(live({ ...verified, kind: "continuous" }))).toBe(false)
    expect(mintLiveDue(live({ ...verified, mintStartEmitted: true }))).toBe(false)
    expect(mintLiveDue(live({ ...verified, soldOutTs: 1_000_000 }))).toBe(false)
  })
})

describe("schedule", () => {
  it("the verdict is due 30 minutes after the first mint while gate 2 waits, then hourly while minting", () => {
    const first = 1_000_000
    const f = facts({
      dropStages: [],
      stageIndexes: [],
      firstMintTs: first,
      lastMintTs: first + 60,
      now: first + 120,
    })
    expect(nextVerdictAt(f)).toBe(first + 30 * MIN)
    expect(nextVerdictAt({ ...f, now: first + 40 * MIN, lastMintTs: first + 39 * MIN })).toBe(
      first + 40 * MIN + HOUR,
    )
    // Ended (sold out): nothing left to look at.
    expect(
      nextVerdictAt({
        ...f,
        now: first + 40 * MIN,
        lastMintTs: first + 39 * MIN,
        soldOutTs: first + 39 * MIN,
      }),
    ).toBeNull()
    // Close to a day without mints: due when the mint ends.
    expect(nextVerdictAt({ ...f, now: first + DAY - 1, lastMintTs: first })).toBe(first + DAY)
  })

  it("a Chimera collection or a legacy one is looked at again only when its traits can be sampled", () => {
    const f = facts({ firstMintTs: 1_000_000 - HOUR, lastMintTs: 1_000_000 })
    // Legacy: when the mint ends, a day after the last mint.
    expect(nextVerdictAt({ ...f, kind: "legacy" })).toBe(1_000_000 + DAY)
    // Continuous has no mint end: its first day stands in for one.
    expect(nextVerdictAt({ ...f, kind: "continuous" }, { kindFixed: true })).toBe(
      1_000_000 - HOUR + DAY,
    )
    expect(nextVerdictAt({ ...f, kind: "legacy", firstMintTs: null, lastMintTs: null })).toBeNull()
    // A continuous collection found by the burn ratio is looked at through its kind window.
    expect(nextVerdictAt({ ...f, kind: "continuous" })).toBe(1_000_000 + HOUR)
    expect(nextVerdictAt({ ...f, kind: "continuous", now: f.firstMintTs! + 8 * DAY })).toBeNull()
  })

  it("traits are sampled at the mint end, then 24, 48 and 72 hours later", () => {
    const end = 1_000_000
    const f = facts({
      firstMintTs: end - HOUR,
      lastMintTs: end,
      soldOutTs: end,
      now: end - MIN,
      traits: { state: "pending", checks: 0 },
    })
    // Before the end nothing is scheduled.
    expect(traitsSchedule({ ...f, soldOutTs: null })).toEqual({ nextTraitsAt: null, checks: 0 })
    expect(traitsSchedule(f)).toEqual({ nextTraitsAt: end, checks: 0 })
    expect(
      traitsSchedule({ ...f, now: end + HOUR, traits: { state: "empty", checks: 1 } }),
    ).toEqual({ nextTraitsAt: end + DAY, checks: 1 })
    expect(
      traitsSchedule({ ...f, now: end + 3 * DAY, traits: { state: "empty", checks: 3 } }),
    ).toEqual({ nextTraitsAt: end + 3 * DAY, checks: 3 })
    // Checkpoints missed while down are skipped: the latest one past is sampled.
    expect(traitsSchedule({ ...f, now: end + 50 * HOUR })).toEqual({
      nextTraitsAt: end + 2 * DAY,
      checks: 2,
    })
    expect(
      traitsSchedule({ ...f, now: end + 80 * HOUR, traits: { state: "empty", checks: 4 } }),
    ).toEqual({ nextTraitsAt: null, checks: 4 })
    expect(traitsSchedule({ ...f, traits: { state: "pass", checks: 1 } })).toEqual({
      nextTraitsAt: null,
      checks: 1,
    })
  })

  it("a stored traits time that is due, or sooner than the computed one, is kept", () => {
    const end = 1_000_000
    const f = facts({
      firstMintTs: end - HOUR,
      lastMintTs: end,
      soldOutTs: end,
      now: end + HOUR,
      traits: { state: "empty", checks: 1 },
    })
    // The computed time is the next checkpoint, a day on.
    expect(traitsSchedule(f)).toEqual({ nextTraitsAt: end + DAY, checks: 1 })
    // Due now (a burst asked for it): kept.
    expect(traitsSchedule(f, f.now)).toEqual({ nextTraitsAt: f.now, checks: 1 })
    expect(traitsSchedule(f, f.now - MIN).nextTraitsAt).toBe(f.now - MIN)
    // Sooner than the checkpoint: kept. Later than it: the checkpoint.
    expect(traitsSchedule(f, f.now + MIN).nextTraitsAt).toBe(f.now + MIN)
    expect(traitsSchedule(f, end + 2 * DAY).nextTraitsAt).toBe(end + DAY)
    // No checkpoint at all (mint running): a due time is kept, a future one is not.
    const running = { ...f, soldOutTs: null, lastMintTs: f.now - MIN }
    expect(traitsSchedule(running, f.now).nextTraitsAt).toBe(f.now)
    expect(traitsSchedule(running, f.now + DAY).nextTraitsAt).toBeNull()
    // A sample that passed needs none.
    expect(
      traitsSchedule({ ...f, traits: { state: "pass", checks: 1 } }, f.now).nextTraitsAt,
    ).toBeNull()
  })
})
