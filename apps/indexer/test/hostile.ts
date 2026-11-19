import type { Sql } from "@ink-indexer/db"
import {
  CCA_FACTORY,
  type ChainLog,
  ccaConfigParameter,
  ccaEventsAbi,
  decodeChimeraCampaign,
  NATIVE_QUOTE_ASSET,
  NFTX_FLETH,
  NFTX_HOOK,
  NFTX_LISTINGS,
  NFTX_LOCKER,
  nftxEventsAbi,
  SEADROP_V1,
  SEAPORT_1_6,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import {
  type Abi,
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  InvalidInputRpcError,
  parseAbi,
} from "viem"
import { expect } from "vitest"
import { loadChimeraCampaigns, loadHookitFixture } from "../../../packages/sdk/test/fixtures"
import type { Logger } from "../src/log"
import { hookitSource } from "../src/sources/hookit/index"
import { inkfunSource } from "../src/sources/inkfun/index"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { nftSource } from "../src/sources/nft/index"
import { nftxSource } from "../src/sources/nftx/index"
import { type PoolEntry, PoolRegistry } from "../src/sources/pools"
import type { Source } from "../src/sources/source"
import { tsunamiSource } from "../src/sources/tsunami/index"
import { v4Source } from "../src/sources/v4/index"
import { FakeChain } from "./fake-chain"
import { addFixture as addHookit } from "./hookit-scenario"
import { inkfunLaunch } from "./inkfun-scenario"
import { launch } from "./scenario"
import { addFixture as addTsunami, seedToken } from "./tsunami-scenario"
import { entry, swap } from "./v4-scenario"

/** Values an attacker controls on chain or through an API, and that a source must store or skip without failing the batch. */
export const MAX_UINT256 = 2n ** 256n - 1n
export const NUL_TEXT = "name\u0000with\u0000nul"
export const LONE_SURROGATE_TEXT = "half\ud800pair"
export const TEN_KB = "x".repeat(10 * 1024)
/** A pool list far past what one eth_getLogs request carries. */
export const LONG_POOL_COUNT = 400

/** A JSON-RPC error response that is neither a revert nor a transport failure. */
export const oddRpcError = () =>
  new InvalidInputRpcError(new Error("invalid opcode: INVALID") as never)

/** A metadata document whose every field is hostile. */
export const HOSTILE_DOC = {
  name: NUL_TEXT,
  description: `${NUL_TEXT}${LONE_SURROGATE_TEXT}${TEN_KB}`,
  image: `https://example.test/${NUL_TEXT}.png`,
  socials: { telegram: TEN_KB, x: NUL_TEXT, website: LONE_SURROGATE_TEXT },
  attributes: [{ trait_type: NUL_TEXT, value: TEN_KB }],
}
const hostileFetch = (async () => Response.json(HOSTILE_DOC)) as unknown as typeof fetch
const GATEWAY = "https://ipfs.test"

export type HostileEnv = { sql: Sql; logger: Logger }
/** A chain holding the hostile logs and reads, the sources that read it, and the block before the first log. */
export type HostileScenario = {
  chain: FakeChain
  sources: Source[]
  from: bigint
  /** What the sources must have stored once the batch commits; the hostile parts are cleaned or skipped, the rest is kept. */
  check?: (sql: Sql) => Promise<void>
}

/**
 * Every source's hostile scenario. A new source adds one line here and gets the same checks:
 * the batch commits and the cursor reaches the head.
 */
export const HOSTILE_SOURCES: Record<string, (env: HostileEnv) => Promise<HostileScenario>> = {
  nft: nftScenario,
  nftx: nftxScenario,
  inkypump: inkypumpScenario,
  inkfun: inkfunScenario,
  tsunami: tsunamiScenario,
  hookit: hookitScenario,
  v4: v4Scenario,
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address
const BOB = "0x0000000000000000000000000000000000000b0b" as Address
const HOSTILE_NFT = "0x00000000000000000000000000000000000000a1" as Address
const B = 58_000_000n

const meta = (logIndex: number, over: Partial<ChainLog> = {}) => ({
  blockNumber: B,
  blockHash: `0x${"11".repeat(32)}` as Hex,
  transactionHash: `0x${(0xabc000 + logIndex).toString(16).padStart(64, "0")}` as Hex,
  logIndex,
  ...over,
})

/** An ERC-1155 TransferBatch from the zero address with nine ids of 2^256 - 1 units each. */
export function overflowingBatch(logIndex = 0): ChainLog {
  const topics = encodeEventTopics({
    abi: parseAbi([
      "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
    ]),
    eventName: "TransferBatch",
    args: { operator: BOB, from: ZERO, to: ALICE },
  }) as Hex[]
  const data = encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "uint256[]" }],
    [Array(9).fill(1n), Array(9).fill(MAX_UINT256)],
  )
  return { address: HOSTILE_NFT, topics, data, ...meta(logIndex) }
}

const ORDER_ABI = parseAbi([
  "struct SpentItem { uint8 itemType; address token; uint256 identifier; uint256 amount; }",
  "struct ReceivedItem { uint8 itemType; address token; uint256 identifier; uint256 amount; address recipient; }",
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, SpentItem[] offer, ReceivedItem[] consideration)",
])

/** A Seaport order that offers one ERC-1155 token on nine lines of 2^256 - 1 units, paid with `eth` wei. */
export function overflowingOrder(logIndex = 1, eth = 1n): ChainLog {
  const topics = encodeEventTopics({
    abi: ORDER_ABI,
    eventName: "OrderFulfilled",
    args: { offerer: ALICE, zone: ZERO },
  }) as Hex[]
  const line = [3, HOSTILE_NFT, 1n, MAX_UINT256] as const
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
    [`0x${"ab".repeat(32)}`, BOB, Array(9).fill(line), [[0, ZERO, 0n, eth, ALICE] as const]],
  )
  return { address: SEAPORT_1_6, topics, data, ...meta(logIndex) }
}

/** A SeaDropMint for a contract that answers `getMintStats` with an odd JSON-RPC error. */
function seadropMint(logIndex: number): ChainLog {
  const abi = parseAbi([
    "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
  ])
  const topics = encodeEventTopics({
    abi,
    eventName: "SeaDropMint",
    args: { nftContract: HOSTILE_NFT, minter: ALICE, feeRecipient: BOB },
  }) as Hex[]
  const data = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [ALICE, 1n, MAX_UINT256, 500n, 0n],
  )
  return { address: SEADROP_V1, topics, data, ...meta(logIndex) }
}

async function nftScenario({ sql, logger }: HostileEnv): Promise<HostileScenario> {
  const chain = new FakeChain(B + 20n)
  chain.add(overflowingBatch(0))
  chain.add(overflowingOrder(1, MAX_UINT256))
  chain.add(seadropMint(2))
  chain.mintStats.set(HOSTILE_NFT, () => {
    throw oddRpcError()
  })
  chain.totalSupplyAt.set(HOSTILE_NFT, () => {
    throw oddRpcError()
  })
  // A Chimera launch whose token has a hostile name.
  const campaign = loadChimeraCampaigns().find((l) => decodeChimeraCampaign(l) !== null)!
  chain.add({ ...campaign, blockNumber: B + 1n })
  chain.erc20Names.set(decodeChimeraCampaign(campaign)!.token, {
    name: NUL_TEXT,
    symbol: LONE_SURROGATE_TEXT,
  })
  return {
    chain,
    sources: [nftSource({ sql, chain, logger })],
    from: B - 1n,
    check: async (db) => {
      expect(await db`select count(*)::int as n from indexer.nft_mints`).toEqual([{ n: 0 }])
      expect(await db`select count(*)::int as n from indexer.nft_sales`).toEqual([{ n: 0 }])
      expect(
        await db`select payload->>'tokenName' as name, payload->>'tokenSymbol' as symbol from indexer.events where type = 'nft.launch'`,
      ).toEqual([{ name: "namewithnul", symbol: "half\ufffdpair" }])
    },
  }
}

async function inkypumpScenario({ sql, logger }: HostileEnv): Promise<HostileScenario> {
  const chain = new FakeChain(B + 20n)
  const pools = new PoolRegistry()
  launch(chain, {
    n: 1,
    block: B,
    name: NUL_TEXT,
    ticker: LONE_SURROGATE_TEXT,
    description: TEN_KB,
  })
  return {
    chain,
    sources: [inkypumpSource({ sql, chain, logger, pools })],
    from: B - 1n,
    check: async (db) => {
      expect(await db`select name, ticker from indexer.tokens`).toEqual([
        { name: "namewithnul", ticker: "half\ufffdpair" },
      ])
    },
  }
}

async function inkfunScenario({ sql, logger }: HostileEnv): Promise<HostileScenario> {
  const chain = new FakeChain(B + 20n)
  const pools = new PoolRegistry()
  inkfunLaunch(chain, { n: 1, block: B, name: NUL_TEXT })
  return {
    chain,
    sources: [
      inkypumpSource({ sql, chain, logger, pools }),
      inkfunSource({ sql, chain, logger, pools, ipfs: { gateway: GATEWAY, fetch: hostileFetch } }),
    ],
    from: B - 1n,
  }
}

async function tsunamiScenario({ sql, logger }: HostileEnv): Promise<HostileScenario> {
  const chain = new FakeChain(60_000_000n)
  const pools = new PoolRegistry()
  const f = addTsunami(chain, "tsunami-launch-riptide")
  for (const [token] of chain.supplies) chain.supplies.set(token, MAX_UINT256)
  return {
    chain,
    sources: [
      inkypumpSource({ sql, chain, logger, pools }),
      tsunamiSource({ sql, chain, logger, pools, ipfs: { gateway: GATEWAY, fetch: hostileFetch } }),
    ],
    from: f.blockNumber - 1n,
  }
}

async function hookitScenario({ sql, logger }: HostileEnv): Promise<HostileScenario> {
  const chain = new FakeChain(61_000_000n)
  const pools = new PoolRegistry()
  const f = loadHookitFixture("hookit-hkt-launch")
  addHookit(chain, f)
  for (const t of f.tokens) {
    chain.supplies.set(t.token, MAX_UINT256)
    chain.metadataUris.set(t.token, t.metadataURI)
    chain.erc20Names.set(t.token, { name: NUL_TEXT, symbol: LONE_SURROGATE_TEXT })
  }
  return {
    chain,
    sources: [
      inkypumpSource({ sql, chain, logger, pools }),
      hookitSource({ sql, chain, logger, pools, ipfs: { gateway: GATEWAY, fetch: hostileFetch } }),
      v4Source({ sql, chain, logger, pools }),
    ],
    from: f.blockNumber - 1n,
  }
}

async function v4Scenario({ sql, logger }: HostileEnv): Promise<HostileScenario> {
  const chain = new FakeChain(B + 20n)
  const pools = new PoolRegistry()
  // A long list of registered pools, and one whose token reports the largest possible supply.
  for (let i = 1; i <= LONG_POOL_COUNT; i++) {
    const p: PoolEntry = {
      ...entry(i),
      poolManager: UNISWAP_V4_POOL_MANAGER,
      quoteAsset: NATIVE_QUOTE_ASSET,
    }
    pools.add(p, 10n ** 27n)
  }
  chain.supplies.set(entry(1).token, MAX_UINT256)
  await seedToken(sql, { curve: entry(1).poolId.slice(0, 42) as Address, token: entry(1).token })
  swap(chain, { block: B, sqrtPriceX96: 2n ** 160n - 1n })
  return {
    chain,
    sources: [v4Source({ sql, chain, logger, pools })],
    from: B - 1n,
  }
}

type EventsAbi = Abi
/** A log of an event in `abi`, with its indexed arguments as topics and the rest as data. */
function eventLog(
  abi: EventsAbi,
  name: string,
  args: Record<string, unknown>,
  address: Address,
  logIndex: number,
  block = B,
): ChainLog {
  const item = abi.find((i) => i.type === "event" && i.name === name) as {
    inputs: readonly { name: string; indexed?: boolean }[]
  }
  const topics = encodeEventTopics({
    abi,
    eventName: name,
    args: Object.fromEntries(
      item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]]),
    ),
  }) as Hex[]
  const plain = item.inputs.filter((i) => !i.indexed)
  const data = encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never)
  return { address, topics, data, ...meta(logIndex, { blockNumber: block }) }
}

const poolKey = (hooks: Address, currency1: Address) =>
  encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [NFTX_FLETH, currency1, 0x800000, 60, hooks],
  )

/** The most input one NFTX log can carry: a name that is all noise, an id list of 10,000, a config that does not decode. */
async function nftxScenario({ sql, logger }: HostileEnv): Promise<HostileScenario> {
  const chain = new FakeChain(B + 20n)
  const nft = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
  const [noisy, huge, odd, listed] = [nft(0xc1), nft(0xc2), nft(0xc3), nft(0xc4)]
  const tokenOf = (n: number) => nft(0xf00 + n)
  const created = (collection: Address, i: number, name: string, symbol: string, n: number) =>
    eventLog(
      nftxEventsAbi as Abi,
      "CollectionCreated",
      {
        _collection: collection,
        _collectionToken: tokenOf(n),
        _name: name,
        _symbol: symbol,
        _creator: ALICE,
      },
      NFTX_LOCKER,
      i,
    )
  const initialized = (
    collection: Address,
    i: number,
    key: Hex,
    sqrt: bigint,
    ids: bigint[] = [1n],
  ) =>
    eventLog(
      nftxEventsAbi as Abi,
      "CollectionInitialized",
      {
        _collection: collection,
        _poolKey: key,
        _tokenIds: ids,
        _sqrtPriceX96: sqrt,
        _sender: ALICE,
      },
      NFTX_LOCKER,
      i,
    )
  const state = (collection: Address, i: number, sqrt: bigint, block = B) =>
    eventLog(
      nftxEventsAbi as Abi,
      "PoolStateUpdated",
      {
        _collection: collection,
        _sqrtPriceX96: sqrt,
        _tick: 0,
        _protocolFee: 0,
        _swapFee: 9000,
        _liquidity: 1n,
      },
      NFTX_HOOK,
      i,
      block,
    )

  // Names and symbols: NUL bytes, a lone surrogate, 10 KB.
  chain.add(created(noisy, 0, NUL_TEXT, LONE_SURROGATE_TEXT, 1))
  chain.add(created(huge, 1, TEN_KB, TEN_KB, 2))
  chain.add(created(odd, 2, "Odd pool", "ODD", 3))
  chain.add(created(listed, 3, "Listed", "LST", 4))
  // Pool keys: a valid one at the extreme prices, one 96 bytes long, one with another hook.
  chain.add(initialized(noisy, 4, poolKey(NFTX_HOOK, tokenOf(1)), 0n))
  chain.add(initialized(huge, 5, `0x${"00".repeat(96)}`, 1n))
  chain.add(initialized(odd, 6, poolKey(ALICE, tokenOf(3)), 2n ** 160n - 1n))
  chain.add(initialized(listed, 7, poolKey(NFTX_HOOK, tokenOf(4)), 2n ** 160n - 1n))
  for (const [i, sqrt] of [0n, 1n, 2n ** 160n - 1n].entries())
    chain.add(state(noisy, 8 + i, sqrt, B + 1n))
  // A Listings fill of 10,000 ids, none of which the Listings contract can answer for.
  const ids = Array.from({ length: 10_000 }, (_, i) => BigInt(i))
  chain.add(
    eventLog(
      nftxEventsAbi as Abi,
      "ListingsFilled",
      { _collection: listed, _tokenIds: [ids], _recipient: ALICE },
      NFTX_LISTINGS,
      0,
      B + 2n,
    ),
  )
  // Auction logs: a config that does not decode, one with 200 KB of step data, and events from
  // addresses the factory never created.
  const config = {
    currency: ZERO,
    tokensRecipient: ALICE,
    fundsRecipient: BOB,
    startBlock: B + 5n,
    endBlock: B + 50n,
    claimBlock: B + 60n,
    tickSpacing: 1n,
    validationHook: ZERO,
    floorPrice: 1n,
    requiredCurrencyRaised: 0n,
    auctionStepsData: `0x${"ab".repeat(200_000)}` as Hex,
  }
  const auction = (a: Address, token: Address, i: number, configData: Hex) =>
    eventLog(
      ccaEventsAbi as Abi,
      "AuctionCreated",
      { auction: a, token, amount: 10n ** 18n, configData },
      CCA_FACTORY,
      i,
      B + 3n,
    )
  chain.add(auction(nft(0xa1), tokenOf(1), 0, "0x1234"))
  chain.add(auction(nft(0xa2), tokenOf(1), 1, encodeAbiParameters([ccaConfigParameter], [config])))
  for (const [i, a] of [nft(0xbad1), nft(0xbad2)].entries()) {
    chain.add(
      eventLog(ccaEventsAbi as Abi, "TokensReceived", { totalSupply: 1n }, a, 2 + i, B + 4n),
    )
    chain.add(
      eventLog(
        ccaEventsAbi as Abi,
        "BidSubmitted",
        { id: 1n, owner: ALICE, priceQ96: MAX_UINT256, amount: 1n },
        a,
        4 + i,
        B + 4n,
      ),
    )
  }
  chain.add(
    eventLog(
      nftxEventsAbi as Abi,
      "NFTBoughtWithETH",
      { collection: noisy, nftCount: 1n, ethSpent: MAX_UINT256, buyer: ALICE },
      ALICE,
      6,
      B + 4n,
    ),
  )
  for (let n = B; n <= B + 4n; n++)
    chain.senders.set(n, {
      hash: chain.hashOf(n),
      // The factory's caller is read for each AuctionCreated.
      senders: new Map(
        n === B + 3n
          ? [
              [meta(0).transactionHash, ALICE],
              [meta(1).transactionHash, ALICE],
            ]
          : [],
      ),
      targets: new Map(),
      timestamp: 1_790_000_000 + Number(n - B),
    })
  const apiBody = JSON.stringify({ slug: "../x", pad: TEN_KB.repeat(8) })
  return {
    chain,
    sources: [
      nftxSource({
        sql,
        chain,
        logger,
        launchpad: null,
        fetch: (async () => new Response(apiBody, { status: 200 })) as unknown as typeof fetch,
      }),
    ],
    from: B - 1n,
    check: async (db) => {
      expect(
        await db`select collection, name, symbol from indexer.nftx_collections where collection in (${noisy}, ${huge}) order by collection`,
      ).toEqual([
        { collection: noisy, name: "namewithnul", symbol: "half\ufffdpair" },
        { collection: huge, name: "x".repeat(64), symbol: "x".repeat(32) },
      ])
      // The 96-byte key and the other hook store no side and no prices.
      expect(
        await db`select collection from indexer.nftx_collections where fleth_is_currency0 is not null order by collection`,
      ).toEqual([{ collection: noisy }, { collection: listed }])
      // A sqrt of 0 and one that rounds to zero wei are stored without a price; 1 gives a huge one.
      expect(
        await db`select price_wei is null as none from indexer.nftx_prices where collection = ${noisy} order by log_index`,
      ).toEqual([{ none: true }, { none: false }, { none: true }])
      expect(
        await db`select nftx_slug from indexer.nft_collections where nftx_slug is not null`,
      ).toEqual([])
      // The undecodable config is not stored; the one with the 200 KB of step data is.
      expect(await db`select auction from indexer.nftx_auctions order by auction`).toEqual([
        { auction: nft(0xa2) },
      ])
      expect(await db`select count(*)::int as n from indexer.nftx_auction_bids`).toEqual([{ n: 0 }])
      expect(
        await db`select count(*)::int as n from indexer.events where type in ('nft.sale', 'nft.listing', 'nft.auction')`,
      ).toEqual([{ n: 0 }])
    },
  }
}
