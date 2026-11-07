import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  type ChainLog,
  HOOKIT_TOPICS,
  INKFUN_TOPICS,
  NATIVE_HOOKS,
  SWAP_TOPIC,
  TOPICS,
  TRANSFER_TOPIC,
  TSUNAMI_TOPICS,
} from "@ink-indexer/sdk"
import { type Address, type Hash, type Hex, pad } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import { hookitSource } from "../src/sources/hookit/index"
import { inkfunSource } from "../src/sources/inkfun/index"
import { inkypumpSource } from "../src/sources/inkypump/index"
import { PoolRegistry } from "../src/sources/pools"
import type { Source } from "../src/sources/source"
import { tsunamiSource } from "../src/sources/tsunami/index"
import { v4Source } from "../src/sources/v4/index"
import { FakeChain } from "./fake-chain"

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

const A: Address = "0x00000000000000000000000000000000000000a1"
const B: Address = "0x00000000000000000000000000000000000000b2"
const UNRELATED = pad("0x1234") as Hex

const logOf = (address: Address, topic0: Hex, i: number, extraTopics: Hex[] = []): ChainLog => ({
  address,
  blockNumber: 1n,
  blockHash: pad("0x1") as Hash,
  transactionHash: pad(`0x${(i + 1).toString(16)}`) as Hash,
  logIndex: i,
  topics: [topic0, ...extraTopics],
  data: "0x",
})

type Case = {
  name: string
  topic0: Hex
  /** Topics after topic0 that a well-formed log of this event carries. */
  rest?: Hex[]
  /** An emitter the source accepts logs from; sources that read the address before decoding need one. */
  address?: Address
  build(logger: Logger, now: () => number): Promise<(logs: ChainLog[]) => Promise<unknown>>
}

const word = pad("0x5") as Hex
const quiet: Logger = () => {}
const processWith = (source: Source<never>, slots: number, slot: number) => (logs: ChainLog[]) =>
  source.process(
    Array.from({ length: slots }, (_, i) => (i === slot ? logs : [])),
    { toBlock: 1n, live: false },
  )

const CASES: Case[] = [
  {
    name: "v4 swap",
    topic0: SWAP_TOPIC,
    rest: [word, word],
    build: async (logger, now) => {
      const chain = new FakeChain(10n)
      const source = v4Source({ sql, chain, logger, pools: new PoolRegistry(), now })
      return processWith(source as never, 2, 0)
    },
  },
  {
    name: "v4 transfer",
    topic0: TRANSFER_TOPIC,
    rest: [word, word],
    build: async (logger, now) => {
      const chain = new FakeChain(10n)
      const source = v4Source({ sql, chain, logger, pools: new PoolRegistry(), now })
      return processWith(source as never, 2, 1)
    },
  },
  {
    name: "hookit",
    topic0: HOOKIT_TOPICS.bought,
    build: async (logger, now) => {
      const source = hookitSource({
        sql,
        chain: new FakeChain(10n),
        logger,
        pools: new PoolRegistry(),
        ipfs: { gateway: "https://gw.example" },
        now,
      })
      return processWith(source as never, 1, 0)
    },
  },
  {
    name: "tsunami",
    topic0: TSUNAMI_TOPICS.bought,
    build: async (logger, now) => {
      const source = tsunamiSource({
        sql,
        chain: new FakeChain(10n),
        logger,
        pools: new PoolRegistry(),
        ipfs: { gateway: "https://gw.example" },
        now,
      })
      return processWith(source as never, 1, 0)
    },
  },
  {
    name: "inkfun",
    topic0: INKFUN_TOPICS.bought,
    build: async (logger, now) => {
      const source = inkfunSource({
        sql,
        chain: new FakeChain(10n),
        logger,
        pools: new PoolRegistry(),
        ipfs: { gateway: "https://gw.example" },
        now,
      })
      return processWith(source as never, 1, 0)
    },
  },
  {
    name: "inkypump",
    topic0: TOPICS.trade,
    rest: [word, word],
    address: NATIVE_HOOKS[0]!.address,
    build: async (logger, now) => {
      const source = inkypumpSource({
        sql,
        chain: new FakeChain(10n),
        logger,
        pools: new PoolRegistry(),
        now,
      })
      await source.reload()
      return processWith(source as never, 1, 0)
    },
  },
]

for (const c of CASES) {
  describe(`dropped logs: ${c.name}`, () => {
    const warnings: { msg: string; fields: Record<string, unknown> }[] = []
    const clock = { t: 1_000_000 }
    const logger: Logger = (level, msg, fields) => {
      if (level === "warn") warnings.push({ msg, fields: fields ?? {} })
    }
    const dropWarnings = () =>
      warnings.filter((w) => w.msg === "dropped a log that does not decode")
    const bad = (address: Address, i: number) => logOf(address, c.topic0, i, c.rest)
    beforeEach(() => {
      warnings.length = 0
      clock.t = 1_000_000
    })
    const from = (a: Address) => c.address ?? a

    it("a known topic with truncated data warns once with emitter, tx and log index, and the span completes", async () => {
      const run = await c.build(logger, () => clock.t)
      const log = bad(from(A), 7)
      await run([log])
      expect(dropWarnings()).toEqual([
        {
          msg: "dropped a log that does not decode",
          fields: expect.objectContaining({
            emitter: log.address,
            tx: log.transactionHash,
            logIndex: 7,
            dropped: 1,
          }),
        },
      ])
    })

    it("1,000 bad logs from one emitter warn once, and the next warning counts them", async () => {
      const run = await c.build(logger, () => clock.t)
      await run(Array.from({ length: 1_000 }, (_, i) => bad(from(A), i)))
      expect(dropWarnings()).toHaveLength(1)
      clock.t += 10 * 60_000
      await run([bad(from(A), 1_000)])
      expect(dropWarnings()).toHaveLength(2)
      expect(dropWarnings()[1]!.fields.dropped).toBe(1_000)
    })

    it("a log of an unrelated topic is not reported", async () => {
      const run = await c.build(logger, () => clock.t)
      await run([logOf(from(A), UNRELATED, 1, c.rest)])
      expect(dropWarnings()).toEqual([])
    })
  })
}

describe("dropped logs: emitters", () => {
  const c = CASES.find((x) => x.name === "tsunami")!
  it("a second emitter warns on its own, and an emitter past the limit gets one notice", async () => {
    const warnings: string[] = []
    const emitters: string[] = []
    const logger: Logger = (level, msg, fields) => {
      if (level !== "warn") return
      warnings.push(msg)
      if (fields?.emitter) emitters.push(fields.emitter as string)
    }
    const run = await c.build(logger, () => 0)
    await run([logOf(A, c.topic0, 1), logOf(B, c.topic0, 2)])
    expect(emitters).toEqual([A, B])
    const many = Array.from({ length: 1_001 }, (_, i) =>
      logOf(`0x${(i + 1).toString(16).padStart(40, "0")}` as Address, c.topic0, i),
    )
    await run(many)
    await run(many)
    expect(warnings.filter((m) => m.startsWith("more emitters"))).toHaveLength(1)
  })
})
