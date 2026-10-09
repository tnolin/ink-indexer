import { type Hash, pad, toEventSelector, toHex } from "viem"
import { describe, expect, it } from "vitest"
import { decodeLog, LOG_TOPICS, TOPICS } from "../src/index"
import {
  launchCreatedLog,
  launchFinalizedLog,
  launchMetadataLog,
  tradeLog,
  xstocksHookCreatedLog,
} from "./builders"

const ID = 0x2412946c6aefee2ca1a0ddf01ba72177f71625798fd5ad9f1c6f36cff55b3ec0n
const ID_HEX = toHex(ID, { size: 32 })
const CREATOR = "0x00000000000000000000000000000000000000c1"
const TOKEN = "0x00000000000000000000000000000000000000d1"
const TRADER = "0x2795e88aa2b9a0034ce4e7a9e1af9a0f7d28a046"

describe("decodeLog", () => {
  it("pins topic0 values to InkyPump's documented signatures", () => {
    expect(TOPICS.launchCreated).toBe(
      toEventSelector("LaunchCreated(uint256,address,address,uint96)"),
    )
    expect(TOPICS.launchMetadata).toBe(
      toEventSelector("LaunchMetadata(uint256,string,string,string,string,string,string,string)"),
    )
    expect(TOPICS.trade).toBe(
      toEventSelector(
        "Trade(uint256,address,uint8,(uint256,uint128,uint40),(address,uint256,uint256),uint256)",
      ),
    )
    expect(TOPICS.launchFinalized).toBe(
      toEventSelector("LaunchFinalized(uint256,bytes32,uint256,uint256)"),
    )
    expect(LOG_TOPICS).toHaveLength(5)
  })

  it("decodes LaunchCreated", () => {
    const log = launchCreatedLog({
      launchId: ID,
      creator: CREATOR,
      token: TOKEN,
      targetRaise: 3n * 10n ** 18n,
    })
    expect(decodeLog(log)).toEqual({
      kind: "launchCreated",
      launchId: ID_HEX,
      creator: CREATOR,
      token: TOKEN,
      targetRaise: 3n * 10n ** 18n,
    })
  })

  it("decodes LaunchMetadata", () => {
    const log = launchMetadataLog({
      launchId: ID,
      name: "Shark",
      ticker: "FIN",
      website: "https://x.y",
    })
    expect(decodeLog(log)).toEqual({
      kind: "launchMetadata",
      launchId: ID_HEX,
      name: "Shark",
      ticker: "FIN",
      description: "",
      imageUrl: "",
      telegram: "",
      twitter: "",
      website: "https://x.y",
    })
  })

  it("decodes buy and sell trades", () => {
    const common = {
      launchId: ID,
      trader: TRADER,
      price: 1463554654n,
      sold: 10996462298049720546679419n,
      timestamp: 1791387680,
      tokenAmount: 30708246874275790000000000n,
      quoteAmount: 48935925345611340n,
    } as const
    expect(decodeLog(tradeLog({ ...common, side: "sell" }))).toEqual({
      kind: "trade",
      launchId: ID_HEX,
      trader: TRADER,
      side: "sell",
      price: 1463554654n,
      sold: 10996462298049720546679419n,
      timestamp: 1791387680,
      tokenAmount: 30708246874275790000000000n,
      quoteAmount: 48935925345611340n,
      refund: 0n,
    })
    expect(decodeLog(tradeLog({ ...common, side: "buy" }))).toMatchObject({ side: "buy" })
  })

  it("decodes LaunchFinalized", () => {
    const poolId = ID_HEX as Hash
    const log = launchFinalizedLog({
      launchId: ID,
      poolId,
      liquidityQuote: 2n,
      liquidityTokens: 3n,
    })
    expect(decodeLog(log)).toEqual({
      kind: "launchFinalized",
      launchId: ID_HEX,
      poolId,
      liquidityQuote: 2n,
      liquidityTokens: 3n,
    })
  })

  it("decodes the xStocks factory hook-created event from its indexed topics", () => {
    const assetId = pad("0x07bc", { size: 32 }) as Hash
    const log = xstocksHookCreatedLog({
      assetId,
      wrapper: "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171",
      hook: "0x799def4ec4a0a293a59b53a6479afc5a9df76ac4",
    })
    expect(decodeLog(log)).toEqual({
      kind: "xstocksHookCreated",
      assetId,
      wrapper: "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171",
      hook: "0x799def4ec4a0a293a59b53a6479afc5a9df76ac4",
    })
  })

  it("returns null for an unrelated topic0", () => {
    expect(decodeLog({ topics: [pad("0x1234", { size: 32 })], data: "0x" })).toBeNull()
  })
})
