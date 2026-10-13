import * as Sentry from "@sentry/node"
import { httpUrlFor } from "./rpc"

/** Where fatal errors go. The indexer reports only what stops it; retries stay in the logs. */
export type Reporter = { capture(err: unknown): void; flush(ms: number): Promise<boolean> }

export const noopReporter: Reporter = { capture() {}, flush: async () => true }

type Sdk = Pick<typeof Sentry, "init" | "captureException" | "flush">

const DROPPED_CATEGORIES = new Set(["http", "fetch", "console"])
const REDACTED = "[redacted]"
const MAX_DEPTH = 12

/** The strings to hide for one configured endpoint: the URL, its form without a query, its HTTP form and any password. */
function secretsFor(value: string, withHttpForm: boolean): string[] {
  const out = [value]
  const add = (raw: string) => {
    try {
      const u = new URL(raw)
      out.push(raw, `${u.protocol}//${u.host}${u.pathname}`)
      if (u.password) out.push(decodeURIComponent(u.password))
    } catch {
      // not a URL: the raw value above is all there is to hide
    }
  }
  add(value)
  if (withHttpForm) {
    try {
      add(httpUrlFor(value))
    } catch {
      // unsupported scheme: no HTTP form exists
    }
  }
  return out
}

/** Every URL the indexer is configured with: DATABASE_URL and each INK_RPC_WS_URLS entry, longest first so a full URL goes before its prefix. */
function configuredSecrets(env: Record<string, string | undefined>): string[] {
  const rpc = (env.INK_RPC_WS_URLS ?? "").split(",").map((u) => u.trim())
  const all = [
    ...(env.DATABASE_URL ? secretsFor(env.DATABASE_URL, false) : []),
    ...rpc.filter(Boolean).flatMap((u) => secretsFor(u, true)),
  ]
  // shortcut: strings under 8 characters are skipped so a bare "/" or a short password cannot blank whole messages; list real secrets longer
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
    beforeSend: (event) =>
      redact(
        {
          ...event,
          breadcrumbs: event.breadcrumbs?.filter((b) => !DROPPED_CATEGORIES.has(b.category ?? "")),
        },
        secrets,
      ) as typeof event,
  })
  return { capture: (err) => void sdk.captureException(err), flush: (ms) => sdk.flush(ms) }
}
