import { type Address, decodeEventLog, type Hash, type Hex, parseAbi } from "viem"
import type { ChainLog } from "../types"
import {
  CHIMERA_FACTORY,
  NFT_TOPICS,
  SEADROP_V1,
  SEAPORT_1_5,
  SEAPORT_1_6,
  WETH_INK,
  ZERO_TOPIC,
} from "./constants"

const transferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
])
const transferSingleAbi = parseAbi([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
])
const transferBatchAbi = parseAbi([
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
])
const seadropAbi = parseAbi([
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
  "event PublicDropUpdated(address indexed nftContract, (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop)",
])
const orderFulfilledAbi = parseAbi([
  "struct SpentItem { uint8 itemType; address token; uint256 identifier; uint256 amount; }",
  "struct ReceivedItem { uint8 itemType; address token; uint256 identifier; uint256 amount; address recipient; }",
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, SpentItem[] offer, ReceivedItem[] consideration)",
])
const campaignCreatedAbi = parseAbi([
  "event CampaignCreated(uint256 indexed campaignId, bytes32 indexed poolId, address indexed creator, address token, address core, address collection, address rewards, address vault, uint256 chainId)",
])

const lower = (a: string) => a.toLowerCase() as Address
const topicAddress = (topic: Hex) => lower(`0x${topic.slice(26)}`)
const isTopics = (t: Hex[]): t is [Hex, ...Hex[]] => t.length > 0

/** Decodes with viem, or returns null for a log whose shape does not match the ABI. */
function tryDecode<A extends readonly unknown[]>(abi: A, log: ChainLog) {
  if (!isTopics(log.topics)) return null
  try {
    return decodeEventLog({ abi, data: log.data, topics: log.topics } as never) as unknown as {
      args: Record<string, never>
    }
  } catch {
    return null
  }
}

// ---- transfers ----

export type NftTransfer = {
  kind: "mint" | "burn"
  standard: "erc721" | "erc1155"
  contract: Address
  tokenId: bigint
  qty: bigint
  /** The recipient for a mint, the holder for a burn. */
  account: Address
}

/** Mints (from the zero address) and burns (to the zero address) of ERC-721 and ERC-1155 tokens. Anything else yields []. */
export function decodeNftTransfers(log: ChainLog): NftTransfer[] {
  const topic0 = log.topics[0]
  const contract = lower(log.address)
  if (topic0 === NFT_TOPICS.transfer) {
    // ERC-20 Transfer has the same topic0 but only three topics.
    if (log.topics.length !== 4) return []
    const d = tryDecode(transferAbi, log) as {
      args: { from: Address; to: Address; tokenId: bigint }
    } | null
    if (!d) return []
    return movement("erc721", contract, d.args.from, d.args.to, [[d.args.tokenId, 1n]])
  }
  if (topic0 === NFT_TOPICS.transferSingle) {
    const d = tryDecode(transferSingleAbi, log) as {
      args: { from: Address; to: Address; id: bigint; value: bigint }
    } | null
    if (!d) return []
    return movement("erc1155", contract, d.args.from, d.args.to, [[d.args.id, d.args.value]])
  }
  if (topic0 === NFT_TOPICS.transferBatch) {
    const d = tryDecode(transferBatchAbi, log) as {
      args: { from: Address; to: Address; ids: readonly bigint[]; values: readonly bigint[] }
    } | null
    if (!d || d.args.ids.length !== d.args.values.length) return []
    const perId = new Map<bigint, bigint>()
    d.args.ids.forEach((id, i) => {
      perId.set(id, (perId.get(id) ?? 0n) + d.args.values[i]!)
    })
    return movement("erc1155", contract, d.args.from, d.args.to, [...perId])
  }
  return []
}

function movement(
  standard: NftTransfer["standard"],
  contract: Address,
  from: Address,
  to: Address,
  items: (readonly [bigint, bigint])[],
): NftTransfer[] {
  const zero = lower(`0x${ZERO_TOPIC.slice(26)}`)
  const fromZero = lower(from) === zero
  const toZero = lower(to) === zero
  if (fromZero === toZero) return []
  return items
    .filter(([, qty]) => qty > 0n)
    .map(([tokenId, qty]) => ({
      kind: fromZero ? "mint" : "burn",
      standard,
      contract,
      tokenId,
      qty,
      account: lower(fromZero ? to : from),
    }))
}

// ---- SeaDrop ----

export type SeaDropMint = {
  kind: "seadropMint"
  contract: Address
  minter: Address
  feeRecipient: Address
  payer: Address
  qty: bigint
  unitPrice: bigint
  feeBps: number
  stage: number
}
export type PublicDrop = {
  kind: "publicDrop"
  contract: Address
  mintPrice: bigint
  startTime: number
  endTime: number
  maxPerWallet: number
}
/** Any other SeaDrop event. Its first topic is the collection. */
export type SeaDropConfig = { kind: "seadropConfig"; contract: Address; topic0: Hex }

/** A log from SeaDrop v1: a mint, a public drop update, or another configuration event. Null for logs from elsewhere. */
export function decodeSeaDropLog(log: ChainLog): SeaDropMint | PublicDrop | SeaDropConfig | null {
  if (lower(log.address) !== SEADROP_V1) return null
  const topic0 = log.topics[0]
  if (topic0 === NFT_TOPICS.seadropMint) {
    const d = tryDecode(seadropAbi, log) as {
      args: {
        nftContract: Address
        minter: Address
        feeRecipient: Address
        payer: Address
        quantityMinted: bigint
        unitMintPrice: bigint
        feeBps: bigint
        dropStageIndex: bigint
      }
    } | null
    if (!d) return null
    const a = d.args
    return {
      kind: "seadropMint",
      contract: lower(a.nftContract),
      minter: lower(a.minter),
      feeRecipient: lower(a.feeRecipient),
      payer: lower(a.payer),
      qty: a.quantityMinted,
      unitPrice: a.unitMintPrice,
      feeBps: Number(a.feeBps),
      stage: Number(a.dropStageIndex),
    }
  }
  if (topic0 === NFT_TOPICS.publicDropUpdated) {
    const d = tryDecode(seadropAbi, log) as {
      args: {
        nftContract: Address
        publicDrop: {
          mintPrice: bigint
          startTime: number
          endTime: number
          maxTotalMintableByWallet: number
        }
      }
    } | null
    if (!d) return null
    const p = d.args.publicDrop
    return {
      kind: "publicDrop",
      contract: lower(d.args.nftContract),
      mintPrice: p.mintPrice,
      startTime: Number(p.startTime),
      endTime: Number(p.endTime),
      maxPerWallet: Number(p.maxTotalMintableByWallet),
    }
  }
  const collection = log.topics[1]
  if (!topic0 || !collection) return null
  return { kind: "seadropConfig", contract: topicAddress(collection), topic0 }
}

// ---- Seaport ----

export type SeaportSale = {
  orderHash: Hash
  contract: Address
  standard: "erc721" | "erc1155"
  tokenId: bigint
  qty: bigint
  /**
   * The item's share of the order price in wei: the payments split evenly over the order's NFT items.
   * For an ERC-1155 item of several units this is the price of the whole line, not of one unit.
   */
  priceWei: bigint
  /** WETH when every payment is WETH, ETH otherwise. */
  currency: "ETH" | "WETH"
  buyer: Address
  seller: Address
}

const ITEM_NATIVE = 0
const ITEM_ERC20 = 1
const ITEM_ERC721 = 2
const ITEM_ERC1155 = 3

type Item = { itemType: number; token: Address; identifier: bigint; amount: bigint }

/**
 * One sale per NFT item of an `OrderFulfilled` log from Seaport 1.6 or 1.5. The price is the ETH and WETH
 * on the other side of the NFTs: the consideration of a listing, the offer of an accepted offer (its
 * consideration fees are carved out of that offer, so counting both would add them twice). An order
 * with NFTs on both sides, with no payment, or with a payment in any other token yields [].
 */
export function decodeOrderFulfilled(log: ChainLog): SeaportSale[] {
  const address = lower(log.address)
  if (log.topics[0] !== NFT_TOPICS.orderFulfilled) return []
  if (address !== SEAPORT_1_6 && address !== SEAPORT_1_5) return []
  const d = tryDecode(orderFulfilledAbi, log) as {
    args: {
      orderHash: Hash
      offerer: Address
      recipient: Address
      offer: readonly Item[]
      consideration: readonly (Item & { recipient: Address })[]
    }
  } | null
  if (!d) return []
  const { orderHash, offer, consideration } = d.args
  const isNft = (i: Item) => i.itemType === ITEM_ERC721 || i.itemType === ITEM_ERC1155
  const offerNfts = offer.filter(isNft)
  const considerationNfts = consideration.filter(isNft)
  if (offerNfts.length > 0 === considerationNfts.length > 0) return []

  const sellerIsOfferer = offerNfts.length > 0
  const nfts = sellerIsOfferer ? offerNfts : considerationNfts
  const payments: readonly Item[] = sellerIsOfferer ? consideration : offer
  let total = 0n
  let sawNative = false
  let paymentItems = 0
  for (const p of payments) {
    if (isNft(p)) continue
    if (p.itemType === ITEM_NATIVE) sawNative = true
    else if (p.itemType !== ITEM_ERC20 || lower(p.token) !== WETH_INK) return []
    total += p.amount
    paymentItems++
  }
  if (paymentItems === 0) return []

  const offerer = lower(d.args.offerer)
  const recipient = lower(d.args.recipient)
  const share = total / BigInt(nfts.length)
  return nfts.map((n) => ({
    orderHash: orderHash.toLowerCase() as Hash,
    contract: lower(n.token),
    standard: n.itemType === ITEM_ERC721 ? "erc721" : "erc1155",
    tokenId: n.identifier,
    qty: n.amount,
    priceWei: share,
    currency: sawNative ? "ETH" : "WETH",
    buyer: sellerIsOfferer ? recipient : offerer,
    seller: sellerIsOfferer ? offerer : recipient,
  }))
}

// ---- Chimera ----

export type ChimeraCampaign = {
  campaignId: bigint
  poolId: Hash
  creator: Address
  token: Address
  core: Address
  collection: Address
  rewards: Address
  vault: Address
}

/** A `CampaignCreated` log from the Chimera factory. Null for any other factory event. */
export function decodeChimeraCampaign(log: ChainLog): ChimeraCampaign | null {
  if (lower(log.address) !== CHIMERA_FACTORY) return null
  if (log.topics[0] !== NFT_TOPICS.campaignCreated) return null
  const d = tryDecode(campaignCreatedAbi, log) as {
    args: {
      campaignId: bigint
      poolId: Hash
      creator: Address
      token: Address
      core: Address
      collection: Address
      rewards: Address
      vault: Address
    }
  } | null
  if (!d) return null
  const a = d.args
  return {
    campaignId: a.campaignId,
    poolId: a.poolId.toLowerCase() as Hash,
    creator: lower(a.creator),
    token: lower(a.token),
    core: lower(a.core),
    collection: lower(a.collection),
    rewards: lower(a.rewards),
    vault: lower(a.vault),
  }
}
