import { describe, expect, expectTypeOf, it } from "vitest"
import { type IndexerEvent, SCHEMA_VERSION, type TradeEvent } from "../src/index"

describe("@ink-indexer/events", () => {
  it("is schema version 1", () => {
    expect(SCHEMA_VERSION).toBe(1)
  })

  it("narrows the union by type", () => {
    const onlyTrades = (e: IndexerEvent) => (e.type === "launchpad.trade" ? e : null)
    expectTypeOf(onlyTrades).returns.toEqualTypeOf<TradeEvent | null>()
  })
})
