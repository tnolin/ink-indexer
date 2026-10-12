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

  it("initialises with release, production and no PII when SENTRY_DSN is set", async () => {
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
        sendDefaultPii: false,
        dataCollection: { userInfo: false },
      }),
    )
    const err = new Error("boom")
    r.capture(err)
    expect(sdk.captureException).toHaveBeenCalledWith(err)
    expect(await r.flush(2000)).toBe(true)
    expect(sdk.flush).toHaveBeenCalledWith(2000)
  })
})
