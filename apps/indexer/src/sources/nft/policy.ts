// Thresholds and policy values of the NFT source.

/** Block timestamps read in parallel while a batch is processed. */
export const TIMESTAMP_READ_CONCURRENCY = 8

/** Rows per multi-row insert: Postgres allows 65,534 parameters per statement, so 1,000 rows leaves room for 65 columns. */
export const ROW_CHUNK = 1_000

/** Shares of the max supply, in basis points, that each get one `progress` mint event. */
export const MINT_MARKS_BPS = [2500, 5000, 7500] as const
