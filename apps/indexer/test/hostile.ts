import type { Sql } from "@ink-indexer/db"
import {
  type ChainLog,
  NATIVE_QUOTE_ASSET,
  SEADROP_V1,
  SEAPORT_1_6,
  UNISWAP_V4_POOL_MANAGER,
} from "@ink-indexer/sdk"
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  InvalidInputRpcError,
  parseAbi,
} from "viem"
import { loadChimeraCampaigns, loadHookitFixture } from "../../../packages/sdk/test/fixtures"
import type { Logger } from "../src/log"
import { hookitSource } from "../src/sources/hookit/index"
import { inkfunSource } from "../src/sources/inkfun/index"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { nftSource } from "../src/sources/nft/index"
import { type PoolEntry, PoolRegistry } from "../src/sources/pools"
import type { Source } from "../src/sources/source"
import { tsunamiSource } from "../src/sources/tsunami/index"
import { v4Source } from "../src/sources/v4/index"
import { FakeChain } from "./fake-chain"
import { addFixture as addHookit } from "./hookit-scenario"
import { inkfunLaunch } from "./inkfun-scenario"
import { launch } from "./scenario"
import { addFixture as addTsunami } from "./tsunami-scenario"
import { entry, swap } from "./v4-scenario"

/** Values an attacker controls on chain or through an API, and that a source must store or skip without failing the batch. */
export const MAX_UINT256 = 2n ** 256n - 1n
export const NUL_TEXT = "name\u0000with\u0000nul"
export const LONE_SURROGATE_TEXT = "half\ud800pair"
export const TEN_KB = "x".repeat(10 * 1024)
/** A pool list far past what one eth_getLogs request carries. */
export const LONG_POOL_COUNT = 1_500

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
export type HostileScenario = { chain: FakeChain; sources: Source[]; from: bigint }

/**
 * Every source's hostile scenario. A new source adds one line here and gets the same checks:
 * the batch commits and the cursor reaches the head.
 */
export const HOSTILE_SOURCES: Record<string, (env: HostileEnv) => Promise<HostileScenario>> = {
  nft: nftScenario,
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
  const campaign = loadChimeraCampaigns()[0]!
  chain.add({ ...campaign, blockNumber: B + 1n })
  chain.erc20Names.set(campaign.address.toLowerCase() as Address, {
    name: NUL_TEXT,
    symbol: LONE_SURROGATE_TEXT,
  })
  return { chain, sources: [nftSource({ sql, chain, logger })], from: B - 1n }
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
  return { chain, sources: [inkypumpSource({ sql, chain, logger, pools })], from: B - 1n }
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
  swap(chain, { block: B, sqrtPriceX96: 2n ** 160n - 1n })
  return {
    chain,
    sources: [
      inkypumpSource({ sql, chain, logger, pools }),
      v4Source({ sql, chain, logger, pools }),
    ],
    from: B - 1n,
  }
}
