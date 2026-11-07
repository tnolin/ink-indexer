import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import {
  type ChainLog,
  HOOKIT_BONDING_FACTORY,
  HOOKIT_MASTER_FACTORIES,
  HOOKIT_TOPICS,
  INKFUN_FACTORY,
  INKFUN_MIGRATION,
  INKFUN_TOPICS,
  NATIVE_HOOKS,
  SWAP_TOPIC,
  TOPICS,
  TRANSFER_TOPIC,
  TSUNAMI_FACTORY,
  TSUNAMI_FACTORY_2,
  TSUNAMI_TOPICS,
  XSTOCKS_FACTORIES,
} from "@ink-indexer/sdk"
import { type Address, type Hash, type Hex, pad } from "viem"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import type { Logger } from "../src/log"
import type { Reporter } from "../src/sentry"
import { droppedLogs } from "../src/sources/dropped"
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

const STRANGER: Address = "0x105d790a0c84168cfae07c26dbea0bb89c60a7df"
const X: Address = "0x00000000000000000000000000000000000000a1"
const Y: Address = "0x00000000000000000000000000000000000000b2"
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
  /** Two emitters the source trusts. */
  trusted: [Address, Address]
  /** An emitter it does not; null when the source's filter already limits emitters. */
  unknown: Address | null
  build(deps: {
    logger: Logger
    now: () => number
    report: Pick<Reporter, "warn">
  }): Promise<(logs: ChainLog[]) => Promise<unknown>>
}

const word = pad("0x5") as Hex
const processWith = (source: Source<never>, slots: number, slot: number) => (logs: ChainLog[]) =>
  source.process(
    Array.from({ length: slots }, (_, i) => (i === slot ? logs : [])),
    { toBlock: 1n, live: false },
  )

const [MASTER] = [...HOOKIT_MASTER_FACTORIES]

const CASES: Case[] = [
  {
    name: "v4 swap",
    topic0: SWAP_TOPIC,
    rest: [word, word],
    trusted: [X, Y],
    unknown: null,
    build: async (d) => {
      const source = v4Source({ sql, chain: new FakeChain(10n), pools: new PoolRegistry(), ...d })
      return processWith(source as never, 2, 0)
    },
  },
  {
    name: "v4 transfer",
    topic0: TRANSFER_TOPIC,
    rest: [word, word],
    trusted: [X, Y],
    unknown: null,
    build: async (d) => {
      const source = v4Source({ sql, chain: new FakeChain(10n), pools: new PoolRegistry(), ...d })
      return processWith(source as never, 2, 1)
    },
  },
  {
    name: "hookit",
    topic0: HOOKIT_TOPICS.bought,
    trusted: [HOOKIT_BONDING_FACTORY, MASTER!],
    unknown: STRANGER,
    build: async (d) => {
      const source = hookitSource({
        sql,
        chain: new FakeChain(10n),
        pools: new PoolRegistry(),
        ipfs: { gateway: "https://gw.example" },
        ...d,
      })
      return processWith(source as never, 1, 0)
    },
  },
  {
    name: "tsunami",
    topic0: TSUNAMI_TOPICS.bought,
    trusted: [TSUNAMI_FACTORY, TSUNAMI_FACTORY_2],
    unknown: STRANGER,
    build: async (d) => {
      const source = tsunamiSource({
        sql,
        chain: new FakeChain(10n),
        pools: new PoolRegistry(),
        ipfs: { gateway: "https://gw.example" },
        ...d,
      })
      return processWith(source as never, 1, 0)
    },
  },
  {
    name: "inkfun",
    topic0: INKFUN_TOPICS.bought,
    trusted: [INKFUN_FACTORY, INKFUN_MIGRATION],
    unknown: STRANGER,
    build: async (d) => {
      const source = inkfunSource({
        sql,
        chain: new FakeChain(10n),
        pools: new PoolRegistry(),
        ipfs: { gateway: "https://gw.example" },
        ...d,
      })
      return processWith(source as never, 1, 0)
    },
  },
  {
    name: "inkypump trade",
    topic0: TOPICS.trade,
    rest: [word, word],
    trusted: [NATIVE_HOOKS[0]!.address, NATIVE_HOOKS[1]!.address],
    unknown: STRANGER,
    build: inkypump,
  },
  {
    name: "inkypump hook-created",
    topic0: TOPICS.xstocksHookCreated,
    rest: [word],
    trusted: [XSTOCKS_FACTORIES[0]!.address, XSTOCKS_FACTORIES[1]!.address],
    unknown: STRANGER,
    build: inkypump,
  },
]

async function inkypump(d: Parameters<Case["build"]>[0]) {
  const source = inkypumpSource({
    sql,
    chain: new FakeChain(10n),
    pools: new PoolRegistry(),
    ...d,
  })
  await source.reload()
  return processWith(source as never, 1, 0)
}

const DROPPED = "dropped a log that does not decode"
const REPORTED = "a trusted contract emitted a log that does not decode"

for (const c of CASES) {
  describe(`dropped logs: ${c.name}`, () => {
    const warnings: { msg: string; fields: Record<string, unknown> }[] = []
    const reports: { message: string; context?: Record<string, unknown> }[] = []
    const clock = { t: 1_000_000 }
    const logger: Logger = (level, msg, fields) => {
      if (level === "warn") warnings.push({ msg, fields: fields ?? {} })
    }
    const report = {
      warn: (message: string, context?: Record<string, unknown>) =>
        reports.push({ message, context }),
    }
    const dropWarnings = () => warnings.filter((w) => w.msg === DROPPED)
    const bad = (address: Address, i: number) => logOf(address, c.topic0, i, c.rest)
    const build = () => c.build({ logger, now: () => clock.t, report })
    const [A, B] = c.trusted
    beforeEach(() => {
      warnings.length = 0
      reports.length = 0
      clock.t = 1_000_000
    })

    it("a truncated log of a known topic from a trusted emitter warns once with emitter, tx and log index, and the span completes", async () => {
      const run = await build()
      const log = bad(A, 7)
      await run([log])
      expect(dropWarnings()).toEqual([
        {
          msg: DROPPED,
          fields: expect.objectContaining({
            emitter: log.address,
            tx: log.transactionHash,
            logIndex: 7,
            dropped: 1,
          }),
        },
      ])
    })

    it("reports the first undecodable log of each trusted emitter to Sentry once", async () => {
      const run = await build()
      await run([bad(A, 1), bad(A, 2), bad(B, 3)])
      clock.t += 10 * 60_000
      await run([bad(A, 4)])
      expect(reports.map((r) => [r.message, r.context?.emitter])).toEqual([
        [REPORTED, A],
        [REPORTED, B],
      ])
      expect(reports[0]!.context).toMatchObject({ tx: bad(A, 1).transactionHash, logIndex: 1 })
    })

    it("1,000 bad logs from one emitter warn once, and the next warning counts them", async () => {
      const run = await build()
      await run(Array.from({ length: 1_000 }, (_, i) => bad(A, i)))
      expect(dropWarnings()).toHaveLength(1)
      clock.t += 10 * 60_000
      await run([bad(A, 1_000)])
      expect(dropWarnings()).toHaveLength(2)
      expect(dropWarnings()[1]!.fields.dropped).toBe(1_000)
    })

    it("a second trusted emitter warns on its own", async () => {
      const run = await build()
      await run([bad(A, 1), bad(B, 2)])
      expect(dropWarnings().map((w) => w.fields.emitter)).toEqual([A, B])
    })

    it("a log of an unrelated topic is not reported", async () => {
      const run = await build()
      await run([logOf(A, UNRELATED, 1, c.rest)])
      expect(dropWarnings()).toEqual([])
      expect(reports).toEqual([])
    })

    if (c.unknown) {
      const stranger = c.unknown
      it("an unknown emitter's log with a known topic and truncated data is dropped silently", async () => {
        const run = await build()
        await run(Array.from({ length: 5 }, (_, i) => bad(stranger, i)))
        expect(dropWarnings()).toEqual([])
        expect(reports).toEqual([])
      })

      it("unknown emitters do not use up the room for trusted ones", async () => {
        const run = await build()
        await run(
          Array.from({ length: 1_100 }, (_, i) =>
            bad(`0x${(i + 1).toString(16).padStart(40, "0")}` as Address, i),
          ),
        )
        await run([bad(A, 5_000)])
        expect(dropWarnings().map((w) => w.fields.emitter)).toEqual([A])
      })
    }
  })
}

describe("droppedLogs", () => {
  const log = (address: Address, i: number) => logOf(address, TSUNAMI_TOPICS.bought, i)
  const make = (max: number) => {
    const out: { msg: string; fields?: Record<string, unknown> }[] = []
    const drop = droppedLogs({
      source: "t",
      logger: (level, msg, fields) => level === "warn" && out.push({ msg, fields }),
      topics: [TSUNAMI_TOPICS.bought],
      maxEmitters: max,
      now: () => 0,
    })
    return { out, drop }
  }

  it("past the emitter limit it logs one notice and no more warnings", () => {
    const { out, drop } = make(2)
    for (const [i, a] of [X, Y, STRANGER, STRANGER, X].entries()) drop(log(a, i))
    expect(out.map((o) => o.msg)).toEqual([
      DROPPED,
      DROPPED,
      "more emitters with logs that do not decode; not reporting them",
    ])
  })
})
