# 0032. A wider tip window, and one warning per episode

Date: 2026-10-28
Status: Accepted

Amends ADR 0031.

## Context

ADR 0031 treats a refused `eth_getLogs` as "not there yet" when the span starts fewer than 5 blocks below the transport's own head. An endpoint that lags the chain by more than that still produced refusals outside the window: one on a span starting exactly 5 blocks below the head, and one on a 20-block span. Both were halved and logged at warn.

When a node lags, two other lines repeat for as long as it does. "block not yet served; retrying on next head" was logged at warn on every retry, 124 times in one 6-minute episode, and "stale head from <host>" 18 times. One lagging endpoint produced hundreds of identical warnings.

## Decision

The tip window is 32 blocks. A refusal counts as at the tip when the span's first block is fewer than 32 blocks below the transport's head. The test stays on the span's start, not its end: a span's end is clamped to the transport's head, so an end-based test would also cover a span of the full range (1000 blocks) refused for its size, which must still be halved. A span that starts within 32 blocks of the head is at most 32 blocks long, far below any endpoint's range limit, so a size refusal cannot hide in the window.

The two repeating lines are logged per episode:

- "block not yet served; retrying on next head" starts an episode on the first tick that cannot read a block. It is logged at warn then, at debug for each further retry, and once at info ("block served after retrying") when a tick completes, with the retry count and the duration.
- "stale head from <host>" starts an episode on the first tick whose fallback head is stale. It is logged at warn then, at debug for each further tick, and "head source recovered" at info ends it, now with the tick count and the duration.

A new episode starts, and warns, only after the previous one has ended. Retries and head selection are unchanged.

## Consequences

- A lagging endpoint costs one warning and one info line per episode, with the full count at the end.
- A real range error on a span shorter than 32 blocks at the tip is not halved; other transports still serve it.
- An episode that never ends shows one warning and then only debug lines; a stalled indexer is still caught by the stall watchdog.
