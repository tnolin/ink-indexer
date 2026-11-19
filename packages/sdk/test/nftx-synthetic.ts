// Logs that no chain has produced yet, built from the real ABI and the real log they stand in for.
// Each carries the transaction hash and block of that real log.
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem"
import { type ChainLog, decodeNftxLog, nftxEventsAbi } from "../src/index"
import { loadNftxFixture } from "./fixtures"

const at = (fx: ChainLog[], kind: string) => {
  const found = fx.find((l) => decodeNftxLog(l)?.kind === kind)
  if (!found) throw new Error(`fixture has no ${kind} log`)
  return found
}

/** A Dutch `ListingsCreated`: the real liquid one with its listing type set to 0. */
export function dutchListingsCreated(): ChainLog {
  const real = at(loadNftxFixture("eth-listing-created").logs, "listingsCreated")
  const d = decodeNftxLog(real)
  if (d?.kind !== "listingsCreated") throw new Error("unreachable")
  const data = encodeAbiParameters(
    [
      { type: "uint256[]" },
      {
        type: "tuple",
        components: [
          { type: "address" },
          { type: "uint40" },
          { type: "uint32" },
          { type: "uint16" },
        ],
      },
      { type: "uint8" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "address" },
    ],
    [
      d.tokenIds,
      [d.listing.owner, d.listing.created, 5 * 86_400, d.listing.floorMultiple],
      0,
      d.tokensRequired,
      d.taxRequired,
      d.sender,
    ],
  )
  return { ...real, data }
}

/** A `GatedSale`: the real `NFTSoldForETH` re-encoded with the gate's field order and a royalty. */
export function gatedSale(royalty = 1_000_000_000_000n): ChainLog {
  const real = at(loadNftxFixture("eth-sold-for-eth").logs, "zapSold")
  const d = decodeNftxLog(real)
  if (d?.kind !== "zapSold") throw new Error("unreachable")
  const topics = encodeEventTopics({
    abi: nftxEventsAbi,
    eventName: "GatedSale",
    args: { _collection: d.collection, _seller: d.seller },
  }) as Hex[]
  const data = encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "uint256" }, { type: "uint256" }],
    [d.tokenIds, d.ethReceived, royalty],
  )
  return { ...real, topics, data }
}
