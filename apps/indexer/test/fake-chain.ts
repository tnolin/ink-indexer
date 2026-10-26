import type { ChainLog, LaunchKey, LaunchState } from "@ink-indexer/sdk"
import { type Address, type Hash, pad, toHex } from "viem"
import type { Chain } from "../src/chain"
import type { LogFilter } from "../src/rpc"

/** eth_getLogs matching: the address, then each topic position (null matches anything, an array matches any of its topics). */
export function matchesFilter(l: ChainLog, f: LogFilter): boolean {
  if (f.address !== undefined) {
    const wanted = [f.address].flat().map((a) => a.toLowerCase())
    if (!wanted.includes(l.address.toLowerCase())) return false
  }
  if (f.topics.length > l.topics.length) return false
  return f.topics.every((want, i) => {
    if (want === null) return true
    return [want].flat().some((t) => t.toLowerCase() === l.topics[i]?.toLowerCase())
  })
}

/** In-memory Ink. Block n has timestamp n; reorg() moves every block from a height onto a new fork. */
export class FakeChain implements Chain {
  head: bigint
  maxSpan = 1_000n
  logs: ChainLog[] = []
  states = new Map<string, LaunchState>()
  supplies = new Map<string, bigint>()
  /** Per contract, its mint stats at a block. A contract with no entry has no `getMintStats`. */
  mintStats = new Map<
    string,
    (block: bigint) => { totalSupply: bigint; maxSupply: bigint } | null
  >()
  /** Per contract, what `maxSupply()` answers. A contract with no entry has none (null). */
  maxSupplies = new Map<string, bigint>()
  maxSupplyReads: { contract: Address; block: bigint }[] = []
  /** Per contract, its `totalSupply()` at a block; null is a revert. A contract with no entry reverts. */
  totalSupplyAt = new Map<string, (block: bigint) => bigint | null>()
  /** Per address, the block its code was deployed at. An address with no entry has no code. */
  deployedAt = new Map<string, bigint>()
  priorReads: { method: "totalSupply" | "code"; address: Address; block: bigint }[] = []
  erc20 = new Map<string, { decimals: number; symbol: string }>()
  /** Per token, what `symbol()` and `name()` answer; null is a revert. A token with no entry reverts on both. */
  erc20Names = new Map<string, { symbol: string | null; name: string | null }>()
  nameReads: { tokens: Address[]; block: bigint }[] = []
  stateReads: bigint[] = []
  getLogsCalls: [bigint, bigint][] = []
  getBlockNumberCalls = 0
  /** When set, getBlockNumber answers this instead of `head`: a provider stuck on an old block. */
  staleHead: bigint | undefined
  /** What each transport's own eth_blockNumber answers. Empty when none answers. */
  transportHeads: { name: string; head: bigint }[] = []
  /** The `from` of every getTransportHeads call. */
  transportHeadReads: bigint[] = []
  /** The log transport is this many blocks behind head. */
  logLag = 0n
  /** Blocks for which getBlock answers null once (a lagging node that has not seen them yet). */
  nullOnce = new Set<bigint>()
  private forks: { from: bigint; id: number }[] = []

  constructor(head: bigint) {
    this.head = head
  }

  hashOf(n: bigint): Hash {
    let id = 0
    for (const f of this.forks) if (n >= f.from) id = f.id
    return pad(toHex(n * 1000n + BigInt(id)), { size: 32 }) as Hash
  }

  add(log: ChainLog) {
    this.logs.push(log)
  }

  logsIn(from: bigint, to: bigint, filter?: LogFilter): ChainLog[] {
    return this.logs
      .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
      .filter((l) => !filter || matchesFilter(l, filter))
      .map((l) => ({ ...l, blockHash: this.hashOf(l.blockNumber) }))
  }

  reorg(from: bigint) {
    this.forks.push({ from, id: this.forks.length + 1 })
    this.logs = this.logs.filter((l) => l.blockNumber < from)
  }

  async getBlockNumber() {
    this.getBlockNumberCalls++
    return this.staleHead ?? this.head
  }

  async getTransportHeads(from: bigint) {
    this.transportHeadReads.push(from)
    return this.transportHeads
  }

  async getBlock(n: bigint) {
    if (this.nullOnce.delete(n)) return null
    return n > this.head ? null : { hash: this.hashOf(n), timestamp: n }
  }

  async getLogs(from: bigint, to: bigint, filter: LogFilter) {
    // The real LogRouter clamps to the transport's own head and waits when it is behind `from`; here the transport catches up.
    if (this.head - this.logLag < from) this.logLag = 0n
    const end = [from + this.maxSpan - 1n, to, this.head - this.logLag].reduce((a, b) =>
      a < b ? a : b,
    )
    this.getLogsCalls.push([from, end])
    return { logs: this.logsIn(from, end, filter), toBlock: end }
  }

  async readLaunchStates(keys: LaunchKey[], block: bigint) {
    this.stateReads.push(block)
    return keys.map((k) => {
      const s = this.states.get(`${k.hook}:${k.launchId}`)
      if (!s) throw new Error(`no fake state for ${k.hook}:${k.launchId}`)
      return s
    })
  }

  async readTotalSupplies(tokens: Address[]) {
    return tokens.map((t) => this.supplies.get(t) ?? 10n ** 27n)
  }

  async readErc20Meta(token: Address) {
    const m = this.erc20.get(token)
    if (!m) throw new Error(`no fake erc20 for ${token}`)
    return m
  }

  async readErc20Names(tokens: Address[], block: bigint) {
    this.nameReads.push({ tokens, block })
    return tokens.map((t) => this.erc20Names.get(t) ?? { symbol: null, name: null })
  }

  async readMintStats(contract: Address, _minter: Address, block: bigint) {
    return this.mintStats.get(contract)?.(block) ?? null
  }

  async readMaxSupply(contract: Address, block: bigint) {
    this.maxSupplyReads.push({ contract, block })
    return this.maxSupplies.get(contract) ?? null
  }

  async readTotalSupplyAt(contract: Address, block: bigint) {
    this.priorReads.push({ method: "totalSupply", address: contract, block })
    return this.totalSupplyAt.get(contract)?.(block) ?? null
  }

  async hasCodeAt(address: Address, block: bigint) {
    this.priorReads.push({ method: "code", address, block })
    const deployed = this.deployedAt.get(address)
    return deployed !== undefined && block >= deployed
  }
}
