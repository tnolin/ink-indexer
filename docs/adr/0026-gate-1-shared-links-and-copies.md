# 0026. Gate 1 ignores shared links and catches copied names

Date: 2026-10-26
Status: Accepted

Amends ADR 0017.

## Context

Gate 1 (ADR 0017) passes a collection with a name, an image and an X handle or website. One X handle was on 41 collections and another on 12, so a farm passed gate 1 by adding the same link to every collection it made. One of its collections also took the name of a verified collection.

## Decision

- An X handle or a website that is on more than 5 collections (`SHARED_LINK_MAX`) counts as missing for gate 1. Collections of any verdict count toward the 5, including the one being judged. A handle is compared case-insensitively. A website is compared by lowercase host and path, without the scheme, a leading `www.`, a query or fragment, or a trailing slash. A page with another link that is not shared still passes.
- A collection whose name equals another collection's name fails gate 1 when that other collection is OpenSea-verified (`safelist` is `verified`) or has a manual `real` mark. Names are compared case-insensitively, trimmed, with runs of spaces collapsed to one. A collection is never its own copy.
- A verified collection or creator still passes gate 1 at once, and a manual mark still sets the verdict whatever the gates say. So neither rule fails a verified collection or overrides a mark.
- `nft_collections.page_reason` holds the words for a failed gate 1, such as `page: X shared by more than 5 collections (limit: 5 collections or fewer per link)`, and is null while gate 1 has not failed. It is stored with the verdict and is not part of the `nft.collection` event.
- Migration `0013` adds the column and three immutable key functions with an index each, so a comparison is an index lookup. It also marks every collection's verdict dirty, so the verdict job looks at each stored collection once and applies the new rules to it.

## Consequences

- A collection that already passed gate 1 can be filtered by the re-check, and its `nft.collection` snapshot changes when its verdict does.
- A link's count is read when a collection's verdict is evaluated. When a handle reaches a sixth collection, the first five are judged again the next time their own verdict is due, not at once.
- The first 5 collections to use a link keep passing on it.
