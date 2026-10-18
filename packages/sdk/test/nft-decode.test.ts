import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
} from "viem"
import { describe, expect, it } from "vitest"
import {
  CHIMERA_FACTORY,
  CHIMERA_FACTORY_START_BLOCK,
  CHIMERA_HOOK,
  CHIMERA_ROUTER,
  type ChainLog,
  decodeChimeraCampaign,
  decodeNftTransfers,
  decodeOrderFulfilled,
  decodeSeaDropLog,
  NFT_SELECTORS,
  NFT_TOPICS,
  SEADROP_V1,
  SEAPORT_1_5,
  SEAPORT_1_6,
  WETH_INK,
  ZERO_TOPIC,
} from "../src/index"
import { loadChimeraCampaigns, loadNftFixture, loadSeaportRoles } from "./fixtures"

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const BURST = "0x165dcae7953657e23035c96503b2a5b51ddfa4cd"
const WIRED = "0x7c701c0148e0e965065aa05e008ac9341e6efc6c"
const WIRED_TOKEN = "0xc7d264d906b488ef6660005af5450c979f58006c"
const BLOOP = "0xe1b5b19214d27999fea3082e6a3d00a1d39fcac1"
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address
const BOB = "0x0000000000000000000000000000000000000b0b" as Address
const NFT_A = "0x00000000000000000000000000000000000000a1" as Address
const NFT_B = "0x00000000000000000000000000000000000000b2" as Address

/** viem types event topics as possibly null; these events have no null topics. */
const eventTopics = (p: Parameters<typeof encodeEventTopics>[0]) => encodeEventTopics(p) as Hex[]
const topicOf = (a: string) => pad(a as Hex)

function makeLog(
  over: Partial<ChainLog> & Pick<ChainLog, "address" | "topics" | "data">,
): ChainLog {
  return {
    blockNumber: 1n,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"22".repeat(32)}`,
    logIndex: 0,
    ...over,
  }
}

const ORDER_ABI = parseAbi([
  "struct SpentItem { uint8 itemType; address token; uint256 identifier; uint256 amount; }",
  "struct ReceivedItem { uint8 itemType; address token; uint256 identifier; uint256 amount; address recipient; }",
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, SpentItem[] offer, ReceivedItem[] consideration)",
])
type Spent = { itemType: number; token: Address; identifier: bigint; amount: bigint }
type Received = Spent & { recipient: Address }
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address

/** A synthetic OrderFulfilled log, encoded like the real ones in seaport-fills.json. */
function orderLog(o: {
  offerer?: Address
  recipient?: Address
  offer: Spent[]
  consideration: Received[]
  address?: Address
}): ChainLog {
  const orderHash = `0x${"ab".repeat(32)}` as Hex
  const offerer = o.offerer ?? ALICE
  const recipient = o.recipient ?? BOB
  const topics = eventTopics({
    abi: ORDER_ABI,
    eventName: "OrderFulfilled",
    args: { offerer, zone: ZERO_ADDR },
  })
  const data = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "address" },
      {
        type: "tuple[]",
        components: [
          { type: "uint8" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
        ],
      },
      {
        type: "tuple[]",
        components: [
          { type: "uint8" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "address" },
        ],
      },
    ],
    [
      orderHash,
      recipient,
      o.offer.map((i) => [i.itemType, i.token, i.identifier, i.amount] as const),
      o.consideration.map(
        (i) => [i.itemType, i.token, i.identifier, i.amount, i.recipient] as const,
      ),
    ],
  )
  return makeLog({ address: o.address ?? SEAPORT_1_6, topics, data })
}
const nft = (token: Address, id: bigint, amount = 1n, itemType = 2): Spent => ({
  itemType,
  token,
  identifier: id,
  amount,
})
const eth = (amount: bigint): Spent => ({
  itemType: 0,
  token: ZERO_ADDR,
  identifier: 0n,
  amount,
})
const weth = (amount: bigint): Spent => ({
  itemType: 1,
  token: WETH_INK,
  identifier: 0n,
  amount,
})
const to = (i: Spent, recipient: Address): Received => ({ ...i, recipient })

describe("constants", () => {
  it("topics are lowercase hashes", () => {
    for (const t of Object.values(NFT_TOPICS)) expect(t).toMatch(/^0x[0-9a-f]{64}$/)
    expect(ZERO_TOPIC).toBe(`0x${"0".repeat(64)}`)
  })

  it("MAX_SUPPLY selector equals the computed value", () => {
    expect(NFT_SELECTORS.MAX_SUPPLY).toBe(toFunctionSelector("MAX_SUPPLY()"))
    expect(NFT_SELECTORS.maxSupply).toBe(toFunctionSelector("maxSupply()"))
    expect(NFT_SELECTORS.getMintStats).toBe(toFunctionSelector("getMintStats(address)"))
    expect(NFT_SELECTORS).toEqual({
      getMintStats: "0x840e15d4",
      maxSupply: "0xd5abeb01",
      MAX_SUPPLY: "0x32cb6b0c",
    })
  })

  it("exports Chimera constants", () => {
    expect(CHIMERA_FACTORY_START_BLOCK).toBe(57_096_880n)
    expect(CHIMERA_HOOK).toBe("0x2eebd90bf253a27961624762f73eee1409c52dcc")
    expect(CHIMERA_ROUTER).toBe("0x16bb706af367386f2cdf92a4bb673dcdb5fe1886")
    expect(SEADROP_V1).toBe("0x00005ea00ac477b1030ce78506496e8c2de24bf5")
    expect(SEAPORT_1_5).toBe("0x00000000000000adc04c56bf30ac9d3c0aaf14dc")
  })
})

describe("decodeChimeraCampaign", () => {
  const logs = loadChimeraCampaigns()
  const campaigns = logs.map((l) => decodeChimeraCampaign(l))

  it("chimera campaign 0 decodes collection 0x7c701c0148e0e965065aa05e008ac9341e6efc6c (WIRED) and token 0xc7d264d906b488ef6660005af5450c979f58006c", () => {
    const c = campaigns.find((x) => x?.campaignId === 0n)
    expect(c).toMatchObject({ collection: WIRED, token: WIRED_TOKEN })
    for (const field of ["creator", "core", "rewards", "vault"] as const)
      expect(c?.[field]).toMatch(/^0x[0-9a-f]{40}$/)
    expect(c?.poolId).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("chimera campaign 1 is BLOOP, collection 0xe1b5b19214d27999fea3082e6a3d00a1d39fcac1", () => {
    expect(campaigns.find((x) => x?.campaignId === 1n)?.collection).toBe(BLOOP)
  })

  it("non-campaign factory log yields null", () => {
    const other = logs.filter((l) => l.topics[0] !== NFT_TOPICS.campaignCreated)
    expect(other).toHaveLength(1)
    expect(decodeChimeraCampaign(other[0]!)).toBeNull()
  })

  it("holds five campaigns, numbered from zero", () => {
    const found = campaigns.filter((c) => c !== null).map((c) => c.campaignId)
    expect(found).toEqual([0n, 1n, 2n, 3n, 4n])
  })

  it("ignores a CampaignCreated topic from another address", () => {
    const l = logs.find((x) => x.topics[0] === NFT_TOPICS.campaignCreated)!
    expect(decodeChimeraCampaign({ ...l, address: ALICE })).toBeNull()
    expect(l.address).toBe(CHIMERA_FACTORY)
  })
})

describe("decodeNftTransfers", () => {
  it("hornet: 2,222 mint transfers, erc721", () => {
    const out = loadNftFixture("hornet-mints")
      .filter((l) => l.address === HORNET)
      .flatMap(decodeNftTransfers)
    expect(out).toHaveLength(2_222)
    for (const t of out) {
      expect(t).toMatchObject({ kind: "mint", standard: "erc721", contract: HORNET, qty: 1n })
      expect(t.account).toMatch(/^0x[0-9a-f]{40}$/)
    }
    expect(new Set(out.map((t) => t.tokenId)).size).toBe(2_222)
  })

  it("burst: every mint transfer decodes, none assumed to match SeaDropMint one to one", () => {
    const logs = loadNftFixture("burst-mints")
    const out = logs.filter((l) => l.address === BURST).flatMap(decodeNftTransfers)
    expect(out).toHaveLength(3_000)
    expect(out.every((t) => t.kind === "mint")).toBe(true)
  })

  it("erc1155 batch: quantities per id summed", () => {
    const batch = loadNftFixture("erc1155-mints").find(
      (l) => l.topics[0] === NFT_TOPICS.transferBatch,
    )!
    const out = decodeNftTransfers(batch)
    expect(out.length).toBeGreaterThan(0)
    for (const t of out) expect(t).toMatchObject({ kind: "mint", standard: "erc1155" })
    expect(new Set(out.map((t) => t.tokenId)).size).toBe(out.length)
  })

  it("erc1155 batch with a repeated id sums its quantities", () => {
    const topics = eventTopics({
      abi: parseAbi([
        "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
      ]),
      eventName: "TransferBatch",
      args: { operator: BOB, from: ZERO_ADDR, to: ALICE },
    })
    const data = encodeAbiParameters(
      [{ type: "uint256[]" }, { type: "uint256[]" }],
      [
        [7n, 8n, 7n],
        [2n, 5n, 3n],
      ],
    )
    const out = decodeNftTransfers(makeLog({ address: NFT_A, topics, data }))
    expect(out).toEqual([
      { kind: "mint", standard: "erc1155", contract: NFT_A, tokenId: 7n, qty: 5n, account: ALICE },
      { kind: "mint", standard: "erc1155", contract: NFT_A, tokenId: 8n, qty: 5n, account: ALICE },
    ])
  })

  it("erc1155 single mint decodes id and quantity", () => {
    const single = loadNftFixture("erc1155-mints").find(
      (l) => l.topics[0] === NFT_TOPICS.transferSingle,
    )!
    const out = decodeNftTransfers(single)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: "mint", standard: "erc1155", contract: single.address })
    expect(out[0]!.qty).toBe(BigInt(`0x${single.data.slice(66)}`))
    expect(out[0]!.tokenId).toBe(BigInt(`0x${single.data.slice(2, 66)}`))
  })

  it("erc-20 transfer from zero yields []", () => {
    const log = makeLog({
      address: NFT_A,
      topics: [NFT_TOPICS.transfer, ZERO_TOPIC, topicOf(ALICE)],
      data: toHex(1_000n, { size: 32 }),
    })
    expect(decodeNftTransfers(log)).toEqual([])
  })

  it("wired burns decode as burn", () => {
    const logs = loadNftFixture("wired-transfers").filter((l) => l.address === WIRED)
    const burned = logs.filter((l) => l.topics[2] === ZERO_TOPIC)
    expect(burned.length).toBeGreaterThan(0)
    for (const l of burned) {
      const [t] = decodeNftTransfers(l)
      expect(t).toMatchObject({
        kind: "burn",
        standard: "erc721",
        contract: WIRED,
        qty: 1n,
        account: `0x${l.topics[1]!.slice(26)}`,
      })
    }
  })

  it("a transfer between two wallets yields []", () => {
    const log = makeLog({
      address: NFT_A,
      topics: [NFT_TOPICS.transfer, topicOf(ALICE), topicOf(BOB), toHex(5n, { size: 32 })],
      data: "0x",
    })
    expect(decodeNftTransfers(log)).toEqual([])
  })

  it("an erc1155 transfer between two wallets yields []", () => {
    const log = makeLog({
      address: NFT_A,
      topics: [NFT_TOPICS.transferSingle, topicOf(BOB), topicOf(ALICE), topicOf(BOB)],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 1n]),
    })
    expect(decodeNftTransfers(log)).toEqual([])
  })

  it("an erc1155 burn decodes as burn with the holder", () => {
    const log = makeLog({
      address: NFT_A,
      topics: [NFT_TOPICS.transferSingle, topicOf(BOB), topicOf(ALICE), ZERO_TOPIC],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [9n, 4n]),
    })
    expect(decodeNftTransfers(log)).toEqual([
      { kind: "burn", standard: "erc1155", contract: NFT_A, tokenId: 9n, qty: 4n, account: ALICE },
    ])
  })

  it("a malformed log yields [] instead of throwing", () => {
    const log = makeLog({
      address: NFT_A,
      topics: [NFT_TOPICS.transferBatch, topicOf(BOB), ZERO_TOPIC, topicOf(ALICE)],
      data: "0x1234",
    })
    expect(decodeNftTransfers(log)).toEqual([])
  })

  it("an unrelated log yields []", () => {
    expect(
      decodeNftTransfers(makeLog({ address: NFT_A, topics: [ZERO_TOPIC], data: "0x" })),
    ).toEqual([])
  })
})

describe("decodeSeaDropLog", () => {
  const hornet = loadNftFixture("hornet-mints").filter((l) => l.address === SEADROP_V1)

  it("SeaDropMint fields: stage 0 public, unitPrice 0.0005 ETH on a Hornet public mint", () => {
    const decoded = hornet
      .filter((l) => l.topics[0] === NFT_TOPICS.seadropMint)
      .map((l) => decodeSeaDropLog(l))
    expect(decoded.length).toBeGreaterThan(0)
    // Hornet also has allowlist stages 1 to 3, which are free or cheaper.
    expect(new Set(decoded.map((d) => (d?.kind === "seadropMint" ? d.stage : -1)))).toEqual(
      new Set([0, 1, 2, 3]),
    )
    const first = decoded.find((d) => d?.kind === "seadropMint" && d.stage === 0)
    expect(first).toMatchObject({
      kind: "seadropMint",
      contract: HORNET,
      stage: 0,
      unitPrice: 500_000_000_000_000n,
    })
    if (first?.kind !== "seadropMint") throw new Error("not a mint")
    for (const f of [first.minter, first.feeRecipient, first.payer])
      expect(f).toMatch(/^0x[0-9a-f]{40}$/)
    expect(first.qty).toBeGreaterThan(0n)
    expect(typeof first.feeBps).toBe("number")
  })

  it("Hornet SeaDropMint quantities add up to its mint transfers", () => {
    const qty = hornet
      .filter((l) => l.topics[0] === NFT_TOPICS.seadropMint)
      .map((l) => decodeSeaDropLog(l))
      .reduce((n, d) => n + (d?.kind === "seadropMint" ? d.qty : 0n), 0n)
    expect(qty).toBe(2_222n)
  })

  it("PublicDropUpdated decodes start and end", () => {
    const logs = [...hornet, ...loadNftFixture("inkverse-mints")].filter(
      (l) => l.address === SEADROP_V1 && l.topics[0] === NFT_TOPICS.publicDropUpdated,
    )
    expect(logs.length).toBeGreaterThan(0)
    const d = decodeSeaDropLog(logs[0]!)
    if (d?.kind !== "publicDrop") throw new Error("not a public drop")
    expect(d.contract).toMatch(/^0x[0-9a-f]{40}$/)
    expect(d).toMatchObject({
      contract: HORNET,
      mintPrice: 500_000_000_000_000n,
      startTime: 1_788_706_800,
      endTime: 1_789_311_600,
      maxPerWallet: 10,
    })
  })

  it("PublicDropUpdated round-trips a synthetic log", () => {
    const abi = parseAbi([
      "event PublicDropUpdated(address indexed nftContract, (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop)",
    ])
    const topics = eventTopics({
      abi,
      eventName: "PublicDropUpdated",
      args: { nftContract: NFT_A },
    })
    expect(topics[0]).toBe(NFT_TOPICS.publicDropUpdated)
    const data = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { type: "uint80" },
            { type: "uint48" },
            { type: "uint48" },
            { type: "uint16" },
            { type: "uint16" },
            { type: "bool" },
          ],
        },
      ],
      [[123n, 1_800_000_000, 1_800_086_400, 10, 250, true]],
    )
    expect(decodeSeaDropLog(makeLog({ address: SEADROP_V1, topics, data }))).toEqual({
      kind: "publicDrop",
      contract: NFT_A,
      mintPrice: 123n,
      startTime: 1_800_000_000,
      endTime: 1_800_086_400,
      maxPerWallet: 10,
    })
  })

  it("other SeaDrop events decode as config with the collection", () => {
    const others = hornet.filter(
      (l) => l.topics[0] !== NFT_TOPICS.seadropMint && l.topics[0] !== NFT_TOPICS.publicDropUpdated,
    )
    expect(others.length).toBeGreaterThan(0)
    for (const l of others)
      expect(decodeSeaDropLog(l)).toEqual({
        kind: "seadropConfig",
        contract: HORNET,
        topic0: l.topics[0],
      })
  })

  it("logs from other addresses yield null", () => {
    const l = hornet.find((x) => x.topics[0] === NFT_TOPICS.seadropMint)!
    expect(decodeSeaDropLog({ ...l, address: ALICE })).toBeNull()
  })
})

describe("decodeOrderFulfilled", () => {
  const fills = loadNftFixture("seaport-fills")
  const roles = loadSeaportRoles()
  const inTx = (tx: string) => fills.filter((l) => l.transactionHash === tx)

  it("sweep tx: 50 sales, one buyer", () => {
    const sales = inTx(roles.sweep).flatMap(decodeOrderFulfilled)
    expect(sales).toHaveLength(50)
    expect(new Set(sales.map((s) => s.buyer)).size).toBe(1)
    for (const s of sales) {
      expect(s).toMatchObject({ standard: "erc721", qty: 1n, currency: "ETH" })
      expect(s.priceWei).toBeGreaterThan(0n)
      expect(s.seller).toMatch(/^0x[0-9a-f]{40}$/)
      expect(s.contract).toMatch(/^0x[0-9a-f]{40}$/)
      expect(s.orderHash).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })

  it("listing fill: seller is the offerer, price is the whole consideration", () => {
    const [s] = inTx(roles.listing).flatMap(decodeOrderFulfilled)
    expect(s).toMatchObject({
      seller: "0xce79452a89d1c52ebac3779c68dcced961f43f56",
      buyer: "0x1f00b89f92990b8b3a1708a59e11397dc5af0364",
      contract: "0x1caf206358ccf6f4afb2ccc0fdbd275cdc8ed106",
      tokenId: 945n,
      priceWei: 50_255_570_000_000_000n + 529_006_000_000_000n + 2_116_024_000_000_000n,
      currency: "ETH",
    })
  })

  it("offer fill: buyer is the offerer", () => {
    const [s] = inTx(roles.offer).flatMap(decodeOrderFulfilled)
    expect(s).toMatchObject({
      buyer: "0x5fd1abd3c8f8959dda65fbad5579f3b4ec413971",
      seller: "0xecde50a71862153d1b873cecda34ad5d7f619c17",
      contract: "0x17c700f1e302069ee01249aa4c2313371f993b57",
      tokenId: 33_608n,
      currency: "WETH",
    })
    // The fees in the consideration are paid out of the offered WETH, so they are not added again.
    expect(s?.priceWei).toBe(500_000_000_000_000n)
  })

  it("multi-item order splits price evenly", () => {
    const log = orderLog({
      offer: [nft(NFT_A, 1n), nft(NFT_A, 2n)],
      consideration: [to(eth(900n), ALICE), to(eth(100n), BOB)],
    })
    const sales = decodeOrderFulfilled(log)
    expect(sales.map((s) => [s.tokenId, s.priceWei])).toEqual([
      [1n, 500n],
      [2n, 500n],
    ])
    for (const s of sales)
      expect(s).toMatchObject({
        contract: NFT_A,
        standard: "erc721",
        qty: 1n,
        currency: "ETH",
        seller: ALICE,
        buyer: BOB,
      })
  })

  it("an erc1155 item carries its quantity", () => {
    const [s] = decodeOrderFulfilled(
      orderLog({ offer: [nft(NFT_B, 3n, 4n, 3)], consideration: [to(eth(400n), ALICE)] }),
    )
    expect(s).toMatchObject({ standard: "erc1155", qty: 4n, tokenId: 3n, priceWei: 400n })
  })

  it("sums ETH and WETH payments", () => {
    const [s] = decodeOrderFulfilled(
      orderLog({
        offer: [nft(NFT_A, 1n)],
        consideration: [to(weth(30n), ALICE), to(weth(70n), BOB)],
      }),
    )
    expect(s).toMatchObject({ priceWei: 100n, currency: "WETH" })
  })

  it("unsupported currency yields []", () => {
    for (const l of inTx(roles.unsupportedErc20!)) expect(decodeOrderFulfilled(l)).toEqual([])
    const other = { ...weth(10n), token: NFT_B }
    expect(
      decodeOrderFulfilled(
        orderLog({ offer: [nft(NFT_A, 1n)], consideration: [to(other, ALICE)] }),
      ),
    ).toEqual([])
  })

  it("an order with no payment or with NFTs on both sides yields []", () => {
    expect(decodeOrderFulfilled(orderLog({ offer: [nft(NFT_A, 1n)], consideration: [] }))).toEqual(
      [],
    )
    expect(
      decodeOrderFulfilled(
        orderLog({ offer: [nft(NFT_A, 1n)], consideration: [to(nft(NFT_B, 2n), ALICE)] }),
      ),
    ).toEqual([])
  })

  it("decodes Seaport 1.5 and ignores other addresses", () => {
    const base = {
      offer: [nft(NFT_A, 1n)],
      consideration: [to(eth(10n), ALICE)],
    }
    expect(decodeOrderFulfilled(orderLog({ ...base, address: SEAPORT_1_5 }))).toHaveLength(1)
    expect(decodeOrderFulfilled(orderLog({ ...base, address: NFT_B }))).toEqual([])
  })

  it("every recorded fill decodes to lowercase addresses", () => {
    for (const l of fills)
      for (const s of decodeOrderFulfilled(l))
        for (const a of [s.contract, s.buyer, s.seller]) expect(a).toBe(a.toLowerCase())
  })
})
