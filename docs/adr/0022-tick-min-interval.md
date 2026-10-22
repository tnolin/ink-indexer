# 0022. A minimum interval between live ticks

Date: 2026-10-23
Status: Accepted

## Context

Every live tick costs a fixed number of `eth_getLogs` requests (five with every group on, see ADR 0021), whatever the block range. Ticks run about once per block, so the request count per hour is set by the block rate and not by how much happens on chain. A public endpoint's request limit counts those requests.

## Decision

`TICK_MIN_INTERVAL_MS` (a whole number from 0 to 60000, default 0) is the least time between the starts of two live ticks. `Indexer` keeps the start time of the last tick.

- A trigger at or after `lastStart + N` starts a tick at once.
- An earlier trigger starts nothing. It schedules one tick at `lastStart + N` on a single timer, and every trigger before then joins that tick.
- A trigger during a running tick still folds into one more tick, and that tick also waits out the interval.
- `trigger()` returns a promise that settles when the tick covering that trigger has finished.
- `stop()` clears the timer and settles the waiting triggers without running the tick. Shutdown calls it.
- 0 or unset changes nothing. An invalid value logs a warning without the value and uses 0. The value is in the `indexer started` log line as `tickMinIntervalMs`.

Backfill does not use the interval. The stall watchdog reads the cursor, head fetches and successful ticks, none of which a deferred tick changes, so it needs no change; the 60000 ms cap keeps a wait well inside its 5 minutes.

## Consequences

- A tick after a wait reads every block since the last cursor in the same requests, so requests per hour fall in proportion to N (about 1 in `N / block time` ticks remain).
- Every source sees new data up to N ms later, InkyPump included. Pick N for the endpoint's limit, not for latency.
- Confirmation and reorg handling are unchanged: they run in the tick, against the head it reads.
