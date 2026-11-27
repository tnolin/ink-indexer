# 0049. Timed range regrow and four block reads

Date: 2026-11-27
Status: Accepted

## Context

The RPC client halves an endpoint's `eth_getLogs` range each time the endpoint answers that the range is too large or that it is rate limited, and doubles it back toward its seed. The doubling happened only when the endpoint was picked for a read. An endpoint that was cut to a small range ranked below the others, so it was rarely picked, and its range stayed small for as long as the others worked. The endpoint was effectively out of use after a burst of rate limits.

Backfills read 8 blocks at a time by default (ADR 0037, ADR 0038). Beside `start`, that default pushed the public endpoints into rate limits more often than a smaller one.

## Decision

- **Timed regrow.** A cut range doubles back toward its seed once 2 minutes have passed since it was last cut, whether or not the endpoint is picked. Each doubling restarts the 2 minutes. A range cut again starts its wait again.
- **Unchanged.** Benching an endpoint after repeated failures works as before and does not stop its range from regrowing. A rate-limit answer still cuts the range.
- **Four block reads.** A backfill reads 4 blocks at a time by default. `--block-reads` still takes 1 to 16.
- ADR 0037 stays as written; the default it names is now 4.

## Consequences

- An endpoint cut by a burst of rate limits is used again with its full range within a few minutes, without waiting to be picked.
- A backfill makes fewer concurrent block reads by default and takes longer on a busy range; `--block-reads` raises it where the endpoints allow.
- An endpoint that keeps rate limiting is cut again each time its range regrows, so its range moves between the cut and the seed.
