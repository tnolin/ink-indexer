export type Level = "debug" | "info" | "warn" | "error"
export type Logger = (level: Level, msg: string, fields?: Record<string, unknown>) => void

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MIN = RANK[process.env.LOG_LEVEL as Level] ?? RANK.info

/** JSON lines on stdout. Bigints are written as strings. */
export const log: Logger = (level, msg, fields = {}) => {
  if (RANK[level] < MIN) return
  console.log(
    JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  )
}
