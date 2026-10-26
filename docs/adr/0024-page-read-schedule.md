# 0024. Collection page reads follow mints and sales

Date: 2026-10-26
Status: Accepted

## Context

ADR 0017 reads each collection's OpenSea page about once a day. The page job set the next read a week away for a `filtered` collection and for one with no mint or sale in the last seven days, and nothing moved that read earlier when a quiet collection started to mint or trade. A collection whose row was created before its first mint, or one that failed gate 1 on an early read, was therefore not read again for a week, even after its creator added an X or website link on OpenSea. Gate 1 only sees the links stored at the last read, so the collection stayed `filtered` until the week was over.

## Decision

- A collection's next page read is one day away when it has a mint or a sale in the last seven days (`METADATA_ACTIVE_S`), whatever its verdict. It is seven days away (`METADATA_SLOW_REFRESH_MS`) only when it has neither. The verdict no longer sets the interval.
- When the chain write path stores a mint or a sale for a collection that has a slug, and that collection's `next_metadata_at` is null or more than a day (`METADATA_REFRESH_MS`) away, it sets `next_metadata_at` to now. One update per batch covers every such collection in it, in the transaction that stores the mint or sale rows. A collection with no slug is unchanged: its page is found by discovery.

Gate 1, the page parser and the seven-day interval are unchanged.

No migration: the columns already exist.

## Consequences

- An active `filtered` collection costs about one more page request a day, and the page of a collection that starts to mint is read within a tick of its first stored mint.
- A collection read by this rule is scheduled again by the page job, so it goes back to a day or a week according to its mints and sales.
- A backfill that stores mints or sales for collections with a slug makes their pages due once, in the same way.
