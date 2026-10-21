import type { Logger } from "../../log"
import type { Budget, BudgetClass } from "./budget"

export type OsResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "budget" | "not_found" | "rejected" | "rate_limited" | "error" }

export type OpenSeaRest = {
  /**
   * GET a path under /api/v2 (with its query, if any) and parse the JSON body. Waits up to
   * `maxWaitMs` for a budget token of class `c`. Never throws.
   */
  get<T>(
    path: string,
    c: BudgetClass,
    parse: (j: unknown) => T,
    opts?: { maxWaitMs?: number },
  ): Promise<OsResult<T>>
}

const BASE_URL = "https://api.opensea.io/api/v2"
const DEFAULT_MAX_WAIT_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_RETRY_MS = 60_000
const MIN_BLOCK_MS = 1_000
const MAX_BLOCK_MS = 3_600_000
const REJECTED_REPORT_EVERY_MS = 3_600_000

/**
 * A client for the OpenSea REST API v2. The key is only ever sent in the `x-api-key` header; it is
 * not logged or reported, and any message that could carry it has it replaced with `***`.
 */
export function createOpenSeaRest(deps: {
  key: string
  budget: Budget
  fetch?: typeof fetch
  log: Logger
  report: (err: unknown) => void
  now?: () => number
}): OpenSeaRest {
  const { key, budget, log, report } = deps
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  let rejectedAt: number | undefined

  /** Text safe to log: the key replaced, and capped. */
  const scrub = (v: unknown): string => {
    const s = v instanceof Error ? v.message : String(v)
    return (key ? s.split(key).join("***") : s).slice(0, 300)
  }
  const warn = (msg: string, path: string, extra: Record<string, unknown> = {}) =>
    log("warn", msg, { path, ...extra })

  return {
    async get<T>(
      path: string,
      c: BudgetClass,
      parse: (j: unknown) => T,
      opts?: { maxWaitMs?: number },
    ): Promise<OsResult<T>> {
      // Never log the query: cursors and filters are not ours to publish.
      const where = path.split("?")[0] ?? path
      try {
        if (!(await budget.take(c, opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)))
          return { ok: false, reason: "budget" }
        let res: Response
        try {
          res = await doFetch(`${BASE_URL}${path}`, {
            headers: { accept: "application/json", "x-api-key": key },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
        } catch (err) {
          warn("opensea request failed", where, { error: scrub(err) })
          return { ok: false, reason: "error" }
        }
        if (res.ok) {
          try {
            return { ok: true, value: parse(await res.json()) }
          } catch (err) {
            warn("opensea response unusable", where, { error: scrub(err) })
            return { ok: false, reason: "error" }
          }
        }
        // Nothing below reads the body; cancel it so the connection goes back to the pool.
        await res.body?.cancel().catch(() => {})
        if (res.status === 404) return { ok: false, reason: "not_found" }
        if (res.status === 401 || res.status === 403) {
          const t = now()
          if (rejectedAt === undefined || t - rejectedAt >= REJECTED_REPORT_EVERY_MS) {
            rejectedAt = t
            // A failing logger or reporter must not hide the reason.
            try {
              log("error", "opensea key rejected", { status: res.status })
              report(new Error(`opensea key rejected (HTTP ${res.status})`))
            } catch {}
          }
          return { ok: false, reason: "rejected" }
        }
        if (res.status === 429) {
          // shortcut: only a Retry-After in seconds is read; an HTTP-date or an empty value falls back to 60 s. Parse the date form if OpenSea starts sending it.
          const header = res.headers.get("retry-after")?.trim()
          const secs = header ? Number(header) : Number.NaN
          const ms =
            Number.isFinite(secs) && secs >= 0
              ? Math.min(Math.max(secs * 1000, MIN_BLOCK_MS), MAX_BLOCK_MS)
              : DEFAULT_RETRY_MS
          try {
            await budget.block(ms)
          } catch (err) {
            warn("opensea block not recorded", where, { error: scrub(err) })
          }
          warn("opensea rate limited", where, { blockedMs: ms })
          return { ok: false, reason: "rate_limited" }
        }
        warn("opensea request failed", where, { status: res.status })
        return { ok: false, reason: "error" }
      } catch (err) {
        warn("opensea request failed", where, { error: scrub(err) })
        return { ok: false, reason: "error" }
      }
    },
  }
}
