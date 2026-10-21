import { HttpRequestError, LimitExceededRpcError, RpcRequestError } from "viem"
import { describe, expect, it } from "vitest"
import { viemChain } from "../src/chain"
import { connectRpc, httpUrlFor, isTransportError } from "../src/rpc"

type Mode = "ok" | "hang" | "error" | "rpcError" | "revert"
const quiet = () => {}
const TOKEN = "0x0000000000000000000000000000000000000002" as const

/** A fetch that behaves per host. "hang" never settles on its own; it only ends when viem aborts the request. */
function fakeFetch(modes: Record<string, Mode>) {
  const calls: { host: string; method: string }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )
    const body = JSON.parse(String(init?.body))
    calls.push({ host: url.hostname, method: body.method })
    const mode = modes[url.hostname] ?? "ok"
    const reply = (extra: object) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...extra }), {
        headers: { "content-type": "application/json" },
      })
    if (mode === "hang")
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      )
    if (mode === "error") throw new TypeError("fetch failed")
    if (mode === "rpcError" && body.method === "eth_call")
      return reply({ error: { code: -32000, message: "header not found" } })
    if (mode === "revert" && body.method === "eth_call")
      return reply({ error: { code: 3, message: "execution reverted" } })
    const result: Record<string, unknown> = {
      eth_chainId: "0xdef1",
      eth_blockNumber: "0x64",
      net_listening: true,
      eth_getLogs: [],
    }
    return reply({ result: result[body.method] ?? "0x" })
  }) as typeof fetch
  return { fetchFn, calls }
}

const connect = (modes: Record<string, Mode>, opts: { rank?: boolean } = { rank: false }) => {
  const f = fakeFetch(modes)
  return connectRpc(["wss://a.test", "wss://b.test"], quiet, {
    fetchFn: f.fetchFn,
    timeoutMs: 50,
    ...opts,
  }).then((r) => ({ ...r, ...f }))
}

describe("httpUrlFor", () => {
  it("keeps host and path, and maps Ink's websocket-only Gelato host to its http host", () => {
    expect(httpUrlFor("wss://ink.drpc.org")).toBe("https://ink.drpc.org/")
    expect(httpUrlFor("wss://rpc-qnd.inkonchain.com/x")).toBe("https://rpc-qnd.inkonchain.com/x")
    expect(httpUrlFor("wss://ws-gel.inkonchain.com")).toBe("https://rpc-gel.inkonchain.com/")
    expect(httpUrlFor("ws://localhost:8545")).toBe("http://localhost:8545/")
  })
})

describe("isTransportError", () => {
  it("includes http failures but not data errors", () => {
    expect(isTransportError(new HttpRequestError({ url: "https://a.test" }))).toBe(true)
    expect(isTransportError(new Error("execution reverted"))).toBe(false)
  })
})

describe("connectRpc over http", () => {
  it("times out a request that hangs forever and answers from the next endpoint", async () => {
    const { client, calls } = await connect({ "a.test": "hang" })
    const started = Date.now()
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(100n)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(calls.some((c) => c.host === "a.test" && c.method === "eth_blockNumber")).toBe(true)
    expect(calls.some((c) => c.host === "b.test" && c.method === "eth_blockNumber")).toBe(true)
  })

  it("ranks a dead endpoint last once its pings have failed", async () => {
    const { client, calls } = await connect({ "a.test": "hang" }, { rank: true })
    await new Promise((r) => setTimeout(r, 150))
    const before = calls.length
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(100n)
    expect(calls.slice(before)).toEqual([{ host: "b.test", method: "eth_blockNumber" }])
  })

  it("fails over from an endpoint that errors", async () => {
    const { client } = await connect({ "a.test": "error" })
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(100n)
  })

  it("routes getLogs away from a hanging endpoint", async () => {
    const { router } = await connect({ "a.test": "hang" })
    expect(await router.getLogs(1n, 50n, { topics: [] })).toEqual({ logs: [], toBlock: 50n })
  })

  it("fails fast on a revert: one call, no failover, no retry", async () => {
    const { client, router, calls } = await connect({ "a.test": "revert", "b.test": "revert" })
    const sleeps: number[] = []
    const chain = viemChain(client, router, {
      logger: quiet,
      sleep: async (ms) => void sleeps.push(ms),
    })
    await expect(chain.readTotalSupplies([TOKEN], 1n)).rejects.toThrow()
    expect(calls.filter((c) => c.method === "eth_call")).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it("fails fast on an RPC error response from every endpoint: each tried once, not retried", async () => {
    const { client, router, calls } = await connect({ "a.test": "rpcError", "b.test": "rpcError" })
    const sleeps: number[] = []
    const chain = viemChain(client, router, {
      logger: quiet,
      sleep: async (ms) => void sleeps.push(ms),
    })
    await expect(chain.readTotalSupplies([TOKEN], 1n)).rejects.toThrow()
    expect(calls.filter((c) => c.method === "eth_call").map((c) => c.host)).toEqual([
      "a.test",
      "b.test",
    ])
    expect(sleeps).toEqual([])
  })
})

describe("connectRpc hardening", () => {
  it("bounds the whole request, so a body that never finishes fails over", async () => {
    const calls: string[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      )
      const body = JSON.parse(String(init?.body))
      calls.push(url.hostname)
      const json = (extra: object) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...extra }), {
          headers: { "content-type": "application/json" },
        })
      if (url.hostname === "a.test" && body.method !== "eth_chainId")
        // Headers arrive at once; the body never ends and only errors when the request is aborted.
        return new Response(
          new ReadableStream({
            start(c) {
              init?.signal?.addEventListener("abort", () => c.error(init.signal?.reason))
            },
          }),
          { headers: { "content-type": "application/json" } },
        )
      return json({ result: body.method === "eth_blockNumber" ? "0x64" : "0xdef1" })
    }) as typeof fetch
    const { client } = await connectRpc(["wss://a.test", "wss://b.test"], quiet, {
      fetchFn,
      timeoutMs: 100,
      rank: false,
    })
    const started = Date.now()
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(100n)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(calls).toContain("a.test")
  })

  it("pings endpoints with eth_blockNumber when ranking", async () => {
    const { calls } = await connect({}, { rank: true })
    await new Promise((r) => setTimeout(r, 100))
    expect(calls.some((c) => c.method === "net_listening")).toBe(false)
    const pings = calls.filter((c) => c.method === "eth_blockNumber").map((c) => c.host)
    expect(pings).toEqual(expect.arrayContaining(["a.test", "b.test"]))
  })

  it("never downgrades and keeps http(s) entries as given", () => {
    expect(httpUrlFor("https://x.test/p?k=v")).toBe("https://x.test/p?k=v")
    expect(httpUrlFor("http://localhost:8545")).toBe("http://localhost:8545/")
    expect(httpUrlFor("wss://x.test:8443/ws?key=1")).toBe("https://x.test:8443/ws?key=1")
    expect(() => httpUrlFor("ftp://x.test")).toThrow()
  })

  it("polls for heads when no ws:// or wss:// entry is configured, and says so", async () => {
    const f = fakeFetch({})
    const logged: [string, string][] = []
    const only = await connectRpc(
      ["https://a.test", "https://b.test"],
      (l, m) => logged.push([l, m]),
      {
        fetchFn: f.fetchFn,
        timeoutMs: 50,
        rank: false,
      },
    )
    expect(only.pollHeads).toBe(true)
    expect(logged.some(([l, m]) => l === "warn" && /polling/.test(m))).toBe(true)
    expect(await only.heads.getBlockNumber({ cacheTime: 0 })).toBe(100n)
    const both = await connect({})
    expect(both.pollHeads).toBe(false)
  })
})

describe("rate-limited reads", () => {
  const rpcError = (code: number, message = "limit") =>
    new RpcRequestError({ body: {}, error: { code, message }, url: "https://a.test" })

  it("treats rate-limit and server-busy RPC errors as transport errors, and reverts as data errors", () => {
    expect(isTransportError(new LimitExceededRpcError(rpcError(-32005)))).toBe(true)
    expect(isTransportError(rpcError(-32005))).toBe(true)
    expect(isTransportError(rpcError(429))).toBe(true)
    expect(isTransportError(new Error("wrapped", { cause: rpcError(429) }))).toBe(true)
    expect(isTransportError(rpcError(3, "execution reverted"))).toBe(false)
    expect(isTransportError(rpcError(-32000, "header not found"))).toBe(false)
  })

  const cases = [
    { name: "HTTP 429 with a -32005 body", status: 429, code: -32005 },
    { name: "HTTP 429 with a -32000 body", status: 429, code: -32000 },
    { name: "HTTP 503 with a -32000 body", status: 503, code: -32000 },
    { name: "HTTP 200 with a code 429 body", status: 200, code: 429 },
  ]
  for (const c of cases) {
    it(`retries a read that every endpoint answers with ${c.name}, then succeeds`, async () => {
      let blockNumberCalls = 0
      const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const reply = (status: number, extra: object) =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...extra }), {
            status,
            headers: { "content-type": "application/json" },
          })
        if (body.method === "eth_chainId") return reply(200, { result: "0xdef1" })
        if (body.method === "eth_blockNumber" && ++blockNumberCalls <= 12)
          return reply(c.status, { error: { code: c.code, message: "rate limited" } })
        return reply(200, { result: "0x64" })
      }) as typeof fetch
      const logged: [string, string][] = []
      const sleeps: number[] = []
      const { client, router } = await connectRpc(["wss://a.test", "wss://b.test"], quiet, {
        fetchFn,
        timeoutMs: 50,
        rank: false,
      })
      const chain = viemChain(client, router, {
        logger: (l, m) => logged.push([l, m]),
        sleep: async (ms) => void sleeps.push(ms),
      })
      expect(await chain.getBlockNumber()).toBe(100n)
      expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
      expect(logged.map(([l]) => l)).toEqual(["warn", "warn", "warn", "warn", "error", "error"])
    })
  }
})
