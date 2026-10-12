import * as Sentry from "@sentry/node"

/** Where fatal errors go. The indexer reports only what stops it; retries stay in the logs. */
export type Reporter = { capture(err: unknown): void; flush(ms: number): Promise<boolean> }

export const noopReporter: Reporter = { capture() {}, flush: async () => true }

type Sdk = Pick<typeof Sentry, "init" | "captureException" | "flush">

/** Initialises Sentry when SENTRY_DSN is set; otherwise returns the no-op reporter. */
export function initSentry(env: Record<string, string | undefined>, sdk: Sdk = Sentry): Reporter {
  if (!env.SENTRY_DSN) return noopReporter
  // @sentry/node 11 dropped `sendDefaultPii` from its option types in favour of `dataCollection`.
  // Both are set so PII stays off whichever one the installed version reads.
  const options = {
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE || undefined,
    environment: "production",
    sendDefaultPii: false,
    dataCollection: { userInfo: false },
  }
  sdk.init(options)
  return { capture: (err) => void sdk.captureException(err), flush: (ms) => sdk.flush(ms) }
}
