import { HttpRequestError, RpcRequestError } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Level } from "../src/log"
import { connectRpc } from "../src/rpc"
import { isRateLimit, RpcStats } from "../src/rpc-stats"

type Line = { level: Level; msg: string; fields?: Record<string, unknown> }
function capture() {
  const lines: Line[] = []
  return {
    lines,
    logger: (level: Level, msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ level, msg, fields }),
  }
}
const zero = { getLogs: 0, blockNumber: 0, getBlock: 0, other: 0, rateLimited: 0 }

describe("RpcStats", () => {
  afterEach(() => vi.useRealTimers())

  it("counts every request by method and transport, other methods under other", () => {
    const stats = new RpcStats(["a.test", "b.test"], capture().logger)
    for (const m of [
      "eth_getLogs",
      "eth_getLogs",
      "eth_blockNumber",
      "eth_getBlockByNumber",
      "eth_call",
      "eth_chainId",
    ])
      stats.count("a.test", m)
    stats.count("b.test", "eth_getLogs")
    expect(stats.snapshot()).toEqual({
      "a.test": { getLogs: 2, blockNumber: 1, getBlock: 1, other: 2, rateLimited: 0 },
      "b.test": { ...zero, getLogs: 1 },
    })
  })

  it("counts a transport it was not told about", () => {
    const stats = new RpcStats([], capture().logger)
    stats.count("c.test", "eth_getLogs")
    stats.rateLimited("c.test")
    expect(stats.snapshot()["c.test"]).toEqual({ ...zero, getLogs: 1, rateLimited: 1 })
  })

  it("emits one summary line every 10 minutes and resets after each", () => {
    vi.useFakeTimers()
    const { lines, logger } = capture()
    const stats = new RpcStats(["a.test", "b.test"], logger)
    stats.start()
    stats.count("a.test", "eth_getLogs")
    stats.count("a.test", "eth_getLogs")
    stats.rateLimited("b.test")
    vi.advanceTimersByTime(599_999)
    expect(lines).toEqual([])
    vi.advanceTimersByTime(1)
    expect(lines).toEqual([
      {
        level: "info",
        msg: "rpc calls",
        fields: {
          windowS: 600,
          transports: {
            "a.test": { ...zero, getLogs: 2 },
            "b.test": { ...zero, rateLimited: 1 },
          },
        },
      },
    ])
    // The next window starts from zero and lists every transport, quiet ones too.
    stats.count("b.test", "eth_blockNumber")
    vi.advanceTimersByTime(600_000)
    expect(lines).toHaveLength(2)
    expect(lines[1]!.fields).toEqual({
      windowS: 600,
      transports: { "a.test": zero, "b.test": { ...zero, blockNumber: 1 } },
    })
    stats.stop()
    vi.advanceTimersByTime(1_200_000)
    expect(lines).toHaveLength(2)
  })
})

describe("isRateLimit", () => {
  it("detects HTTP 429", () => {
    expect(isRateLimit(new HttpRequestError({ url: "https://a.test", status: 429 }))).toBe(true)
    expect(isRateLimit(new HttpRequestError({ url: "https://a.test", status: 500 }))).toBe(false)
    expect(isRateLimit(new HttpRequestError({ url: "https://a.test" }))).toBe(false)
  })

  it("detects JSON-RPC codes -32005 and -32003", () => {
    const rpc = (code: number) =>
      new RpcRequestError({ body: {}, url: "https://a.test", error: { code, message: "x" } })
    expect(isRateLimit(rpc(-32005))).toBe(true)
    expect(isRateLimit(rpc(-32003))).toBe(true)
    expect(isRateLimit(rpc(-32000))).toBe(false)
  })

  it("detects the message patterns, in the error or any cause", () => {
    for (const m of [
      "daily request limit reached",
      "Too Many Requests",
      "rate limit exceeded",
      "rate-limited",
      "ratelimit",
      "HTTP 429: slow down",
    ])
      expect(isRateLimit(new Error("outer", { cause: new Error(m) })), m).toBe(true)
    expect(isRateLimit(new Error("execution reverted"))).toBe(false)
    expect(isRateLimit("boom")).toBe(false)
    expect(isRateLimit(undefined)).toBe(false)
  })
})

describe("connectRpc counting", () => {
  type Reply = (body: { method: string; id: number }) => Response
  const json = (id: number, extra: object) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, ...extra }), {
      headers: { "content-type": "application/json" },
    })
  const ok: Reply = ({ method, id }) =>
    json(id, {
      result: { eth_chainId: "0xdef1", eth_blockNumber: "0x64", eth_getLogs: [] }[method] ?? "0x",
    })

  async function connect(hosts: Record<string, Reply>) {
    const { lines, logger } = capture()
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      )
      return hosts[url.hostname]!(JSON.parse(String(init?.body)))
    }) as typeof fetch
    const rpc = await connectRpc(
      Object.keys(hosts).map((h) => `wss://${h}/secret-key`),
      logger,
      { fetchFn, timeoutMs: 50, rank: false },
    )
    return { ...rpc, lines }
  }

  it("counts each transport's requests by method, including the startup chain id", async () => {
    const { router, client, stats } = await connect({ "a.test": ok, "b.test": ok })
    await router.getLogs(1n, 10n, { topics: [] })
    await router.getLogs(1n, 10n, { topics: [] })
    await client.getBlockNumber({ cacheTime: 0 })
    const snap = stats.snapshot()
    expect(Object.keys(snap)).toEqual(["a.test", "b.test"])
    // Only hostnames appear, never the URL with its key.
    expect(JSON.stringify(snap)).not.toContain("secret")
    expect(snap["a.test"]).toEqual({ ...zero, getLogs: 2, blockNumber: 2, other: 1 })
    // The fallback client only reached the second endpoint at startup.
    expect(snap["b.test"]).toEqual({ ...zero, other: 1 })
  })

  it("counts a 429 response, an HTTP 200 JSON-RPC rate-limit error and a message-only error as rate limited", async () => {
    const limited: Reply = ({ method, id }) =>
      method === "eth_chainId" ? ok({ method, id }) : new Response("slow down", { status: 429 })
    const code: Reply = ({ method, id }) =>
      method === "eth_chainId"
        ? ok({ method, id })
        : json(id, { error: { code: -32003, message: "daily request limit reached" } })
    const text: Reply = ({ method, id }) =>
      method === "eth_chainId"
        ? ok({ method, id })
        : json(id, { error: { code: -32000, message: "Too many requests" } })
    // viem's fallback stops at an RPC error response, so each failing endpoint is read on its own.
    for (const reply of [limited, code, text]) {
      const { client, stats } = await connect({ "a.test": reply })
      await client.getBlockNumber({ cacheTime: 0 }).catch(() => {})
      expect(stats.snapshot()["a.test"]).toMatchObject({ blockNumber: 1, rateLimited: 1 })
    }
  })
})
