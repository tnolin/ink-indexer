import { describe, expect, it, vi } from "vitest"
import { initSentry, noopReporter } from "../src/sentry"

function fakeSdk() {
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
  }
}

describe("initSentry", () => {
  it("is a no-op without SENTRY_DSN", () => {
    const sdk = fakeSdk()
    expect(initSentry({}, sdk)).toBe(noopReporter)
    expect(sdk.init).not.toHaveBeenCalled()
  })

  it("initialises with release, production and no personal data when SENTRY_DSN is set", async () => {
    const sdk = fakeSdk()
    const r = initSentry(
      { SENTRY_DSN: "https://k@o1.ingest.sentry.io/1", SENTRY_RELEASE: "v0.2.0" },
      sdk,
    )
    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://k@o1.ingest.sentry.io/1",
        release: "v0.2.0",
        environment: "production",
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          urlQueryParams: false,
          httpBodies: [],
        },
      }),
    )
    const err = new Error("boom")
    r.capture(err)
    expect(sdk.captureException).toHaveBeenCalledWith(err)
    expect(await r.flush(2000)).toBe(true)
    expect(sdk.flush).toHaveBeenCalledWith(2000)
  })
})

const RPC = "wss://rpc.example.com/v2/abc123key?apikey=qs456"
const DB = "postgres://indexer:s3cretpw@db.example.com:5432/ink"

// biome-ignore lint/suspicious/noExplicitAny: test events are free-form objects
type Ev = Record<string, any>

function configured() {
  const sdk = fakeSdk()
  initSentry(
    {
      SENTRY_DSN: "https://k@o1.ingest.sentry.io/1",
      INK_RPC_WS_URLS: `${RPC}, https://other.example.org/rpc/zzz999`,
      DATABASE_URL: DB,
    },
    sdk,
  )
  const opts = sdk.init.mock.calls[0]?.[0] as {
    beforeBreadcrumb: (b: { category?: string; message?: string }) => unknown
    beforeSend: (e: Ev) => Ev | null
  }
  return opts
}

describe("sentry scrubbing", () => {
  it.each(["http", "fetch", "console"])("drops %s breadcrumbs", (category) => {
    const { beforeBreadcrumb, beforeSend } = configured()
    expect(beforeBreadcrumb({ category, message: "x" })).toBeNull()
    const event = beforeSend({ breadcrumbs: [{ category, data: { url: RPC } }] })
    expect(event?.breadcrumbs).toEqual([])
  })

  it("keeps other breadcrumbs", () => {
    const { beforeBreadcrumb, beforeSend } = configured()
    const crumb = { category: "indexer", message: "stalled" }
    expect(beforeBreadcrumb(crumb)).toBe(crumb)
    expect(beforeSend({ breadcrumbs: [crumb, { category: "http" }] })?.breadcrumbs).toEqual([crumb])
  })

  it("redacts configured RPC and database URLs in exception values, messages and extras", () => {
    const { beforeSend } = configured()
    const httpForm = "https://rpc.example.com/v2/abc123key?apikey=qs456"
    const event = beforeSend({
      message: `connect ${DB} failed`,
      exception: {
        values: [
          {
            type: "HttpRequestError",
            value: `HTTP request failed. URL: ${httpForm}\nDetails: ${RPC}`,
          },
          { type: "Error", value: "path only https://rpc.example.com/v2/abc123key done" },
          { type: "Error", value: "https://other.example.org/rpc/zzz999" },
        ],
      },
      extra: { nested: { deep: [`pw s3cretpw at ${DB}`] }, n: 5 },
      contexts: { rpc: { url: RPC } },
    })
    const text = JSON.stringify(event)
    for (const secret of ["abc123key", "qs456", "s3cretpw", "zzz999"]) {
      expect(text).not.toContain(secret)
    }
    expect(event?.exception.values[0].value).toContain("[redacted]")
    expect(event?.extra.n).toBe(5)
    expect(event?.exception.values[0].type).toBe("HttpRequestError")
  })

  it("leaves unrelated text alone and survives cyclic or deep objects", () => {
    const { beforeSend } = configured()
    const cyc: Record<string, unknown> = { msg: "plain" }
    cyc.self = cyc
    const event = beforeSend({ extra: cyc })
    expect(event?.extra.msg).toBe("plain")
  })

  it("redacts a bare key segment, query value and username echoed without the URL", () => {
    const sdk = fakeSdk()
    initSentry(
      {
        SENTRY_DSN: "https://k@o1.ingest.sentry.io/1",
        INK_RPC_WS_URLS: "https://rpc.example.com/v2/keySegment99/x?token=queryValue77",
        DATABASE_URL: "postgres://longusername1:pw@db.example.com/ink",
      },
      sdk,
    )
    const opts = sdk.init.mock.calls[0]?.[0] as { beforeSend: (e: Ev) => Ev | null }
    const beforeSend = opts.beforeSend
    const event = beforeSend({
      exception: {
        values: [
          { type: "Error", value: "unauthorized: key keySegment99 / queryValue77 / longusername1" },
        ],
      },
    })
    const text = JSON.stringify(event)
    for (const secret of ["keySegment99", "queryValue77", "longusername1"]) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain("unauthorized")
  })

  it("redacts the OpenSea key", () => {
    const sdk = fakeSdk()
    initSentry(
      { SENTRY_DSN: "https://k@o1.ingest.sentry.io/1", OPENSEA_API_KEY: "osKey0123456789" },
      sdk,
    )
    const opts = sdk.init.mock.calls[0]?.[0] as { beforeSend: (e: Ev) => Ev | null }
    const event = opts.beforeSend({
      exception: {
        values: [{ type: "Error", value: "wss://x/socket?token=osKey0123456789 closed" }],
      },
    })
    expect(JSON.stringify(event)).not.toContain("osKey0123456789")
    expect(JSON.stringify(event)).toContain("closed")
  })

  it("never throws and leaks nothing when redaction fails", () => {
    const { beforeSend } = configured()
    const event: Ev = {
      exception: { values: [{ type: "HttpRequestError", value: `failed ${RPC}` }] },
      message: RPC,
    }
    Object.defineProperty(event, "extra", {
      enumerable: true,
      get() {
        throw new Error("boom")
      },
    })
    const out = beforeSend(event)
    expect(out).toEqual({
      exception: { values: [{ type: "HttpRequestError", value: "redaction failed" }] },
    })
    expect(JSON.stringify(out)).not.toContain("abc123key")
  })
})
