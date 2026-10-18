import { describe, expect, expectTypeOf, it } from "vitest"
import {
  type Address,
  type IndexerEvent,
  type LaunchpadEvent,
  type NftCollectionEvent,
  type NftDropEvent,
  type NftEvent,
  type NftListingEvent,
  type NftMintEvent,
  type NftSaleEvent,
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
})
