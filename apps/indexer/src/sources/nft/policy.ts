// Thresholds and policy values of the NFT source.

/** Block timestamps read in parallel while a batch is processed. */
export const TIMESTAMP_READ_CONCURRENCY = 8

/** Rows per multi-row insert: Postgres allows 65,534 parameters per statement, so 1,000 rows leaves room for 65 columns. */
export const ROW_CHUNK = 1_000

/** Shares of the max supply, in basis points, that each get one `progress` mint event. */
export const MINT_MARKS_BPS = [2500, 5000, 7500] as const

// The OpenSea jobs.

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** How often the scheduler looks for due work. */
export const SCHEDULER_TICK_MS = 10_000
/** Contracts one job handles per tick, one after the other. */
export const JOBS_PER_TICK = 20
/** How long every OpenSea job stops after the API refuses the key. */
export const KEY_REJECTED_PAUSE_MS = HOUR_MS
/** How long a job waits for a request budget token before it defers the contract to the next tick. */
export const OPENSEA_MAX_WAIT_MS = 2_000
/** Wait before trying again after an error that says nothing about the contract (network, 5xx, unusable body). */
export const TRANSIENT_RETRY_MS = 5 * MINUTE_MS

/** Waits after the first four failed slug lookups; after that the wait is `DISCOVERY_DAILY_MS`. */
export const DISCOVERY_RETRY_MS = [5 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS, 6 * HOUR_MS] as const
export const DISCOVERY_DAILY_MS = DAY_MS
/** No retry is scheduled later than this after the first attempt. */
export const DISCOVERY_GIVE_UP_S = 7 * 86400

/** Jobs that look at a daily schedule check what is due this often. */
export const SLOW_JOB_EVERY_MS = MINUTE_MS

/** Collection page fields are read again this long after the last read. */
export const METADATA_REFRESH_MS = DAY_MS

/** A SeaDrop configuration log makes the drop page due this soon, unless it is due sooner. */
export const DROPS_DEBOUNCE_MS = 5 * MINUTE_MS
/** The drop page is read again this long before its first stage starts. */
export const DROPS_LEAD_MS = HOUR_MS

/** A creator's OpenSea account is read again this long after the last read. */
export const ACCOUNT_REFRESH_MS = 7 * DAY_MS

/** New activity on a contract with no slug restarts discovery at most this often. */
export const DISCOVERY_RESTART_MS = DAY_MS
/** A collection whose drop page is missing is looked at again this long later, until its first mint. */
export const DROP_404_RECHECK_MS = DAY_MS

/** How often the scheduled stage starts are looked for. */
export const STAGE_START_EVERY_MS = 30_000
/** A stage whose scheduled start is older than this when seen is not announced. */
export const STAGE_START_WINDOW_MS = 10 * MINUTE_MS
/** A scheduled stage with no known on-chain index gets this plus its place in the drop's order. */
export const SYNTHETIC_STAGE_INDEX = 100
