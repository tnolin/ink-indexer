import { appendFileSync } from "node:fs"
import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest"
import { Indexer } from "../src/loop"
import { type GetLogsParams, LogRouter } from "../src/rpc"
import { createStore } from "../src/store"
import { matchesFilter } from "./fake-chain"
import { HOSTILE_SOURCES } from "./hostile"

let sql: Sql
beforeEach(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterEach(() => sql.end())

/** A provider that refuses a request with more than 20 topics or addresses in one position. */
const MAX_LIST = 20

describe.each(Object.entries(HOSTILE_SOURCES))("hostile input: %s", (_name, scenario) => {
  it("commits the batch and moves the cursor to the head", async () => {
    const errors: string[] = []
    const logger = (level: string, msg: string, f?: unknown) => {
      if (process.env.DBG)
        console.log(
          level,
          msg,
          JSON.stringify(f, (_, v) => (typeof v === "bigint" ? v.toString() : v))?.slice(0, 300),
        )
      if (level === "error") errors.push(msg)
    }
    const { chain, sources, from, check } = await scenario({ sql, logger })

    // Reads go through the real router, over a provider with a list cap, as in production.
    const router = new LogRouter(
      [
        {
          name: "capped",
          seed: 1_000,
          getBlockNumber: async () => chain.head,
          getLogs: async (p: GetLogsParams) => {
            const lists = [p.address, ...p.topics].map((l) => (Array.isArray(l) ? l.length : 0))
            if (Math.max(...lists) > MAX_LIST)
              throw new Error("exceeds the maximum number of topics")
            return chain.logsIn(p.fromBlock, p.toBlock).filter((l) => matchesFilter(l, p))
          },
        },
      ],
      { now: () => 0, sleep: async () => {} },
      (level, msg, f) => {
        if (process.env.DBG)
          appendFileSync(
            "/tmp/router.log",
            `${level} ${msg} ${JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? String(v) : v))?.slice(0, 200)}\n`,
          )
      },
    )
    chain.getLogs = (f, t, filter) => router.getLogs(f, t, filter)

    const store = createStore(sql)
    const idx = new Indexer({ chain, store, logger, sources })
    await idx.init()
    await store.writeBatch([], [], {
      cursor: { block: from, hash: chain.hashOf(from) },
      head: chain.head,
    })
    await idx.trigger()

    if (process.env.DBG) console.log(_name, chain.getLogsCalls.length)
    expect((await store.getCursor())?.block).toBe(chain.head)
    expect(errors).toEqual([])
    await check?.(sql)
  })
})

it("every source has a hostile scenario", () => {
  expect(Object.keys(HOSTILE_SOURCES).sort()).toEqual(
    ["hookit", "inkfun", "inkypump", "nft", "tsunami", "v4"].sort(),
  )
})
