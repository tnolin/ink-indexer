import { REDACTED, secretsFor } from "./redact"

export type Level = "debug" | "info" | "warn" | "error"
export type Logger = (level: Level, msg: string, fields?: Record<string, unknown>) => void

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MIN = RANK[process.env.LOG_LEVEL as Level] ?? RANK.info

/**
 * Replaces each configured RPC URL (and its HTTP form) with its scheme and host, and any other
 * piece of one that could be a key (path segments, query values, credentials) with a marker, so a
 * client error that quotes the URL cannot write a key to stdout. Longest first.
 */
function rpcScrubber(env: Record<string, string | undefined>): (s: string) => string {
  const urls = (env.INK_RPC_WS_URLS ?? "").split(",").map((u) => u.trim())
  const rules = new Map<string, string>()
  for (const secret of urls.filter(Boolean).flatMap((u) => secretsFor(u, true))) {
    if (secret.length < 8) continue
    try {
      const u = new URL(secret)
      rules.set(secret, `${u.protocol}//${u.host}`)
    } catch {
      rules.set(secret, REDACTED)
    }
  }
  const ordered = [...rules].sort((a, b) => b[0].length - a[0].length)
  return (s) => ordered.reduce((out, [from, to]) => out.split(from).join(to), s)
}

/** JSON lines on stdout. Bigints are written as strings; the configured RPC URLs are cut to their host. */
export function createLogger(env: Record<string, string | undefined>): Logger {
  // Built on the first line: `./redact` reaches back to this module through `./rpc`.
  let scrub: ((s: string) => string) | undefined
  return (level, msg, fields = {}) => {
    if (RANK[level] < MIN) return
    scrub ??= rpcScrubber(env)
    const clean = scrub
    console.log(
      JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
        typeof v === "bigint" ? v.toString() : typeof v === "string" ? clean(v) : v,
      ),
    )
  }
}

export const log: Logger = createLogger(process.env)
