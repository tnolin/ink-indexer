import { describe, expect, it } from "vitest"
import { DEFAULT_IPFS_GATEWAY, DEFAULT_TSUNAMI_IPFS_GATEWAY, fetchIpfsJson } from "../src/ipfs"
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

  it("the warning names the launchpad and token, never the gateway", async () => {
    const { log, lines } = logger()
    const fake = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch
    await fetchIpfsJson(URI, {
      gateway: GATEWAY,
      fetch: fake,
      sleep: noSleep,
      log,
      launchpad: "tsunami",
      token: TOKEN,
    })
    expect(lines).toEqual([
      {
        level: "warn",
        msg: "token metadata not fetched",
        fields: { launchpad: "tsunami", token: TOKEN },
      },
    ])
    expect(JSON.stringify(lines)).not.toContain("gw.example")
  })

  it("an https metadata URI without an /ipfs/ path is never fetched", async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return json({})
    }) as unknown as typeof fetch
    const cashtagg =
      "https://cashtagg.com/api/ipfs-meta/bafkreibizkcpzl3kqqcuj22is63w5hmufrcvffcsf3xkpkscod2afy2cwi"
    expect(await fetchIpfsJson(cashtagg, { gateway: GATEWAY, fetch: fake })).toBeNull()
    expect(calls).toEqual([])
  })

  it("an https gateway URI with /ipfs/<cid> is fetched from the configured gateway, not its own host", async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return json({ name: "A" })
    }) as unknown as typeof fetch
    const uri =
      "https://ipfs.filebase.io/ipfs/bafkreid4zfy2kgmcoevjnouiybwoupmislmz6hynddono2atedb43pm5ei"
    expect(await fetchIpfsJson(uri, { gateway: GATEWAY, fetch: fake })).toEqual({ name: "A" })
    expect(calls).toEqual([
      `${GATEWAY}/ipfs/bafkreid4zfy2kgmcoevjnouiybwoupmislmz6hynddono2atedb43pm5ei`,
    ])
  })

  it.each([
    "https://ipfs.filebase.io/ipfs/../x",
    "https://ipfs.filebase.io/ipfs/%2e%2e",
    "https://ipfs.filebase.io/ipfs/bafy/../x",
  ])("%s is refused without a fetch", async (uri) => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return json({})
    }) as unknown as typeof fetch
    expect(await fetchIpfsJson(uri, { gateway: GATEWAY, fetch: fake })).toBeNull()
    expect(calls).toEqual([])
  })

  it("a deeply nested body is a failure that does not throw", async () => {
    const fake = (async () =>
      new Response(`${"[".repeat(30_000)}${"]".repeat(30_000)}`)) as unknown as typeof fetch
    await expect(
      fetchIpfsJson(URI, { gateway: GATEWAY, fetch: fake, sleep: noSleep }),
    ).resolves.toSatisfy((v) => v === null || Array.isArray(v))
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
      launchpad: "inkfun",
      token: TOKEN,
    })
    expect(out).toBeNull()
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([500, 500])
    expect(Date.now() - started).toBeLessThan(2_000)
    const warns = lines.filter((l) => l.level === "warn")
    expect(warns).toHaveLength(1)
    expect(warns[0]?.msg).toBe("token metadata not fetched")
    expect(warns[0]?.fields).toEqual({ launchpad: "inkfun", token: TOKEN })
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

  it("does not follow a redirect, and does not retry it", async () => {
    const seen: (string | undefined)[] = []
    let n = 0
    const fake = (async (_url: string, init?: RequestInit) => {
      n += 1
      seen.push(init?.redirect)
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
    }) as unknown as typeof fetch
    const { log, lines } = logger()
    expect(
      await fetchIpfsJson(URI, {
        gateway: GATEWAY,
        fetch: fake,
        sleep: noSleep,
        log,
        token: TOKEN,
      }),
    ).toBeNull()
    expect(n).toBe(1)
    expect(seen).toEqual(["manual"])
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(1)
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

const DEFAULTS = { inkfun: DEFAULT_IPFS_GATEWAY, tsunami: DEFAULT_TSUNAMI_IPFS_GATEWAY }

describe("readIpfsSettings", () => {
  it("an empty IPFS_GATEWAY uses the default gateway", () => {
    const { log, lines } = logger()
    expect(readIpfsSettings({}, log)).toEqual(DEFAULTS)
    expect(readIpfsSettings({ IPFS_GATEWAY: "  " }, log)).toEqual(DEFAULTS)
    expect(lines).toEqual([])
  })

  it("trims a trailing slash from an https origin", () => {
    const { log } = logger()
    expect(readIpfsSettings({ IPFS_GATEWAY: "https://gw.example/" }, log)).toEqual({
      ...DEFAULTS,
      inkfun: "https://gw.example",
    })
  })

  it("rejects an http origin, warns once and uses the default", () => {
    const { log, lines } = logger()
    const secret = "http://gw.example/?key=hunter2"
    expect(readIpfsSettings({ IPFS_GATEWAY: secret }, log)).toEqual(DEFAULTS)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe("warn")
    expect(JSON.stringify(lines)).not.toContain("hunter2")
    expect(lines[0]?.fields?.variable).toBe("IPFS_GATEWAY")
  })

  it("rejects an http origin even when it is otherwise bare", () => {
    const { log, lines } = logger()
    expect(readIpfsSettings({ IPFS_GATEWAY: "http://gw.example" }, log).inkfun).toBe(
      DEFAULT_IPFS_GATEWAY,
    )
    expect(lines).toHaveLength(1)
  })

  it("rejects an origin with a query, a fragment or credentials", () => {
    for (const v of [
      "https://gw.example/?a=1",
      "https://gw.example?a=1",
      "https://gw.example/#x",
      "https://user:pw@gw.example",
    ]) {
      const { log, lines } = logger()
      expect(readIpfsSettings({ IPFS_GATEWAY: v }, log).inkfun, v).toBe(DEFAULT_IPFS_GATEWAY)
      expect(lines, v).toHaveLength(1)
      expect(JSON.stringify(lines)).not.toContain("pw@")
    }
  })

  it("rejects an origin with a path", () => {
    const { log, lines } = logger()
    expect(readIpfsSettings({ IPFS_GATEWAY: "https://gw.example/ipfs" }, log).inkfun).toBe(
      DEFAULT_IPFS_GATEWAY,
    )
    expect(lines).toHaveLength(1)
  })
})

describe("readIpfsSettings for Tsunami", () => {
  it("an empty TSUNAMI_IPFS_GATEWAY uses Tsunami's gateway", () => {
    const { log, lines } = logger()
    expect(readIpfsSettings({}, log).tsunami).toBe("https://burning-aqua-planarian.myfilebase.com")
    expect(readIpfsSettings({ TSUNAMI_IPFS_GATEWAY: " " }, log).tsunami).toBe(
      DEFAULT_TSUNAMI_IPFS_GATEWAY,
    )
    expect(lines).toEqual([])
  })

  it("IPFS_GATEWAY still defaults to ink.fun's", () => {
    const { log } = logger()
    expect(readIpfsSettings({}, log).inkfun).toBe("https://cracker.mypinata.cloud")
    expect(readIpfsSettings({ TSUNAMI_IPFS_GATEWAY: "https://t.example" }, log)).toEqual({
      inkfun: DEFAULT_IPFS_GATEWAY,
      tsunami: "https://t.example",
    })
  })

  it("the two settings are independent", () => {
    const { log } = logger()
    expect(
      readIpfsSettings(
        { IPFS_GATEWAY: "https://a.example/", TSUNAMI_IPFS_GATEWAY: "https://b.example/" },
        log,
      ),
    ).toEqual({ inkfun: "https://a.example", tsunami: "https://b.example" })
  })

  it("an invalid TSUNAMI_IPFS_GATEWAY warns once without its value and uses the default", () => {
    const { log, lines } = logger()
    const out = readIpfsSettings({ TSUNAMI_IPFS_GATEWAY: "http://gw.example/?key=hunter2" }, log)
    expect(out.tsunami).toBe(DEFAULT_TSUNAMI_IPFS_GATEWAY)
    expect(out.inkfun).toBe(DEFAULT_IPFS_GATEWAY)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.fields?.variable).toBe("TSUNAMI_IPFS_GATEWAY")
    expect(JSON.stringify(lines)).not.toContain("hunter2")
  })
})
