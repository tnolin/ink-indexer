import type { Address, Hash } from "viem"
import { HttpRequestError, pad, toHex } from "viem"
import { describe, expect, it } from "vitest"
import { BlockNotServedError } from "../src/errors"
import { BACKFILL_BLOCK_READS, blockSendersFor } from "../src/sources/senders"
import { FakeChain } from "./fake-chain"

const tx = (n: bigint) => pad(toHex(n), { size: 32 }) as Hash
const who = (n: bigint) => pad(toHex(n + 5000n), { size: 20 }) as Address
const FIRST = 100n

function chainOf(count: number, delays: "reversed" | "none" = "reversed") {
  const chain = new FakeChain(FIRST + 1000n)
  const blocks: bigint[] = []
  for (let i = 0; i < count; i++) {
    const n = FIRST + BigInt(i)
    blocks.push(n)
    chain.senders.set(n, {
      hash: chain.hashOf(n),
      timestamp: 1_000 + i,
      senders: new Map([[tx(n), who(n)]]),
    })
  }
  if (delays === "reversed") chain.sendersDelayMs = (n) => (count - Number(n - FIRST)) * 2
  return { chain, blocks }
}

describe("blockSendersFor", () => {
  it("live: reads nothing up front, then each block when asked, one at a time", async () => {
    const { chain, blocks } = chainOf(6)
    const senders = await blockSendersFor(chain, blocks, { live: true })
    expect(chain.getBlockSendersCalls).toBe(0)
    const asked = [blocks[0]!, blocks[1]!, blocks[2]!, blocks[3]!, blocks[4]!, blocks[5]!]
    for (const n of asked) await senders(n)
    expect(chain.maxSendersInFlight).toBe(1)
    expect(chain.sendersOrder).toEqual(asked)
  })

  it("backfill: reads every block up front, at most 8 at a time", async () => {
    expect(BACKFILL_BLOCK_READS).toBe(8)
    const { chain, blocks } = chainOf(40)
    await blockSendersFor(chain, blocks, { live: false })
    expect(chain.maxSendersInFlight).toBe(8)
    expect(chain.getBlockSendersCalls).toBe(40)
    expect([...chain.sendersOrder].sort()).toEqual([...blocks].sort())
  })

  it("backfill: the limit option sets how many are in flight", async () => {
    const { chain, blocks } = chainOf(12)
    await blockSendersFor(chain, blocks, { live: false, limit: 3 })
    expect(chain.maxSendersInFlight).toBe(3)
  })

  it("backfill: each block's answer is its own block's whatever order the reads finish in", async () => {
    const { chain, blocks } = chainOf(20)
    const senders = await blockSendersFor(chain, blocks, { live: false })
    for (const n of [...blocks].reverse()) {
      const got = await senders(n)
      expect(got).toEqual(
        chain.senders.get(n) && {
          hash: chain.hashOf(n),
          timestamp: 1_000 + Number(n - FIRST),
          senders: new Map([[tx(n), who(n)]]),
        },
      )
    }
  })

  it("backfill: a block the endpoint does not serve answers null when asked, as a live read does", async () => {
    const { chain, blocks } = chainOf(5)
    chain.senders.delete(blocks[2]!)
    const senders = await blockSendersFor(chain, blocks, { live: false })
    expect(await senders(blocks[2]!)).toBeNull()
    expect(await senders(blocks[3]!)).not.toBeNull()
  })

  it("backfill: a block outside the list is read when asked", async () => {
    const { chain, blocks } = chainOf(5, "none")
    const senders = await blockSendersFor(chain, blocks.slice(0, 3), { live: false })
    expect(chain.getBlockSendersCalls).toBe(3)
    expect(await senders(blocks[4]!)).not.toBeNull()
    expect(chain.getBlockSendersCalls).toBe(4)
  })

  it("backfill: a tip refusal is thrown as BlockNotServedError for that block only when that block is asked", async () => {
    const { chain, blocks } = chainOf(10)
    chain.sendersErrors.set(
      blocks[4]!,
      Object.assign(new Error("header not found"), { code: -32000 }),
    )
    const senders = await blockSendersFor(chain, blocks, { live: false })
    for (const n of blocks.slice(0, 4)) expect(await senders(n)).not.toBeNull()
    await expect(senders(blocks[4]!)).rejects.toEqual(new BlockNotServedError(blocks[4]!))
    await expect(senders(blocks[4]!)).rejects.toMatchObject({ block: blocks[4] })
  })

  it("backfill: another read error is thrown when its block is asked, not before", async () => {
    const { chain, blocks } = chainOf(10)
    const failure = new HttpRequestError({ url: "http://rpc.test", details: "fetch failed" })
    chain.sendersErrors.set(blocks[6]!, failure)
    const senders = await blockSendersFor(chain, blocks, { live: false })
    expect(await senders(blocks[5]!)).not.toBeNull()
    await expect(senders(blocks[6]!)).rejects.toBe(failure)
  })
})
