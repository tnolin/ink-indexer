# 0030. Back-off for OpenSea errors that keep failing

Date: 2026-10-27
Status: Accepted

## Context

When a request for a collection fails with an error that says nothing about the collection (a 400, a 5xx, a network error, an unusable body), the discovery, metadata, drops, traits and stats jobs tried it again after five minutes. An error that does not clear repeated that every five minutes for good, about 12 requests an hour for each such collection, and the requests count against the shared budget (ADR 0019).

## Decision

- The indexer counts consecutive failed attempts per collection and job in `nft_job_failures` (migration 0014), a row per `(contract, job)` that exists only while the job is failing.
- After the first, second and third consecutive failure the job waits 5 minutes, 30 minutes and 2 hours. For a 4xx answer other than 404 and 429 (a 400, for example), which is about that collection, the fourth and every later failure waits a day.
- A 5xx answer or a network error is taken to be an outage, which hits every collection at once. Those use the same ladder but stop at 2 hours, so a few hours of outage never leaves a collection on a daily retry once OpenSea is back.
- An answer ends the streak and deletes the row: data, or a definite "not found". The next failure waits five minutes again.
- Not counted and not changed: a 404 keeps its own schedule for each job, a 429 still blocks the shared budget for the time OpenSea asks, a rejected key still pauses the jobs, and a request deferred for lack of budget is not a failure.
- Discovery keeps its own count for "no slug found" (`discovery_attempts`, with the seven-day give-up); only errors use the new count.
- Only scheduled work counts. A stats refresh requested on demand neither counts nor resets.

## Consequences

- A collection that keeps failing with a 4xx costs at most 4 requests in its first 3 hours, then one a day, for each job. During an outage each collection and job costs at most one request every 2 hours after the first 3 hours.
- After an outage, collections are retried within 2 hours. A collection that fails with a 4xx is noticed again within a day at worst; new activity (a mint or sale) still makes a collection due as before.
- The table holds one row per failing collection and job and is emptied by the next answer.
