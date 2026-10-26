# 0028. A fresh floor for listings

Date: 2026-10-26
Status: Accepted

Amends ADR 0017.

## Context

Each `nft.listing` event carries the collection's floor, `floorWei`, and the time it was read, `floorAt`, from the stored stats. A quiet collection's stats are polled every 12 hours, and a listing asked for a new read only when its floor was more than 2 hours old, at most once per 30 minutes. A listing could therefore carry a floor hours old, and a reader that compares the listing price with the floor skipped the listing or compared it with an old price.

## Decision

- When a listing passes the filter and the collection's stored floor is more than 10 minutes old (`FLOOR_MAX_AGE_MS`), or there is none, the indexer reads the collection's stats from OpenSea before it writes the event. The read is a normal stats read: it goes through the shared request budget (ADR 0019), is stored in `nft_stats`, and the event carries its floor and time.
- A collection is read this way at most once every 10 minutes (`STATS_REQUEST_THROTTLE_MS`), whether or not the last read worked. Listings that arrive in between carry the floor already stored.
- When the read fails, the budget cannot serve it, or the listing waits the 10 seconds it is allowed without an answer, the event is written with the stored floor and its real `floorAt`, and the listing does not wait further.

## Consequences

- A listing's `floorAt` is at most 10 minutes before the listing for a collection the indexer can read, so a reader can tell a fresh floor from a stale one by `floorAt`.
- A collection with listings in every 10-minute window costs up to 6 extra stats requests an hour, drawn from the shared budget. Over a recent day this was at most about 76 an hour for the whole indexer.
- A listing can wait up to 10 seconds for the read when the budget is tight, as before.
