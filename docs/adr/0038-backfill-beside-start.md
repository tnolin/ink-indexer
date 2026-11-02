# 0038. Backfill beside start

Date: 2026-11-02
Status: Accepted

## Context

Readers of `indexer.events` poll with `where confirmed and id > $1` and move their cursor to the last id they read (ADR 0008, ADR 0018). That is safe only while no confirmed row has a higher id than an unconfirmed one. The live tick writes the rows of its head block unconfirmed and confirms them one block later, and off-chain rows are written unconfirmed at the cursor block. A backfill passed its own range end as the head, so it wrote every old row confirmed, with ids above those unconfirmed rows. A reader that had read the backfill's rows never read the live rows when they confirmed. The advisory lock already makes writers commit one at a time; the order of the confirmed flag was the break.

`start` keeps launchpad state in memory: the curves of the Tsunami source and the pool registry that the v4 source reads. It loads them when it starts and again after any failed batch. A backfill of a source writes the rows that state is built from, so a live process that has the source enabled would drop trades of curves and pools it loaded before the backfill wrote them, and a reload in the middle of a run would load history only as far as the backfill has got, and then write trades whose earlier history is missing.

Two rows are written by both processes in either order: a token's dead balance, and its all-time-high market cap, which a backfill continues from the stored value, including swaps above its own range. A backfill also ended when a block it read at the chain head was not yet served by the endpoint, where the live tick retries on the next head.

## Decision

- **Ordered writes.** A backfill write reads the chain head just before it writes. In one transaction it confirms the rows below that head, inserts its own rows, then checks that no confirmed row has a higher id than an unconfirmed one. If one has, the transaction rolls back with `UnconfirmedAboveHeadError`; the backfill waits one second, reads a newer head and writes the same batches again without reading the logs again. It warns once when the wait passes 30 seconds.
- **A platform is not live while its own backfill runs.** Backfills of any source group may run beside `start`, with one rule: the platform being backfilled (a name in `INDEXER_SOURCES`, such as `tsunami`) stays out of `INDEXER_SOURCES` until its backfill is done. The live process does not load Tsunami curves. After a failed batch it reloads and may start following pools the backfill registered; that is safe because the rows both write are order-independent (see below) and the dead balance of a newly followed token is read again. The backfill is given an explicit `--to` at or below the live cursor. A short final stop hands over: stop `start`, run `backfill --from <to + 1> --to <cursor block>` for the last blocks, add the platform to `INDEXER_SOURCES`, and start, which loads the curves and pools of the whole history. The source groups of `--sources` (such as `v4-swaps`) may overlap what the live process writes, because every row they share is safe in either order, as the next point says.
- **Shared rows are safe in either order.** Rows are deduplicated on `(tx_hash, log_index, sub)` and the first copy stands. A dead balance is written only when its block is not older than the stored one (a rollback still resets it to the fork block), and the v4 source reads a token's dead balance again, at the span's read block, when a process starts following it, so burns that happened while nobody followed the token are not lost. The ath only rises, and a backfill loads each token's all-time high from its trades and swaps at or below the block before its range (for tokens whose stored ath is above that block), and again for a span it retries. A backfill reads a token's first dead balance at the live cursor's block when a live process has reached the span, and at the head otherwise.
- **Unserved blocks are retried.** A backfill that is refused a block retries the same span after 1 second, doubling up to 30 seconds, and warns once per episode. After 10 minutes on one block it stops with exit code 1 and an error that gives the `--from`, `--to` and `--sources` to resume with.
- **Load control.** `backfill --block-reads <1-16>` (default 8) sets the block reads in flight, and a backfill logs the same per-endpoint `rpc calls` summary as `start`.

## Consequences

- A backfill of `tsunami` or `v4-swaps` can run for hours while `start` keeps following the head, and the final stop lasts only as long as the last gap takes.
- Without `--to`, a backfill runs to the chain head. Beside `start` it then writes some of the same rows as the live tick; they are identical and the second copy is dropped, but the platform must still be out of `INDEXER_SOURCES` while it runs.
- A backfill write waits only while an unconfirmed row it cannot confirm yet is below it: the live tick's head-block rows or an off-chain row at the cursor. That is about one block.
- A reader that takes a token's latest row by id sees an older backfilled row until the token's next live row.
- The pools a backfill registers for a source that is already live (the `v4-swaps` pools of a launchpad that is on) are followed by the live process after its next restart or reload.
- A backfill started beside `start` carries two sources' worth of requests on the endpoints; `--block-reads` and the `rpc calls` summary show whether the endpoints push back.
