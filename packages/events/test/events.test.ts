import { describe, expect, expectTypeOf, it } from "vitest"
import {
  type Address,
  type Hash,
  type IndexerEvent,
  type LaunchpadEvent,
  type NftCollectionEvent,
  type NftDropEvent,
  type NftEvent,
  type NftLaunchEvent,
  type NftListingEvent,
  type NftMintEvent,
  type NftSaleEvent,
  type NftStatsEvent,
  SCHEMA_VERSION,
  type TradeEvent,
} from "../src/index"

describe("@ink-indexer/events", () => {
  it("is schema version 1", () => {
    expect(SCHEMA_VERSION).toBe(1)
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
    expectTypeOf<NftStatsEvent["maxSupply"]>().toEqualTypeOf<string | null>()
    expectTypeOf<NftStatsEvent["listedCount"]>().toEqualTypeOf<number | null>()
    expectTypeOf<NftStatsEvent["listedCapped"]>().toEqualTypeOf<boolean>()
  })
})
