import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  type PublicClient,
  parseAbi,
} from "viem"
import { ccaAuctionAbi, nftxCollectionAbi, nftxListingsAbi } from "./abi"
import { NFTX_LISTINGS, nftxDeploymentAt } from "./constants"

export type NftxReader = Pick<PublicClient, "multicall" | "call">

/** The Multicall3 contract; it is at the same address on every chain. */
export const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11"

/** Items per multicall, so one `ListingsFilled` with thousands of ids is read in bounded calls. */
const READ_CHUNK = 250

export type NftxListingRead = {
  owner: Address
  /** Unix seconds. */
  created: number
  /** Seconds. */
  duration: number
  /** 100 is 1.00x. */
  floorMultiple: number
  /** Floor-token units, 1e18 per NFT; null when `getListingPrice` reverts. */
  priceTokens: bigint | null
  /** Null when `getListingType` reverts or the listing has none. */
  type: "liquid" | "dutch" | null
}

const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += READ_CHUNK) out.push(items.slice(i, i + READ_CHUNK))
  return out
}

/**
 * The Listings contract's record, price and type of each item at one block, in the order given. An
 * item names the Listings contract that logged it; with none, the first deployment's answers. A
 * zero owner marks a floor item. An item whose `listings` call reverts gives null. A transport
 * failure throws. Each chunk costs two multicalls: record and price, then type.
 */
export async function readNftxListings(
  client: Pick<PublicClient, "multicall">,
  items: { collection: Address; tokenId: bigint; listings?: Address }[],
  block: bigint,
): Promise<(NftxListingRead | null)[]> {
  const out: (NftxListingRead | null)[] = []
  for (const chunk of chunks(items)) {
    const first = await client.multicall({
      allowFailure: true,
      blockNumber: block,
      contracts: chunk.flatMap((i) => [
        {
          address: i.listings ?? NFTX_LISTINGS,
          abi: nftxListingsAbi,
          functionName: "listings",
          args: [i.collection, i.tokenId],
        } as const,
        {
          address: i.listings ?? NFTX_LISTINGS,
          abi: nftxListingsAbi,
          functionName: "getListingPrice",
          args: [i.collection, i.tokenId],
        } as const,
      ]),
    })
    const records = chunk.map((_, n) => {
      const l = first[2 * n]
      const p = first[2 * n + 1]
      if (l?.status !== "success") return null
      const listing = l.result as {
        owner: Address
        created: number
        duration: number
        floorMultiple: number
      }
      const price = p?.status === "success" ? (p.result as readonly [boolean, bigint])[1] : null
      return { listing, price }
    })
    const typed = records.flatMap((r, n) => (r ? [{ n, listing: r.listing }] : []))
    const types =
      typed.length === 0
        ? []
        : await client.multicall({
            allowFailure: true,
            blockNumber: block,
            contracts: typed.map(
              ({ n, listing }) =>
                ({
                  address: chunk[n]?.listings ?? NFTX_LISTINGS,
                  abi: nftxListingsAbi,
                  functionName: "getListingType",
                  args: [chunk[n]?.collection as Address, listing],
                }) as const,
            ),
          })
    const typeAt = new Map<number, "liquid" | "dutch" | null>()
    typed.forEach(({ n }, k) => {
      const t = types[k]
      const v = t?.status === "success" ? Number(t.result) : -1
      typeAt.set(n, v === 0 ? "dutch" : v === 1 ? "liquid" : null)
    })
    records.forEach((r, n) => {
      out.push(
        r
          ? {
              owner: r.listing.owner.toLowerCase() as Address,
              created: Number(r.listing.created),
              duration: Number(r.listing.duration),
              floorMultiple: Number(r.listing.floorMultiple),
              priceTokens: r.price,
              type: typeAt.get(n) ?? null,
            }
          : null,
      )
    })
  }
  return out
}

/**
 * Pool size of each collection at a block: its Locker's NFT balance minus the items listed. Each
 * collection names the block it was created in, which picks its Locker and Listings contract.
 * Null for a collection whose balance or listing count reverts. A transport failure throws.
 */
export async function readNftxPoolCounts(
  client: Pick<PublicClient, "multicall">,
  collections: { collection: Address; createdBlock: bigint }[],
  block: bigint,
): Promise<(number | null)[]> {
  const out: (number | null)[] = []
  for (const chunk of chunks(collections)) {
    const res = await client.multicall({
      allowFailure: true,
      blockNumber: block,
      contracts: chunk.flatMap(({ collection: c, createdBlock }) => [
        {
          address: c,
          abi: nftxCollectionAbi,
          functionName: "balanceOf",
          args: [nftxDeploymentAt(createdBlock).locker],
        } as const,
        {
          address: nftxDeploymentAt(createdBlock).listings,
          abi: nftxListingsAbi,
          functionName: "listingCount",
          args: [c],
        } as const,
      ]),
    })
    chunk.forEach((_, n) => {
      const held = res[2 * n]
      const listed = res[2 * n + 1]
      out.push(
        held?.status === "success" && listed?.status === "success"
          ? Number((held.result as bigint) - (listed.result as bigint))
          : null,
      )
    })
  }
  return out
}

/** `owner()` of each contract at a block; null when it reverts. A transport failure throws. */
export async function readOwners(
  client: Pick<PublicClient, "multicall">,
  contracts: Address[],
  block: bigint,
): Promise<(Address | null)[]> {
  const out: (Address | null)[] = []
  for (const chunk of chunks(contracts)) {
    const res = await client.multicall({
      allowFailure: true,
      blockNumber: block,
      contracts: chunk.map(
        (c) => ({ address: c, abi: nftxCollectionAbi, functionName: "owner" }) as const,
      ),
    })
    for (const r of res)
      out.push(r.status === "success" ? ((r.result as Address).toLowerCase() as Address) : null)
  }
  return out
}

export type AuctionCheckpoint = {
  clearingPriceQ96: bigint
  currencyRaised: bigint
  totalCleared: bigint
  graduated: boolean
}

const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
])

/**
 * An auction's up-to-date state at a block. The auction advances its checkpoint lazily, so its
 * plain views are stale until someone calls `checkpoint()`. One Multicall3 `aggregate3` run as an
 * `eth_call` calls `checkpoint()` first and reads the views after it, in the same simulated
 * state. Null when `checkpoint()` reverts, as it does before the start and before the tokens
 * arrive. A transport failure throws.
 */
export async function readAuctionCheckpoint(
  client: Pick<PublicClient, "call">,
  auction: Address,
  block: bigint,
): Promise<AuctionCheckpoint | null> {
  const names = [
    "checkpoint",
    "currencyRaised",
    "totalCleared",
    "isGraduated",
    "clearingPrice",
  ] as const
  const data = encodeFunctionData({
    abi: multicallAbi,
    functionName: "aggregate3",
    args: [
      names.map((n) => ({
        target: auction,
        allowFailure: true,
        callData: encodeFunctionData({ abi: ccaAuctionAbi, functionName: n }),
      })),
    ],
  })
  let out: Hex | undefined
  try {
    out = (await client.call({ to: MULTICALL3, data, blockNumber: block })).data
  } catch (err) {
    if (isRevert(err)) return null
    throw err
  }
  if (!out || out === "0x") return null
  const results = decodeFunctionResult({
    abi: multicallAbi,
    functionName: "aggregate3",
    data: out,
  }) as readonly { success: boolean; returnData: Hex }[]
  if (results.length !== names.length || results.some((r) => !r.success)) return null
  const word = (i: number, name: (typeof names)[number]) =>
    decodeFunctionResult({
      abi: ccaAuctionAbi,
      functionName: name as "currencyRaised",
      data: (results[i] as { returnData: Hex }).returnData,
    })
  return {
    currencyRaised: word(1, "currencyRaised") as bigint,
    totalCleared: word(2, "totalCleared") as bigint,
    graduated: decodeFunctionResult({
      abi: ccaAuctionAbi,
      functionName: "isGraduated",
      data: (results[3] as { returnData: Hex }).returnData,
    }),
    clearingPriceQ96: word(4, "clearingPrice") as bigint,
  }
}

/** True for a call the node answered with a revert, false for a failure to reach it. */
function isRevert(err: unknown): boolean {
  for (let e = err as { cause?: unknown; name?: string; code?: number } | undefined; e; ) {
    if (e.name === "ExecutionRevertedError" || e.name === "ContractFunctionRevertedError")
      return true
    if (e.code === 3) return true
    e = e.cause as typeof e
  }
  return false
}
