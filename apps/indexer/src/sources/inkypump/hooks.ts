import {
  type AbiFamily,
  type ChainLog,
  NATIVE_HOOKS,
  NATIVE_QUOTE_ASSET,
  XSTOCKS_FACTORIES,
} from "@ink-indexer/sdk"
import type { Address, Hash } from "viem"
import { type Logger, log } from "../../log"

export type HookRow = {
  address: Address
  kind: "native" | "xstocks"
  abiFamily: AbiFamily
  quoteAsset: Address
  quoteDecimals: number
  quoteSymbol: string | null
  assetId: Hash | null
  discoveredBlock: bigint
}

export function nativeHookRows(): HookRow[] {
  return NATIVE_HOOKS.map((h) => ({
    address: h.address,
    kind: "native",
    abiFamily: h.abiFamily,
    quoteAsset: NATIVE_QUOTE_ASSET,
    quoteDecimals: 18,
    quoteSymbol: null,
    assetId: null,
    discoveredBlock: h.startBlock,
  }))
}

const FACTORIES = new Set<string>(XSTOCKS_FACTORIES.map((f) => f.address))

/** Which contracts are trusted to emit InkyPump events. */
export class HookRegistry {
  private readonly hooks = new Map<string, HookRow>()
  private readonly warned = new Set<string>()

  constructor(
    rows: HookRow[],
    private readonly logger: Logger = log,
  ) {
    for (const r of rows) this.hooks.set(r.address, r)
  }

  get(address: string): HookRow | undefined {
    return this.hooks.get(address.toLowerCase())
  }

  add(row: HookRow) {
    this.hooks.set(row.address, row)
  }

  isFactory(address: string): boolean {
    return FACTORIES.has(address.toLowerCase())
  }

  /** Logs once per address per process. A new native hook shows up here at its first launch. */
  warnUnknown(l: ChainLog) {
    if (this.warned.has(l.address)) return
    this.warned.add(l.address)
    this.logger("warn", "ignoring InkyPump-shaped event from an unknown contract", {
      address: l.address,
      block: l.blockNumber,
      tx: l.transactionHash,
      topic0: l.topics[0],
    })
  }
}
