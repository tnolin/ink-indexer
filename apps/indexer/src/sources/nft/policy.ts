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
/**
 * After an account read fails with an error (not a budget deferral), the collection page and the
 * account are tried again this much later, so an account that keeps failing costs two requests an hour.
 */
export const ACCOUNT_RETRY_MS = HOUR_MS

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

// Collection kinds and quality gates (spec "Collection verdicts").

/** The burn-ratio fallback for `continuous`: at least this many mints in the kind window... */
export const CONTINUOUS_MIN_MINTS = 100
/** ...and burns at least this share of them, in basis points. */
export const CONTINUOUS_BURN_BPS = 2000
/** A contract without SeaDrop whose burns reach this share of its mints is held as `pending_kind`. */
export const PENDING_KIND_BURN_BPS = 500
/** Mints and burns counted for the kind: this long after the first mint. */
export const KIND_WINDOW_S = 7 * 86400
/** Gate 2: a mint with one public stage passes when it runs longer than this. */
export const STRUCTURE_MIN_MINT_S = 1800
/** A mint counts as still running when its latest mint is at most this old. */
export const STILL_MINTING_S = 600
/** Gate 3 fails only this long after the mint ended (allows a late reveal). */
export const TRAITS_GRACE_S = 72 * 3600
/** A mint with no mints for this long has ended. */
export const MINT_END_IDLE_S = 86400
/** Gate 4: a farm wallet received mints from at least this many other `drop` collections... */
export const FARM_MIN_OTHER = 5
/** ...within this window. */
export const FARM_WINDOW_S = 7 * 86400
/** Gate 4 fails when farm wallets are more than this share of the minters, in basis points... */
export const FARM_SHARE_MAX_BPS = 3000
/** ...and is decided only once the collection has this many distinct minters. */
export const FARM_MIN_MINTERS = 50

/** When the traits sample is taken, after the mint ended: at the end, then a day apart up to the grace. */
export const TRAITS_CHECKPOINTS_S = [0, 86400, 2 * 86400, TRAITS_GRACE_S] as const
/** A verified collection's (or creator's) mint with no SeaDrop stages is announced after this many mints. */
export const MINT_LIVE_VERIFIED_MINTS = 10
/** The verdict is looked at again this often while the collection mints. */
export const VERDICT_RECHECK_S = 3600

// Collection stats (spec "Stats tiers").

/** How often the stats tiers are assigned again. */
export const TIER_EVERY_MS = 10 * MINUTE_MS
/** A collection with a mint this recent is hot. */
export const HOT_MINT_S = 600
/** Sales are counted over this long (7 days) to rank collections. */
export const RANK_WINDOW_S = 7 * 86400
/** The hot tier: this many of the most-sold tracked collections, plus those minting now. */
export const HOT_TOP = 30
/** The warm tier: the next this many of the tracked collections. */
export const WARM_SIZE = 70
/** A collection with a sale or a listing this recent (30 days) and no other tier is cold. */
export const COLD_WINDOW_S = 30 * 86400
// shortcut: times in the NFT tables are derived from block numbers, one block a second (from a
// collection's first mint, or from the chain cursor for "now"), because those tables store blocks,
// not times. Ink's block time is fixed; store a block-time column if that ever changes.
/** Seconds per Ink block. */
export const BLOCK_S = 1
/** Seconds between two stats polls of a collection, by tier. */
export const STATS_INTERVAL_S = { hot: 1200, warm: 7200, cold: 43200 } as const
/** How long the listed count of a collection stays fresh, by tier; cold collections are not counted. */
export const LISTED_INTERVAL_S = { hot: 3600, warm: 6 * 3600 } as const
/** Listing pages read for a listed count. */
export const LISTED_PAGES = 3
/** Listings in one page. */
export const LISTED_PAGE_SIZE = 100
/** A collection's on-demand stats refresh runs at most this often. */
export const STATS_REQUEST_THROTTLE_MS = 30 * MINUTE_MS
/** A listed count that was due and could not be taken (the poll or its listing pages failed) is tried again this much later. */
export const LISTED_RETRY_MS = HOUR_MS
/** A due listed count of a collection OpenSea does not know is dropped after this many polls. */
export const LISTED_NOT_FOUND_GIVE_UP = 3
/** The floor change in `nft.stats` is measured against the newest row at or before this long ago. */
export const FLOOR_CHANGE_WINDOW_MS = DAY_MS
