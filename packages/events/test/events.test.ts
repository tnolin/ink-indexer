import { describe, expect, expectTypeOf, it } from "vitest"
import {
  type Address,
  type BondEvent,
  type BondEventV1,
  type Hash,
  type IndexerEvent,
  type LaunchEvent,
  type LaunchEventV1,
  type LaunchpadEvent,
  type LaunchpadKey,
  type NftCollectionEvent,
  type NftDropEvent,
  type NftEvent,
  type NftLaunchEvent,
  type NftListingEvent,
  type NftMintEvent,
  type NftSaleEvent,
  type NftStatsEvent,
  SCHEMA_VERSION,
  type StoredEvent,
  type SwapEvent,
  type TradeEvent,
  type TradeEventV1,
} from "../src/index"

describe("@ink-indexer/events", () => {
  it("schema version is 2", () => {
    expect(SCHEMA_VERSION).toBe(2)
  })

  it("LaunchpadKey lists five launchpads", () => {
    expectTypeOf<LaunchpadKey>().toEqualTypeOf<
      "inkypump" | "inkfun" | "tsunami" | "hookit" | "chimera"
    >()
  })

  it("narrows launchpad.swap", () => {
    const onlySwaps = (e: IndexerEvent) => (e.type === "launchpad.swap" ? e : null)
    expectTypeOf(onlySwaps).returns.toEqualTypeOf<SwapEvent | null>()
    const supply = (e: SwapEvent) => e.supply
    expectTypeOf(supply).returns.toEqualTypeOf<string>()
    expectTypeOf<SwapEvent["side"]>().toEqualTypeOf<"buy" | "sell">()
    expectTypeOf<SwapEvent["poolId"]>().toEqualTypeOf<Hash>()
    expectTypeOf<SwapEvent>().toExtend<LaunchpadEvent>()
  })

  it("launch events carry the pool fields", () => {
    expectTypeOf<LaunchEvent["startsInPool"]>().toEqualTypeOf<boolean>()
    expectTypeOf<LaunchEvent["poolId"]>().toEqualTypeOf<Hash | null>()
    expectTypeOf<LaunchEvent["poolManager"]>().toEqualTypeOf<Address | null>()
    expectTypeOf<LaunchEvent["customHook"]>().toEqualTypeOf<boolean | null>()
    expectTypeOf<LaunchEvent["hookModules"]>().toEqualTypeOf<string[] | null>()
    expectTypeOf<LaunchEvent["targetRaise"]>().toEqualTypeOf<string | null>()
  })

  it("trades carry the running ath and bonds the pool manager", () => {
    expectTypeOf<TradeEvent["athMarketCap"]>().toEqualTypeOf<string>()
    expectTypeOf<BondEvent["poolManager"]>().toEqualTypeOf<Address>()
  })

  it("StoredEvent accepts a v1 trade without athMarketCap", () => {
    const { athMarketCap: _ath, v: _v, ...rest } = {} as TradeEvent
    const old: TradeEventV1 = { ...rest, v: 1, launchpad: "inkypump" }
    const stored: StoredEvent = old
    expect(stored.v).toBe(1)
    expectTypeOf<TradeEventV1["v"]>().toEqualTypeOf<1>()
    expectTypeOf<LaunchEventV1["v"]>().toEqualTypeOf<1>()
    expectTypeOf<BondEventV1["v"]>().toEqualTypeOf<1>()
    expectTypeOf<IndexerEvent>().toExtend<StoredEvent>()
  })

  it("narrows the union by type", () => {
    const onlyTrades = (e: IndexerEvent) => (e.type === "launchpad.trade" ? e : null)
    expectTypeOf(onlyTrades).returns.toEqualTypeOf<TradeEvent | null>()
  })

  it("narrows nft.listing", () => {
    const onlyListings = (e: IndexerEvent) => (e.type === "nft.listing" ? e : null)
    expectTypeOf(onlyListings).returns.toEqualTypeOf<NftListingEvent | null>()
    const price = (e: NftListingEvent) => e.priceWei
    expectTypeOf(price).returns.toEqualTypeOf<string>()
  })

  it("nft.mint progress has markBps", () => {
    const e: NftMintEvent = {
      v: 1,
      chainId: 57073,
      contract: "0x1",
      source: "chain",
      txHash: "0xabc",
      logIndex: 0,
      blockNumber: "1",
      blockTimestamp: 1,
      type: "nft.mint",
      kind: "progress",
      stageIndex: 0,
      stageLabel: "Public",
      stagePriceWei: "0",
      markBps: 2500,
      minted: "250",
      maxSupply: "1000",
      mintStartTs: 1,
      stageStartTs: 1,
      minters: 40,
    }
    expect(e.markBps).toBe(2500)
    expectTypeOf(e.kind).toEqualTypeOf<"stage_start" | "progress" | "sold_out">()
    expectTypeOf<NftMintEvent["stageCounts"]>().toEqualTypeOf<
      { stageIndex: number; label: string; minted: string }[] | undefined
    >()
  })

  it("markBps rejects a number outside 2500, 5000, 7500 or null", () => {
    expectTypeOf<NftMintEvent["markBps"]>().toEqualTypeOf<2500 | 5000 | 7500 | null>()
    const mark = (e: NftMintEvent) => {
      e.markBps = 7500
      e.markBps = null
      // @ts-expect-error 3000 is not a milestone
      e.markBps = 3000
    }
    expect(mark).toBeTypeOf("function")
  })

  it("a drop stage may have no end, cap or allowlist", () => {
    type Stage = NftDropEvent["stages"][number]
    expectTypeOf<Stage["endTime"]>().toEqualTypeOf<number | null>()
    expectTypeOf<Stage["maxPerWallet"]>().toEqualTypeOf<number | null>()
    expectTypeOf<Stage["allowlistCount"]>().toEqualTypeOf<number | null>()
  })

  it("IndexerEvent includes NftSaleEvent", () => {
    expectTypeOf<NftSaleEvent>().toExtend<IndexerEvent>()
    expectTypeOf<NftEvent>().toExtend<IndexerEvent>()
    expectTypeOf<LaunchpadEvent>().toExtend<IndexerEvent>()
    expectTypeOf<IndexerEvent>().toEqualTypeOf<LaunchpadEvent | NftEvent>()
  })

  it("nft.collection carries the launchpad and its token", () => {
    expectTypeOf<NftCollectionEvent["launchpad"]>().toEqualTypeOf<"chimera" | null>()
    expectTypeOf<NftCollectionEvent["launchToken"]>().toEqualTypeOf<Address | null>()
    expectTypeOf<NftCollectionEvent["gates"]["structure"]>().toEqualTypeOf<
      "pass" | "fail" | "pending" | "n/a"
    >()
  })

  it("nft.collection carries the creator and their OpenSea account state", () => {
    expectTypeOf<NftCollectionEvent["creator"]>().toEqualTypeOf<{
      address: Address
      username: string | null
      verified: boolean
    } | null>()
  })

  it("nft.launch is a chain event of a Chimera campaign", () => {
    const e: NftLaunchEvent = {
      v: 1,
      chainId: 57073,
      contract: "0x1",
      source: "chain",
      txHash: "0xabc",
      logIndex: 2,
      blockNumber: "1",
      blockTimestamp: 1,
      type: "nft.launch",
      launchpad: "chimera",
      campaignId: "7",
      token: "0x2",
      tokenSymbol: null,
      tokenName: "Token",
      creator: "0x3",
      poolId: "0x4",
    }
    expect(e.tokenSymbol).toBeNull()
    expectTypeOf<NftLaunchEvent["launchpad"]>().toEqualTypeOf<"chimera">()
    expectTypeOf<NftLaunchEvent["campaignId"]>().toEqualTypeOf<string>()
    expectTypeOf<NftLaunchEvent["tokenSymbol"]>().toEqualTypeOf<string | null>()
    expectTypeOf<NftLaunchEvent["tokenName"]>().toEqualTypeOf<string | null>()
    expectTypeOf<NftLaunchEvent["creator"]>().toEqualTypeOf<Address>()
    expectTypeOf<NftLaunchEvent["poolId"]>().toEqualTypeOf<Hash>()
    expectTypeOf<NftLaunchEvent>().toExtend<NftEvent>()
    const onlyLaunches = (x: IndexerEvent) => (x.type === "nft.launch" ? x : null)
    expectTypeOf(onlyLaunches).returns.toEqualTypeOf<NftLaunchEvent | null>()
  })

  it("nft.stats carries the cap and the listed count", () => {
    expectTypeOf<NftStatsEvent["totalSupply"]>().toEqualTypeOf<string | null>()
    expectTypeOf<NftStatsEvent["maxSupply"]>().toEqualTypeOf<string | null>()
    expectTypeOf<NftStatsEvent["listedCount"]>().toEqualTypeOf<number | null>()
    expectTypeOf<NftStatsEvent["listedCapped"]>().toEqualTypeOf<boolean>()
  })
})
