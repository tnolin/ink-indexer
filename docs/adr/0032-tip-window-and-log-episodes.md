# 0032. A wider tip window, and one warning per episode

Date: 2026-10-28
Status: Accepted

Amends ADR 0031.

## Context

ADR 0031 treats a refused `eth_getLogs` as "not there yet" when the span starts fewer than 5 blocks below the transport's own head. An endpoint that lags the chain by more than that still produced refusals outside the window: one on a span starting exactly 5 blocks below the head, and one on a 20-block span. Both were halved and logged at warn.

When a node lags, two other lines repeat for as long as it does. "block not yet served; retrying on next head" was logged at warn on every retry, 124 times in one 6-minute episode, and "stale head from <host>" 18 times. One lagging endpoint produced hundreds of identical warnings.

## Decision

The tip window is 32 blocks. A refusal counts as at the tip when the span's first block is fewer than 32 blocks below the transport's head. The test stays on the span's start, not its end: a span's end is clamped to the transport's head, so an end-based test would also cover a span of the full range (1000 blocks) refused for its size, which must still be halved. A span that starts within 32 blocks of the head is at most 32 blocks long, far below any endpoint's range limit, so a size refusal cannot hide in the window.

The two repeating conditions, "block not yet served" and "stale head from <host>", each warn at most once in 10 minutes. Production showed why a warning per episode is not enough: for six minutes each new block was not served once or twice and then served, and the stale head recovered and went stale again every 10 to 30 seconds, so every episode was seconds long and one warning per episode still logged about 120 lines.

- An episode of a condition starts on the first tick it occurs after a tick where it did not. It logs at warn when no warning for that condition was logged in the last 10 minutes; otherwise at debug. Every further line of the episode, and its end ("block served after retrying", "head source recovered", with duration and count), logs at debug.
- A stretch is the run of episodes of one condition with no gap of 10 minutes or more between them. When a stretch has ended and some of its episodes did not warn, one info line sums it up ("<condition>; stretch ended") with the condition, the start and end time, the number of episodes and, for stale heads, the hosts. A stretch in which every episode warned logs no summary.
- The summary is written by the first tick after the quiet period, so it needs no timer and appears only while the indexer keeps ticking.
- The conditions are counted separately. Retries and head selection are unchanged.

## Consequences

- A lagging endpoint costs at most one warning per condition every 10 minutes, and one info summary when the stretch ends.
- An episode's own duration is only at debug; the summary gives the stretch's span and episode count.
- A real range error on a span shorter than 32 blocks at the tip is not halved; other transports still serve it.
- An episode that never ends shows one warning and then only debug lines; a stalled indexer is still caught by the stall watchdog.
