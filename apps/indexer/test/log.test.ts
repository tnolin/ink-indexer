import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "../src/log"

afterEach(() => vi.restoreAllMocks())

function lines(
  env: Record<string, string | undefined>,
  fn: (log: ReturnType<typeof createLogger>) => void,
) {
  const out: string[] = []
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s))
  fn(createLogger(env))
  return out.join("\n")
}

describe("stdout logger", () => {
  const env = {
    INK_RPC_WS_URLS: "wss://host.example/v2/SECRETKEY,wss://other.example/ws?apikey=QUERYKEY99",
  }

  it("keeps only the host of a configured RPC URL, in either form, in any field", () => {
    const out = lines(env, (log) => {
      log("error", "request failed", {
        error: "HttpRequestError: URL: https://host.example/v2/SECRETKEY\n    at fetch (x.js:1:1)",
        url: "wss://other.example/ws?apikey=QUERYKEY99",
        nested: { cause: ["bad https://other.example/ws?apikey=QUERYKEY99 reply"] },
      })
    })
    expect(out).not.toContain("SECRETKEY")
    expect(out).not.toContain("QUERYKEY99")
    expect(out).toContain("https://host.example")
    expect(out).toContain("wss://other.example")
  })

  it("leaves other text alone", () => {
    const out = lines(env, (log) =>
      log("info", "ok", { url: "https://api.example/v2/collections", n: 1n }),
    )
    expect(out).toContain("https://api.example/v2/collections")
    expect(out).toContain('"n":"1"')
  })
})
