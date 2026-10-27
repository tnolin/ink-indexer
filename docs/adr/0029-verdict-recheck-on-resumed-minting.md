# 0029. Verdict re-check when minting resumes

Date: 2026-10-27
Status: Accepted

## Context

Gate 2 (structure, ADR 0017) fails a drop that stopped minting within 30 minutes of its first mint and has been quiet since. A mint that pauses for a day counts as ended, so a collection that pauses early is filtered. Nothing marked the verdict for a new look when its minting resumed, and the verdict job only re-judges a collection that is marked dirty or due, so the collection stayed filtered although its last mint was recent and gate 2 would now pass.

## Decision

- A mint of a collection whose verdict is `filtered` and whose structure gate is `fail` marks the verdict dirty when no mint of that collection is stored in the day before it (`MINT_END_IDLE_S`, the same idle time that ends a mint). The batch's earliest mint per contract is compared with the stored mints, before the batch's own mints are written.
- The mark is made at most once per resume. The mints that follow in the same run each have a stored mint less than a day before them, so they do not mark again. Marking again needs a new pause of a day.
- Mints already pruned from the table count as a gap, so a long-quiet collection is marked by its next mint.

A cool-down timer would also bound the work, but it needs a column and still re-checks a collection that keeps minting; the gap rule needs no state beyond the stored mints.

## Consequences

- If the re-check still fails the gate (a single stray mint, quiet again for half an hour), the collection stays filtered and is not marked again until minting pauses for another day.
- Collections filtered by other gates, and collections with a manual mark, are not touched by this rule.
