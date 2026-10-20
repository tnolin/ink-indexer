import * as Sentry from "@sentry/node"
import { REDACTED, secretsFor } from "./redact"

/** Where fatal errors go. The indexer reports only what stops it; retries stay in the logs. */
export type Reporter = { capture(err: unknown): void; flush(ms: number): Promise<boolean> }

export const noopReporter: Reporter = { capture() {}, flush: async () => true }

type Sdk = Pick<typeof Sentry, "init" | "captureException" | "flush">

const DROPPED_CATEGORIES = new Set(["http", "fetch", "console"])
const MAX_DEPTH = 12

/** Every URL the indexer is configured with (DATABASE_URL and each INK_RPC_WS_URLS entry) and the OpenSea key, longest first so a full URL goes before its prefix. */
function configuredSecrets(env: Record<string, string | undefined>): string[] {
  const rpc = (env.INK_RPC_WS_URLS ?? "").split(",").map((u) => u.trim())
  const key = env.OPENSEA_API_KEY?.trim()
  const all = [
    ...(env.DATABASE_URL ? secretsFor(env.DATABASE_URL, false) : []),
    ...rpc.filter(Boolean).flatMap((u) => secretsFor(u, true)),
    ...(key ? [key, encodeURIComponent(key)] : []),
  ]
  // shortcut: strings under 8 characters are skipped so a bare "/" or a short password cannot blank whole messages, and only exact strings match; match on URL structure (or have providers send keys in headers) to close both gaps
  return [...new Set(all.filter((s) => s.length >= 8))].sort((a, b) => b.length - a.length)
}

/** Copies `value` with every secret replaced in its strings. Anything deeper than MAX_DEPTH is cut, which also ends cycles. */
function redact(value: unknown, secrets: string[], depth = 0): unknown {
  if (typeof value === "string") return secrets.reduce((s, x) => s.split(x).join(REDACTED), value)
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_DEPTH) return "[truncated]"
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1))
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, redact(v, secrets, depth + 1)]),
  )
}

/** Initialises Sentry when SENTRY_DSN is set; otherwise returns the no-op reporter. */
export function initSentry(env: Record<string, string | undefined>, sdk: Sdk = Sentry): Reporter {
  if (!env.SENTRY_DSN) return noopReporter
  const secrets = configuredSecrets(env)
  sdk.init({
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE || undefined,
    environment: "production",
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      httpBodies: [],
    },
    // RPC keys live in URL paths, so request and console breadcrumbs would carry them into every event.
    beforeBreadcrumb: (crumb) => (DROPPED_CATEGORIES.has(crumb.category ?? "") ? null : crumb),
    beforeSend: (event) => {
      try {
        return redact(
          {
            ...event,
            breadcrumbs: event.breadcrumbs?.filter(
              (b) => !DROPPED_CATEGORIES.has(b.category ?? ""),
            ),
          },
          secrets,
        ) as typeof event
      } catch {
        // Redaction must never let the original through: keep only the exception type.
        let type = "Error"
        try {
          const t = event.exception?.values?.[0]?.type
          if (typeof t === "string") type = t
        } catch {
          // keep the default type
        }
        return { exception: { values: [{ type, value: "redaction failed" }] } } as typeof event
      }
    },
  })
  return { capture: (err) => void sdk.captureException(err), flush: (ms) => sdk.flush(ms) }
}
