# 0019. One shared OpenSea request budget

Date: 2026-10-20
Status: Accepted

## Context

An OpenSea API key has an hourly limit, and more than one process may use it: the indexer for collection data, and any other process for live lookups. Separate counters in each process cannot keep the key under its limit, and a 429 seen by one process says nothing to the others.

## Decision

The budget lives in Postgres, in the single-row table `indexer.opensea_budget`, and is used only through three functions. Every process that uses the key calls them before each request.

- `opensea_take(class)` refills the bucket by elapsed time and takes one token if the class may spend at the current level, in one locked statement. It returns 0 when the request may go ahead, or the milliseconds to wait (at least 50, at most an hour).
- `opensea_block(ms)` stops every class for `ms` milliseconds, capped at one hour. A shorter block never replaces a longer one. A process calls it on a 429.
- `opensea_configure(per_hour, min_interval_ms)` sets the capacity and refill rate (`OPENSEA_REQUESTS_PER_HOUR`, default 500) and the minimum spacing (`OPENSEA_MIN_INTERVAL_MS`). The indexer calls it at startup. Tokens already accrued are kept, up to the new capacity.

**Class floors.** A class may only draw the bucket down to its floor, a share of capacity kept for the classes above it, so time-sensitive and user-facing calls go first when the budget runs low:

| Class | Use | Floor |
| --- | --- | --- |
| 0 | Live lookups by another process | 0% |
| 1 | Listing ranks | 5% |
| 2 | Discovery and drops | 10% |
| 3 | Stats and listed counts | 25% |
| 4 | Traits samples and background work | 50% |

**Minimum spacing.** A take also needs the minimum interval, default 300 ms, since the last successful take. The hourly bucket alone lets a full bucket go out in a burst, and OpenSea answered 429 five times in 15 minutes while the bucket held about 400 tokens. With the spacing, the same load (51 collections due at once) produced none. A refused take does not move the spacing clock. The spacing is first come, first served across classes, so a class 0 request can queue behind background takes for a few intervals.

**Access.** The three functions are `security definer`, with a pinned `search_path`, and `EXECUTE` is revoked from public. Any other role that shares the key gets `EXECUTE` on `opensea_take` and `opensea_block` and no access to the table.

A process that cannot reach the database makes no OpenSea calls. A 401 or 403 pauses the indexer's OpenSea jobs for an hour, and is logged and reported at most once an hour.

## Consequences

- Several processes can share one key without exceeding its limit, and a 429 seen by one slows all of them.
- Every OpenSea request costs one database round trip.
- A key with a higher limit needs only a new `OPENSEA_REQUESTS_PER_HOUR`.
- The spacing can be tuned without a migration, through `OPENSEA_MIN_INTERVAL_MS`.
