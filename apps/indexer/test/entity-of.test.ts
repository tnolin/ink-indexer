import type { IndexerEvent, NftEvent } from "@ink-indexer/events"
import { describe, expect, it } from "vitest"
import { entityOf } from "../src/sources/source"

const contract = "0x00000000000000000000000000000000000000c1" as const
const base = {
  v: 1,
  chainId: 57073,
  contract,
  source: "chain",
  txHash: "0xabc",
  logIndex: 0,
  blockNumber: "1",
  blockTimestamp: 1,
} as const

// Only the discriminant matters to entityOf; a cast keeps this table short.
const nft = (type: NftEvent["type"]) => ({ ...base, type }) as unknown as NftEvent

describe("entityOf", () => {
  it.each([
    "nft.collection",
    "nft.drop",
    "nft.mint",
    "nft.listing",
    "nft.sale",
    "nft.stats",
  ] as const)("returns the contract for %s", (type) => {
    expect(entityOf(nft(type))).toBe(contract)
  })

  it.each(["launchpad.launch", "launchpad.trade", "launchpad.bond"] as const)(
    "returns the token for %s",
    (type) => {
      const token = "0x00000000000000000000000000000000000000d1"
      expect(entityOf({ type, token } as unknown as IndexerEvent)).toBe(token)
    },
  )
})
