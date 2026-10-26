import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChainLog, LaunchKey, LaunchState } from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import type { Chain } from "../src/chain"
import type { LogFilter } from "../src/rpc"
import { matchesFilter } from "./fake-chain"

const DIR = join(import.meta.dirname, "fixtures", "inkypump-range")

/** What scripts/record-inkypump-range.ts saves. Bigints are "123n" strings in the file. */
export type RecordedCalls = {
  range: { from: bigint; to: bigint }
  head: bigint
  logs: ChainLog[]
  getBlock: { block: bigint; result: { hash: Hash; timestamp: bigint } | null }[]
  readLaunchStates: { keys: LaunchKey[]; block: bigint; result: LaunchState[] }[]
  readTotalSupplies: { tokens: Address[]; block: bigint; result: bigint[] }[]
  readErc20Meta: { token: Address; result: { decimals: number; symbol: string } }[]
}

export type GoldenEvent = {
  type: string
  entity: string
  payload: unknown
  block: string
  block_hash: string
  tx_hash: string
  log_index: number
  confirmed: boolean
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, name), "utf8"), (_k, v) =>
    typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  )
}

export const loadCalls = () => readJson<RecordedCalls>("calls.json")

/** The indexer.events rows the loop wrote when the range was recorded, in id order. */
export const goldenEvents = () => readJson<GoldenEvent[]>("golden.json")

const stringify = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x))

/**
 * Answers the Chain calls recorded for one block range. getLogs filters the recorded logs; every
 * other call is looked up by its exact arguments. A call with no recording throws, so a change in
 * what the loop asks for cannot pass unnoticed.
 */
export class ReplayChain implements Chain {
  private readonly answers = new Map<string, unknown>()
  private readonly asked = new Set<string>()
  private readonly served = new Set<ChainLog>()

  constructor(private readonly calls: RecordedCalls = loadCalls()) {
    for (const c of calls.getBlock) this.answers.set(`getBlock:${stringify([c.block])}`, c.result)
    for (const c of calls.readLaunchStates)
      this.answers.set(`readLaunchStates:${stringify([c.keys, c.block])}`, c.result)
    for (const c of calls.readTotalSupplies)
      this.answers.set(`readTotalSupplies:${stringify([c.tokens, c.block])}`, c.result)
    for (const c of calls.readErc20Meta)
      this.answers.set(`readErc20Meta:${stringify([c.token])}`, c.result)
  }

  private answer<T>(method: string, args: unknown[]): T {
    const key = `${method}:${stringify(args)}`
    if (!this.answers.has(key)) throw new Error(`no recorded answer for ${key}`)
    this.asked.add(key)
    return this.answers.get(key) as T
  }

  async getTransportHeads() {
    return []
  }

  async getBlockNumber() {
    return this.calls.head
  }

  async getBlock(n: bigint) {
    return this.answer<{ hash: Hash; timestamp: bigint } | null>("getBlock", [n])
  }

  async getLogs(from: bigint, to: bigint, filter: LogFilter) {
    const toBlock = to < this.calls.head ? to : this.calls.head
    if (from < this.calls.range.from || from > toBlock)
      throw new Error(`no recorded logs for ${from}-${to}`)
    const logs = this.calls.logs.filter(
      (l) => l.blockNumber >= from && l.blockNumber <= toBlock && matchesFilter(l, filter),
    )
    for (const l of logs) this.served.add(l)
    return { logs, toBlock }
  }

  /** Recorded answers never asked for, and recorded logs never returned. Empty when the run used the whole recording. */
  unused(): string[] {
    const answers = [...this.answers.keys()].filter((k) => !this.asked.has(k))
    const logs = this.calls.logs
      .filter((l) => !this.served.has(l))
      .map((l) => `log:${l.transactionHash}:${l.logIndex}`)
    return [...answers, ...logs]
  }

  async readLaunchStates(keys: LaunchKey[], block: bigint) {
    return this.answer<LaunchState[]>("readLaunchStates", [keys, block])
  }

  async readTotalSupplies(tokens: Address[], block: bigint) {
    return this.answer<bigint[]>("readTotalSupplies", [tokens, block])
  }

  async readErc20Meta(token: Address) {
    return this.answer<{ decimals: number; symbol: string }>("readErc20Meta", [token])
  }

  async readErc20Names(): Promise<never> {
    throw new Error("readErc20Names was not recorded")
  }

  async readMintStats(): Promise<null> {
    throw new Error("readMintStats was not recorded")
  }

  async readMaxSupply(): Promise<null> {
    throw new Error("readMaxSupply was not recorded")
  }

  async readTotalSupplyAt(): Promise<null> {
    throw new Error("readTotalSupplyAt was not recorded")
  }

  async hasCodeAt(): Promise<boolean> {
    throw new Error("hasCodeAt was not recorded")
  }
}
