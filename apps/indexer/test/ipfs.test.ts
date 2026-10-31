import { describe, expect, it } from "vitest"
import { DEFAULT_IPFS_GATEWAY, fetchIpfsJson } from "../src/ipfs"
import type { Level } from "../src/log"
import { readIpfsSettings } from "../src/wiring"

const URI = "ipfs://bafkreiabc"
const TOKEN = "0x00000000000000000000000000000000000000d1"
const GATEWAY = "https://gw.example"

type Logged = { level: Level; msg: string; fields?: Record<string, unknown> }
const logger = () => {
  const lines: Logged[] = []
  return {
    lines,
    log: (level: Level, msg: string, fields?: Record<string, unknown>) =>
      lines.push({ level, msg, fields }),
  }
}
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init)
const noSleep = async () => {}

/** A fetch that never answers on its own and rejects when its signal aborts. */
const hanging = (calls: string[]): typeof fetch =>
  ((url: string, init?: RequestInit) => {
    calls.push(url)
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })
  }) as unknown as typeof fetch

describe("fetchIpfsJson", () => {
  it("fetches once and returns the JSON", async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return json({ name: "A" })
    }) as unknown as typeof fetch
    const out = await fetchIpfsJson(URI, { gateway: GATEWAY, fetch: fake, sleep: noSleep })
    expect(out).toEqual({ name: "A" })
    expect(calls).toEqual([`${GATEWAY}/ipfs/bafkreiabc`])
  })

  it("does not fetch a URI that is not ipfs://", async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return json({})
    }) as unknown as typeof fetch
    expect(
      await fetchIpfsJson("https://evil.example/m.json", { gateway: GATEWAY, fetch: fake }),
    ).toBeNull()
    expect(calls).toEqual([])
  })

  it("retries a timeout and gives up after three attempts", async () => {
    const calls: string[] = []
    const sleeps: number[] = []
    const { log, lines } = logger()
    const started = Date.now()
    const out = await fetchIpfsJson(URI, {
      gateway: GATEWAY,
      fetch: hanging(calls),
      timeoutMs: 20,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      log,
      token: TOKEN,
    })
    expect(out).toBeNull()
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([500, 500])
    expect(Date.now() - started).toBeLessThan(2_000)
    const warns = lines.filter((l) => l.level === "warn")
    expect(warns).toHaveLength(1)
    expect(warns[0]?.msg).toBe("ink.fun metadata not fetched")
    expect(warns[0]?.fields).toEqual({ token: TOKEN })
    expect(JSON.stringify(lines)).not.toContain("gw.example")
  })

  it("returns the JSON of a later attempt", async () => {
    let n = 0
    const fake = (async () => {
      n += 1
      return n < 3 ? new Response("busy", { status: 503 }) : json({ ok: true })
    }) as unknown as typeof fetch
    expect(await fetchIpfsJson(URI, { gateway: GATEWAY, fetch: fake, sleep: noSleep })).toEqual({
      ok: true,
    })
    expect(n).toBe(3)
  })

  it("a 2 MB body is a failure", async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }))
    }) as unknown as typeof fetch
    expect(await fetchIpfsJson(URI, { gateway: GATEWAY, fetch: fake, sleep: noSleep })).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it("a body that is not JSON is a failure and is not retried", async () => {
    let n = 0
    const fake = (async () => {
      n += 1
      return new Response("<html>")
    }) as unknown as typeof fetch
    expect(await fetchIpfsJson(URI, { gateway: GATEWAY, fetch: fake, sleep: noSleep })).toBeNull()
    expect(n).toBe(1)
  })

  it("cancels the body of a non-200 answer before retrying", async () => {
    let cancelled = 0
    const fake = (async () => {
      const body = new ReadableStream({
        pull(c) {
          c.enqueue(new TextEncoder().encode("x"))
        },
        cancel() {
          cancelled += 1
        },
      })
      return new Response(body, { status: 502 })
    }) as unknown as typeof fetch
    expect(await fetchIpfsJson(URI, { gateway: GATEWAY, fetch: fake, sleep: noSleep })).toBeNull()
    expect(cancelled).toBe(3)
  })
})

describe("readIpfsSettings", () => {
  it("an empty IPFS_GATEWAY uses the default gateway", () => {
    const { log, lines } = logger()
    expect(readIpfsSettings({}, log)).toEqual({ gateway: DEFAULT_IPFS_GATEWAY })
    expect(readIpfsSettings({ IPFS_GATEWAY: "  " }, log)).toEqual({ gateway: DEFAULT_IPFS_GATEWAY })
    expect(lines).toEqual([])
  })

  it("trims a trailing slash from an https origin", () => {
    const { log } = logger()
    expect(readIpfsSettings({ IPFS_GATEWAY: "https://gw.example/" }, log)).toEqual({
      gateway: "https://gw.example",
    })
  })

  it("rejects an http origin, warns once and uses the default", () => {
    const { log, lines } = logger()
    const secret = "http://gw.example/?key=hunter2"
    expect(readIpfsSettings({ IPFS_GATEWAY: secret }, log)).toEqual({
      gateway: DEFAULT_IPFS_GATEWAY,
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe("warn")
    expect(JSON.stringify(lines)).not.toContain("hunter2")
    expect(lines[0]?.fields?.variable).toBe("IPFS_GATEWAY")
  })

  it("rejects an origin with a path", () => {
    const { log, lines } = logger()
    expect(readIpfsSettings({ IPFS_GATEWAY: "https://gw.example/ipfs" }, log).gateway).toBe(
      DEFAULT_IPFS_GATEWAY,
    )
    expect(lines).toHaveLength(1)
  })
})
