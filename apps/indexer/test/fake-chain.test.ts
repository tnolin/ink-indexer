import type { ChainLog } from "@ink-indexer/sdk"
import { type Address, type Hex, pad } from "viem"
import { describe, expect, it } from "vitest"
import { FakeChain } from "./fake-chain"

const T = `0x${"a".repeat(64)}` as Hex
const U = `0x${"b".repeat(64)}` as Hex
const ZERO = pad("0x0") as Hex
const HOLDER = pad("0x1") as Hex
const NFT_A: Address = "0x00000000000000000000000000000000000000a1"
const NFT_B: Address = "0x00000000000000000000000000000000000000b1"

const log = (address: Address, topics: Hex[], logIndex: number): ChainLog => ({
  address,
  topics,
  data: "0x",
  blockNumber: 5n,
  blockHash: pad("0x5") as Hex,
  transactionHash: pad("0x99") as Hex,
  logIndex,
})

describe("FakeChain log filters", () => {
  const chain = new FakeChain(10n)
  chain.add(log(NFT_A, [T, ZERO], 0)) // a mint
  chain.add(log(NFT_A, [T, HOLDER], 1)) // a transfer
  chain.add(log(NFT_B, [U, ZERO], 2))
  const indexes = (ls: ChainLog[]) => ls.map((l) => l.logIndex)

  it("returns every log without a filter", () => {
    expect(indexes(chain.logsIn(0n, 10n))).toEqual([0, 1, 2])
  })

  it("excludes a log whose topic1 is not the zero address", () => {
    expect(indexes(chain.logsIn(0n, 10n, { topics: [T, ZERO] }))).toEqual([0])
  })

  it("matches topic0 alternatives, a null wildcard, and the address", async () => {
    expect(indexes(chain.logsIn(0n, 10n, { topics: [[T, U]] }))).toEqual([0, 1, 2])
    expect(indexes(chain.logsIn(0n, 10n, { topics: [null, ZERO] }))).toEqual([0, 2])
    expect(indexes(chain.logsIn(0n, 10n, { address: NFT_B, topics: [] }))).toEqual([2])
    expect(indexes(chain.logsIn(0n, 10n, { address: [NFT_A, NFT_B], topics: [U] }))).toEqual([2])
    expect(indexes((await chain.getLogs(0n, 10n, { address: NFT_A, topics: [T] })).logs)).toEqual([
      0, 1,
    ])
  })

  it("does not match a log that has fewer topics than the filter", () => {
    expect(chain.logsIn(0n, 10n, { topics: [T, ZERO, ZERO] })).toEqual([])
  })
})
