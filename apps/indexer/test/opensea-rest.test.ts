import type { Sql } from "@ink-indexer/db"
import { resetDb } from "@ink-indexer/db/testing"
import { parseCollection } from "@ink-indexer/sdk"
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Logger } from "../src/log"
import { type Budget, type BudgetClass, createBudget } from "../src/sources/opensea/budget"
import { createOpenSeaRest } from "../src/sources/opensea/rest"
import { type FakeResponse, fakeFetch, recorded } from "./opensea/fake-fetch"

const KEY = "test-key-0123456789abcdef"
const HOUR = 3_600_000

type LogCall = [string, string, Record<string, unknown>?]
function setup(opts: {
  routes: Parameters<typeof fakeFetch>[0]
  budget?: Budget
  now?: () => number
}) {
  const logs: LogCall[] = []
  const reports: unknown[] = []
  const fetch = fakeFetch(opts.routes)
  const budget = opts.budget ?? { take: async () => true, block: async () => {} }
  const rest = createOpenSeaRest({
    key: KEY,
    budget,
    fetch,
    log: ((...a: LogCall) => void logs.push(a)) as Logger,
    report: (e) => void reports.push(e),
    now: opts.now,
  })
  return { rest, fetch, logs, reports, budget }
}
const everything = (s: { logs: unknown[]; reports: unknown[] }) =>
  JSON.stringify([
    s.logs,
    s.reports.map((r) => (r instanceof Error ? [r.name, r.message, r.stack] : r)),
  ])

describe("OpenSeaRest.get", () => {
  it("sends the key in a header and returns the parsed body of a 200", async () => {
    const s = setup({ routes: { "/collections/ink-hornet": recorded("collections/ink-hornet") } })
    const r = await s.rest.get("/collections/ink-hornet", 2, (j) => parseCollection(j)?.maxRank)
    expect(r).toEqual({ ok: true, value: 2222 })
    expect(s.fetch.calls[0]?.headers["x-api-key"]).toBe(KEY)
    expect(s.fetch.calls[0]?.url).toBe("https://api.opensea.io/api/v2/collections/ink-hornet")
    expect(s.logs).toEqual([])
  })

  it("takes a budget token of the given class before each request, and waits no longer than maxWaitMs", async () => {
    const take = vi.fn(async (_c: BudgetClass, _ms: number) => true)
    const s = setup({
      routes: { "/x": { status: 200, body: {} } },
      budget: { take, block: async () => {} },
    })
    await s.rest.get("/x", 3, () => 1, { maxWaitMs: 1234 })
    await s.rest.get("/x", 1, () => 1)
    expect(take.mock.calls.map((c) => c[0])).toEqual([3, 1])
    expect(take.mock.calls[0]?.[1]).toBe(1234)
    expect(take.mock.calls[1]?.[1]).toBeGreaterThan(0)
  })

  it("maps 404 to not_found", async () => {
    const s = setup({ routes: { "/drops/prtscn-ink": recorded("drops/prtscn-ink") } })
    expect(await s.rest.get("/drops/prtscn-ink", 2, (j) => j)).toEqual({
      ok: false,
      reason: "not_found",
    })
    expect(s.logs).toEqual([])
  })

  it("budget timeout returns reason budget and makes no request", async () => {
    const s = setup({
      routes: { "/x": { status: 200, body: {} } },
      budget: { take: async () => false, block: async () => {} },
    })
    expect(await s.rest.get("/x", 4, (j) => j, { maxWaitMs: 10 })).toEqual({
      ok: false,
      reason: "budget",
    })
    expect(s.fetch.calls).toHaveLength(0)
  })

  it("401 logs once per hour and returns rejected", async () => {
    let t = 1_000_000
    const s = setup({
      routes: { "/x": { status: 401, body: { errors: ["bad key"] } } },
      now: () => t,
    })
    for (let i = 0; i < 3; i++)
      expect(await s.rest.get("/x", 2, (j) => j)).toEqual({ ok: false, reason: "rejected" })
    expect(s.logs.filter((l) => l[1] === "opensea key rejected")).toHaveLength(1)
    expect(s.logs[0]?.[0]).toBe("error")
    expect(s.reports).toHaveLength(1)
    t += HOUR - 1
    await s.rest.get("/x", 2, (j) => j)
    expect(s.logs).toHaveLength(1)
    t += 1
    await s.rest.get("/x", 2, (j) => j)
    expect(s.logs.filter((l) => l[1] === "opensea key rejected")).toHaveLength(2)
    expect(s.reports).toHaveLength(2)
    expect(s.fetch.calls).toHaveLength(5)
  })

  it("403 is rejected the same way", async () => {
    const s = setup({ routes: { "/x": { status: 403 } } })
    expect(await s.rest.get("/x", 2, (j) => j)).toEqual({ ok: false, reason: "rejected" })
    expect(s.reports).toHaveLength(1)
  })

  it("500, a thrown fetch, a bad body and a throwing parser are errors, and never throw", async () => {
    const s = setup({
      routes: {
        "/500": { status: 500, body: {} },
        "/net": new Error("connect ECONNRESET"),
        "/html": () => ({ status: 200, body: undefined }),
        "/ok": { status: 200, body: { a: 1 } },
      },
    })
    expect(await s.rest.get("/500", 2, (j) => j)).toEqual({ ok: false, reason: "error" })
    expect(await s.rest.get("/net", 2, (j) => j)).toEqual({ ok: false, reason: "error" })
    expect(await s.rest.get("/html", 2, (j) => j)).toEqual({ ok: false, reason: "error" })
    expect(
      await s.rest.get("/ok", 2, () => {
        throw new Error("boom")
      }),
    ).toEqual({ ok: false, reason: "error" })
    expect(s.logs.every((l) => l[0] === "warn")).toBe(true)
    expect(s.reports).toEqual([])
  })

  it("a budget that throws is an error", async () => {
    const s = setup({
      routes: {},
      budget: {
        take: async () => {
          throw new Error("connection terminated")
        },
        block: async () => {},
      },
    })
    expect(await s.rest.get("/x", 2, (j) => j)).toEqual({ ok: false, reason: "error" })
  })

  it("429 blocks for Retry-After seconds, or 60 seconds without one, and returns rate_limited", async () => {
    const block = vi.fn(async (_ms: number) => {})
    const budget = { take: async () => true, block }
    const s = setup({
      routes: {
        "/a": { status: 429, headers: { "retry-after": "30" } },
        "/b": { status: 429 },
        "/c": { status: 429, headers: { "retry-after": "soon" } },
        "/d": { status: 429, headers: { "retry-after": "999999" } },
      },
      budget,
    })
    for (const p of ["/a", "/b", "/c", "/d"])
      expect(await s.rest.get(p, 2, (j) => j)).toEqual({ ok: false, reason: "rate_limited" })
    expect(block.mock.calls.map((c) => c[0])).toEqual([30_000, 60_000, 60_000, HOUR])
  })

  describe("with the shared budget in Postgres", () => {
    let sql: Sql
    beforeEach(async () => {
      sql = await resetDb(inject("databaseUrl"))
    })
    afterEach(() => sql.end())

    it("429 writes blocked_until from Retry-After", async () => {
      const s = setup({
        routes: { "/x": { status: 429, headers: { "retry-after": "45" } } },
        budget: createBudget(sql),
      })
      expect(await s.rest.get("/x", 2, (j) => j)).toEqual({ ok: false, reason: "rate_limited" })
      const [row] = await sql<{ left: number }[]>`
        select extract(epoch from blocked_until - now())::float8 as left from indexer.opensea_budget`
      expect(row!.left).toBeGreaterThan(44)
      expect(row!.left).toBeLessThanOrEqual(45)
      // Every later request, from any process, now waits for the block.
      const later = setup({
        routes: { "/x": { status: 200, body: {} } },
        budget: createBudget(sql),
      })
      expect(await later.rest.get("/x", 0, (j) => j, { maxWaitMs: 50 })).toEqual({
        ok: false,
        reason: "budget",
      })
      expect(later.fetch.calls).toHaveLength(0)
    })

    it("takes tokens from the shared row", async () => {
      const s = setup({ routes: { "/x": { status: 200, body: {} } }, budget: createBudget(sql) })
      await sql`update indexer.opensea_budget set tokens = 10, refill_per_s = 0`
      await s.rest.get("/x", 0, (j) => j)
      const [row] = await sql<{ tokens: number }[]>`select tokens from indexer.opensea_budget`
      expect(row!.tokens).toBeCloseTo(9, 3)
    })
  })
})

describe("response bodies", () => {
  /** A fetch whose body stream records whether it was cancelled. */
  function tracked(status: number, headers?: Record<string, string>) {
    const state = { cancelled: false }
    const f = (async () =>
      new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode('{"errors":["x"]}'))
            c.close()
          },
          cancel: () => {
            state.cancelled = true
          },
        }),
        { status, headers },
      )) as unknown as typeof fetch
    return { state, f }
  }
  const make = (f: typeof fetch, budget?: Budget) =>
    createOpenSeaRest({
      key: KEY,
      budget: budget ?? { take: async () => true, block: async () => {} },
      fetch: f,
      log: () => {},
      report: () => {},
    })

  it.each([404, 401, 403, 429, 500, 400])(
    "a %i body is cancelled, not left open",
    async (status) => {
      const { state, f } = tracked(status)
      await make(f).get("/x", 2, (j) => j)
      expect(state.cancelled).toBe(true)
    },
  )

  it("a 200 body is read to the end", async () => {
    const { state, f } = tracked(200)
    expect(await make(f).get("/x", 2, (j) => j)).toEqual({ ok: true, value: { errors: ["x"] } })
    expect(state.cancelled).toBe(false)
  })
})

describe("side effects do not hide the reason", () => {
  it("a throwing reporter or logger still gives rejected", async () => {
    const rest = createOpenSeaRest({
      key: KEY,
      budget: { take: async () => true, block: async () => {} },
      fetch: fakeFetch({ "/x": { status: 401 } }),
      log: () => {
        throw new Error("log down")
      },
      report: () => {
        throw new Error("report down")
      },
    })
    expect(await rest.get("/x", 2, (j) => j)).toEqual({ ok: false, reason: "rejected" })
  })

  it("a failing block write still gives rate_limited", async () => {
    const s = setup({
      routes: { "/x": { status: 429 } },
      budget: {
        take: async () => true,
        block: async () => {
          throw new Error("connection terminated")
        },
      },
    })
    expect(await s.rest.get("/x", 2, (j) => j)).toEqual({ ok: false, reason: "rate_limited" })
  })

  it("an empty Retry-After is the 60 second default", async () => {
    const block = vi.fn(async (_ms: number) => {})
    const s = setup({
      routes: { "/x": { status: 429, headers: { "retry-after": "" } } },
      budget: { take: async () => true, block },
    })
    await s.rest.get("/x", 2, (j) => j)
    expect(block).toHaveBeenCalledWith(60_000)
  })
})

describe("the key", () => {
  it("never appears in a log line, a report or an error, even when fetch echoes it", async () => {
    const echo = (status: number): FakeResponse => ({
      status,
      body: { errors: [`key ${KEY} refused`] },
    })
    const s = setup({
      routes: {
        "/net": () =>
          new Error(
            `request to https://api.opensea.io/api/v2/net?api_key=${KEY} failed, key ${KEY}`,
          ),
        "/401": echo(401),
        "/403": echo(403),
        "/429": echo(429),
        "/500": echo(500),
        "/404": echo(404),
        "/boom": { status: 200, body: {} },
      },
    })
    await s.rest.get("/net", 2, (j) => j)
    await s.rest.get("/401", 2, (j) => j)
    await s.rest.get("/403", 2, (j) => j)
    await s.rest.get("/429", 2, (j) => j)
    await s.rest.get("/500", 2, (j) => j)
    await s.rest.get("/404", 2, (j) => j)
    await s.rest.get("/boom", 2, () => {
      throw new Error(`parser saw ${KEY}`)
    })
    expect(s.logs.length).toBeGreaterThan(3)
    expect(s.fetch.calls.every((c) => c.headers["x-api-key"] === KEY)).toBe(true)
    expect(everything(s)).not.toContain(KEY)
    expect(everything(s)).toContain("***")
  })

  it("logs the path without its query", async () => {
    const s = setup({ routes: { "/collections": { status: 500 } } })
    await s.rest.get("/collections?next=cursor-secret&limit=5", 2, (j) => j)
    expect(everything(s)).toContain("/collections")
    expect(everything(s)).not.toContain("cursor-secret")
    expect(everything(s)).not.toContain("limit=5")
  })
})
