import {
  type AbiEvent,
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  type Hex,
  toEventSelector,
} from "viem"
import { describe, expect, it } from "vitest"
import {
  auctionPriceWei,
  CCA_EVENTS,
  CCA_TOPICS,
  type ChainLog,
  ccaEventsAbi,
  decodeCcaLog,
  decodeNftxLog,
  NFTX_EVENTS,
  NFTX_FLETH,
  NFTX_HOOK,
  NFTX_HOOK_2,
  NFTX_LISTINGS,
  NFTX_LISTINGS_2,
  NFTX_LOCKER,
  NFTX_LOCKER_2,
  NFTX_TOPICS,
  nftxDeploymentAt,
  nftxEventsAbi,
  nftxOrderHash,
  nftxSpotWei,
  poolKeyOf,
  splitTotal,
} from "../src/index"
import { loadNftxAuctionFixture, loadNftxFixture } from "./fixtures"
import { dutchListingsCreated, gatedSale } from "./nftx-synthetic"

const decoded = (logs: ChainLog[]) => logs.map((l) => ({ l, d: decodeNftxLog(l) }))
const one = <K extends NonNullable<ReturnType<typeof decodeNftxLog>>["kind"]>(
  logs: ChainLog[],
  kind: K,
) => {
  const found = decoded(logs).filter((x) => x.d?.kind === kind)
  expect(found).toHaveLength(1)
  return (
    found[0] as unknown as {
      l: ChainLog
      d: Extract<NonNullable<ReturnType<typeof decodeNftxLog>>, { kind: K }>
    }
  ).d
}

const LIL_DUDES = "0x2538d3202844e6b3852570d9ef63a916f900c373"
const FLOOR_TOKEN = "0x370e49749b9ff90004f3186aa7135487acc2a8fc"

describe("Lil Dudes", () => {
  it("decodes Lil Dudes' CollectionCreated: floor token 0x370e…a8fc, name Lil Dudes, symbol LILDUDES, creator 0x9860…3b40", () => {
    const d = one(loadNftxFixture("lildudes-created").logs, "created")
    expect(d).toEqual({
      kind: "created",
      collection: LIL_DUDES,
      token: FLOOR_TOKEN,
      name: "Lil Dudes",
      symbol: "LILDUDES",
      creator: "0x98606955ca2474ac2efd5164bd6360c54d043b40",
    })
  })

  it("Lil Dudes' pool key gives poolId 0x01c00c5f…3282 with flETH as currency0", () => {
    const init = one(loadNftxFixture("lildudes-init").logs, "initialized")
    expect(poolKeyOf(init.poolKey)).toEqual({
      currency0: NFTX_FLETH,
      currency1: FLOOR_TOKEN,
      fee: 8388608,
      tickSpacing: 60,
      hooks: NFTX_HOOK,
      poolId: "0x01c00c5f00fba3d9c1679d4d5cf9443413f9ed018ae2dbc4ebf756e4a5283282",
    })
  })

  it("Lil Dudes' opening sqrt gives 899999999999999 wei", () => {
    const init = one(loadNftxFixture("lildudes-init").logs, "initialized")
    expect(init.sqrtPriceX96).toBe(2640938750475477919784798344622n)
    expect(nftxSpotWei(init.sqrtPriceX96, true)).toBe(899999999999999n)
  })

  it("the 2026-11-12 sqrt gives 308559859825663 wei", () => {
    const state = one(loadNftxFixture("arbitrage-lildudes").logs, "poolState")
    expect(state.sqrtPriceX96).toBe(4510346108847762647197808129394n)
    expect(state.collection).toBe(LIL_DUDES)
    expect(nftxSpotWei(state.sqrtPriceX96, true)).toBe(308559859825663n)
  })

  it("the init transaction's 35 seeded ids are 35 unique ids also in its TokenDeposit", () => {
    const logs = loadNftxFixture("lildudes-init").logs
    const init = one(logs, "initialized")
    const deposit = decoded(logs)
      .map((x) => x.d)
      .filter((d) => d?.kind === "deposit")
    expect(init.tokenIds).toHaveLength(35)
    expect(new Set(init.tokenIds).size).toBe(35)
    expect(deposit).toHaveLength(1)
    const deposited = new Set(deposit[0]?.kind === "deposit" ? deposit[0].tokenIds : [])
    for (const id of init.tokenIds) expect(deposited.has(id)).toBe(true)
  })
})

describe("the second Locker", () => {
  const EYE = "0x9234d821c10b72e09c594f882f1d5dacf2621006"

  it("decodes Eye of the Seeker's CollectionCreated, logged by the second Locker", () => {
    const f = loadNftxFixture("eyeoftheseeker-created")
    expect(f.logs.map((l) => l.address)).toEqual([NFTX_LOCKER_2])
    expect(one(f.logs, "created")).toMatchObject({ kind: "created", collection: EYE })
  })

  it("decodes Eye of the Seeker's deposit, logged by the second Locker", () => {
    const f = loadNftxFixture("eyeoftheseeker-deposit")
    const deposits = f.logs.filter((l) => decodeNftxLog(l)?.kind === "deposit")
    expect(deposits).toHaveLength(1)
    expect(deposits[0]?.address).toBe(NFTX_LOCKER_2)
    expect(one(f.logs, "deposit").collection).toBe(EYE)
  })

  it("names the generation of a collection by its creation block", () => {
    expect(nftxDeploymentAt(52_372_123n).locker).toBe(NFTX_LOCKER)
    expect(nftxDeploymentAt(61_714_954n).listings).toBe(NFTX_LISTINGS)
    expect(nftxDeploymentAt(61_714_955n)).toMatchObject({
      locker: NFTX_LOCKER_2,
      hook: NFTX_HOOK_2,
      listings: NFTX_LISTINGS_2,
    })
    expect(nftxDeploymentAt(61_721_832n).locker).toBe(NFTX_LOCKER_2)
  })

  it("decodes the launchpad's LaunchCreated (built from the ABI, not recorded)", () => {
    const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
    const topics = encodeEventTopics({
      abi: nftxEventsAbi,
      eventName: "LaunchCreated",
      args: { _launchId: 1n, _collection: a(1), _creator: a(2) },
    })
    const data = encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
      ],
      [a(3), a(4), a(5), a(6), a(7)],
    )
    expect(decodeNftxLog({ topics: topics as Hex[], data })).toEqual({
      kind: "launchCreated",
      launchId: 1n,
      collection: a(1),
      creator: a(2),
      floorToken: a(3),
      claimToken: a(4),
      auction: a(5),
    })
  })
})

describe("pool price math", () => {
  const MAX_SQRT = (1n << 160n) - 1n

  it("a sqrt of 0 gives null, and 1 and 2^160−1 give values without throwing", () => {
    expect(nftxSpotWei(0n, true)).toBeNull()
    expect(nftxSpotWei(0n, false)).toBeNull()
    expect(() => nftxSpotWei(1n, true)).not.toThrow()
    expect(() => nftxSpotWei(MAX_SQRT, true)).not.toThrow()
    expect(() => nftxSpotWei(1n, false)).not.toThrow()
    expect(() => nftxSpotWei(MAX_SQRT, false)).not.toThrow()
    // 10^18 · 2^192 fits numeric(78,0); the far end rounds to zero wei, which is no price.
    expect(nftxSpotWei(1n, true)).toBe(10n ** 18n * (1n << 192n))
    expect(nftxSpotWei(MAX_SQRT, true)).toBeNull()
  })

  it("with flETH as currency1 the spot inverts (synthetic)", () => {
    const sqrt = 4510346108847762647197808129394n
    // The mirrored pool has the floor token as currency0: its sqrt is the reciprocal of the real one.
    const mirrored = (1n << 192n) / sqrt
    const flipped = nftxSpotWei(mirrored, false) as bigint
    const real = nftxSpotWei(sqrt, true) as bigint
    expect(flipped - real <= 1n && real - flipped <= 1n).toBe(true)
  })

  it("poolKeyOf refuses bytes that are not 160 long", () => {
    const init = one(loadNftxFixture("lildudes-init").logs, "initialized")
    expect(poolKeyOf(init.poolKey.slice(0, -2) as Hex)).toBeNull()
    expect(poolKeyOf(`${init.poolKey}00` as Hex)).toBeNull()
    expect(poolKeyOf("0x")).toBeNull()
    expect(poolKeyOf("0xzz" as Hex)).toBeNull()
  })
})

describe("Ethereum fixtures", () => {
  it("decodes the Zap buy's ListingsFilled ids [29317] and NFTBoughtWithETH ethSpent", () => {
    const logs = loadNftxFixture("eth-zap-buy").logs
    const filled = one(logs, "filled")
    expect(filled.tokenIds).toEqual([29317n])
    expect(filled.sender).toBe("0xdf288b66a77f25197544877eaf4626d7e64cb5a8")
    const bought = one(logs, "zapBought")
    expect(bought.ethSpent).toBe(12587756629698255n)
    expect(bought.nftCount).toBe(1n)
    expect(one(logs, "withdrawal").recipient).toBe("0xdab629a638974c6e5c34c9a17d4f4e5caca15f63")
  })

  it("decodes the liquid ListingsCreated at 1.20x with type liquid", () => {
    const created = one(loadNftxFixture("eth-listing-created").logs, "listingsCreated")
    expect(created.tokenIds).toEqual([24375n])
    expect(created.listing.floorMultiple).toBe(120)
    expect(created.listingType).toBe("liquid")
    expect(created.listing.owner).toBe("0xd7bba3d47e8b612c09f14c9efcacd7c6fe6466f2")
  })

  it("decodes ListingRelisted at 1.10x", () => {
    const relisted = one(loadNftxFixture("eth-relist").logs, "relisted")
    expect(relisted.tokenId).toBe(19758n)
    expect(relisted.listing.floorMultiple).toBe(110)
    expect(relisted.listing.owner).toBe("0x498e93bc04955fcbac04bcf1a3ba792f01dbaa96")
  })

  it("decodes FloorRedeemedWithETH and NFTSoldForETH ids and amounts", () => {
    const redeemed = one(loadNftxFixture("eth-floor-redeemed").logs, "zapRedeemed")
    expect(redeemed.tokenIds).toEqual([1700n])
    expect(redeemed.ethSpent).toBe(699598868589792183n)
    const sold = one(loadNftxFixture("eth-sold-for-eth").logs, "zapSold")
    expect(sold.tokenIds).toEqual([3430n])
    expect(sold.ethReceived).toBe(10150412504793657n)
  })

  it("decodes a Dutch ListingsCreated (synthetic)", () => {
    const d = decodeNftxLog(dutchListingsCreated())
    expect(d?.kind === "listingsCreated" && d.listingType).toBe("dutch")
    expect(d?.kind === "listingsCreated" && d.listing.duration).toBe(5 * 86_400)
  })

  it("decodes GatedSale (synthetic)", () => {
    const d = decodeNftxLog(gatedSale())
    expect(d).toMatchObject({
      kind: "gatedSale",
      tokenIds: [3430n],
      ethReceived: 10150412504793657n,
      royalty: 1_000_000_000_000n,
      seller: "0xc8f04c44bd4a6ac2858c85dd237357b6244c88b3",
    })
  })

  it("returns null for another topic and for data that does not decode", () => {
    const log = loadNftxFixture("eth-zap-buy").logs.find(
      (l) => decodeNftxLog(l)?.kind === "filled",
    ) as ChainLog
    expect(decodeNftxLog({ topics: [`0x${"11".repeat(32)}`], data: "0x" })).toBeNull()
    expect(decodeNftxLog({ topics: log.topics, data: "0x1234" })).toBeNull()
  })
})

describe("INKTRONS auction", () => {
  const fx = loadNftxAuctionFixture()
  const created = () => {
    const d = decodeCcaLog(fx.created)
    if (d?.kind !== "auctionCreated") throw new Error("no AuctionCreated")
    return d
  }

  it("INKTRONS' AuctionCreated config: start 60385189, end 60471589, claim 60471889, currency zero, required raise 0, floor 7922816251426433759354300", () => {
    const d = created()
    expect(d.auction).toBe("0xf74d83a782aa45ec00d4f425714c028749a03563")
    expect(d.token).toBe("0xc166c1b94ae9e2a590346ca6d103a4a6636a9f63")
    expect(d.amount).toBe(1100n * 10n ** 18n)
    expect(d.config).toMatchObject({
      currency: "0x0000000000000000000000000000000000000000",
      startBlock: 60385189n,
      endBlock: 60471589n,
      claimBlock: 60471889n,
      requiredCurrencyRaised: 0n,
      floorPrice: 7922816251426433759354300n,
    })
  })

  it("the floor price is 99999999999999 wei per token", () => {
    expect(auctionPriceWei(created().config.floorPrice)).toBe(99999999999999n)
  })

  it("INKTRONS has 12 BidSubmitted by 11 owners", () => {
    const bids = fx.logs.flatMap((l) => {
      const d = decodeCcaLog(l)
      return d?.kind === "bid" ? [d] : []
    })
    expect(bids).toHaveLength(12)
    expect(new Set(bids.map((b) => b.owner)).size).toBe(11)
  })

  it("an AuctionCreated with truncated configData decodes to null", () => {
    const d = created()
    const truncated = encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes" }],
      [d.amount, "0x1234567890abcdef"],
    )
    expect(decodeCcaLog({ ...fx.created, data: truncated })).toBeNull()
  })

  it("the totalSupply at creation is 2222e18 and the checkpoint multicall at the end differs from plain reads", () => {
    expect(fx.tokenSupplyAtCreation).toBe(2222n * 10n ** 18n)
    const end = fx.checkpoints.find((c) => c.block === 60471589n)?.read
    expect(end).toEqual({
      clearingPriceQ96: 7922816251426433759354300n,
      currencyRaised: 10171999999999999n,
      totalCleared: 101720000000000000000n,
      graduated: true,
    })
    expect(fx.plainAtEnd.currencyRaised).toBe(5718586445766492n)
    expect(fx.plainAtEnd.totalCleared).toBe(57185864457664924185n)
  })
})

describe("helpers", () => {
  it("splitTotal of 10 over weights 1,1,1 gives 3,3,4", () => {
    expect(splitTotal(10n, [1n, 1n, 1n])).toEqual([3n, 3n, 4n])
  })

  it("splitTotal splits in proportion to the weights and always adds up to the total", () => {
    expect(splitTotal(100n, [1n, 3n])).toEqual([25n, 75n])
    const parts = splitTotal(1_000_003n, [7n, 11n, 13n, 17n])
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1_000_003n)
    expect(splitTotal(9n, [0n, 0n, 0n])).toEqual([3n, 3n, 3n])
    expect(splitTotal(5n, [])).toEqual([])
  })

  it("nftxOrderHash is 32 bytes and differs per token id", () => {
    const tx = `0x${"ab".repeat(32)}` as Hex
    const a = nftxOrderHash(tx, 3, 1n)
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(nftxOrderHash(tx, 3, 2n)).not.toBe(a)
    expect(nftxOrderHash(tx, 4, 1n)).not.toBe(a)
    expect(nftxOrderHash(tx, 3, 1n)).toBe(a)
  })
})

describe("topics", () => {
  it("every NFTX_TOPICS and CCA_TOPICS entry matches its signature", () => {
    for (const name of Object.keys(NFTX_EVENTS)) {
      const item = getAbiItem({ abi: nftxEventsAbi, name } as Parameters<typeof getAbiItem>[0])
      expect(NFTX_TOPICS[name as keyof typeof NFTX_TOPICS], name).toBe(
        toEventSelector(item as AbiEvent),
      )
    }
    for (const name of Object.keys(CCA_EVENTS)) {
      const item = getAbiItem({ abi: ccaEventsAbi, name } as Parameters<typeof getAbiItem>[0])
      expect(CCA_TOPICS[name as keyof typeof CCA_TOPICS], name).toBe(
        toEventSelector(item as AbiEvent),
      )
    }
  })
})
