# 0048. Skip and pause a source on a refused write

Date: 2026-11-27
Status: Accepted

## Context

A span's rows from every source are written in one transaction. When Postgres refuses one source's rows as bad data, such as a number above `numeric(78,0)` or a NUL character in a `jsonb` payload, the transaction fails, the loop retries the same span and fails the same way, and every source stalls until the watchdog restarts the process. One source's bad row then stops all of them.

Some failures are not about the data. A refused connection, a lock timeout or a serialization failure can happen to any batch and pass on a retry; skipping a span for them would drop good rows.

## Decision

- **The class filter.** Only a `PostgresError` whose SQLSTATE is in class 22 (data exception) or class 23 (integrity constraint violation) is quarantined. Connection, lock and serialization errors are not: they say nothing about the rows, they clear on their own, and the existing retry handles them. Every other error is rethrown as the same object.
- **Pin the failure on a source.** For each source's batch, in source order, a probe inserts that batch's events in a transaction under the store lock and always rolls it back. If the insert passes, the batch is fine on its own. If it fails with a class 22 or 23 error, that source is the one to quarantine. If no source fails alone, or the error is of another kind, the original error is rethrown. The probe commits nothing and never holds the lock across a network read.
- **Skip.** The first refused write of a source skips the span for that source: it is left out and the other sources write the span. The failed attempt reached some block `T`; the re-run covers exactly the blocks from the span's start to `T`, in as many reads as the endpoints return, with the source left out until `T` is covered. The next span starts at `T + 1` with the source included again. The span counts as one span for the watch below.
- **Pause.** A source is paused when it is refused again within its next 2 spans that carried data (a span where the source was picked and its batch held events or blocks), or when it raises a missing-record error. Spans with no data for the source do not count, so a source that is quiet for minutes is not released early. The missing-record errors are `DependencyError`, raised by InkyPump's two throws for a trade or a bond on a launch it does not hold. A paused source is left out of every span, including after a restart, until `pnpm quarantine clear <source>`. A repeat refusal pauses from the first block of the skip; a missing-record error pauses from the earliest open skip of that source, so a trade on a launch from a skipped span pauses from that skip, and otherwise from the current span.
- **Records.** Each skip and pause is a row in `indexer.quarantine` with the source, the kind, whether it came from `start` or a backfill, the block range, the SQLSTATE (`dependency` for a missing record), a message cut to 500 characters with NULs removed, the sources a replay must run and the time it was cleared. The error is also reported with the commands that replay the range. Recording runs in its own transaction under the store lock.
- **Replay through ADR 0038.** The replay is a backfill of the recorded range with the recorded sources, run beside `start` with `--to` at or below the live cursor. A skip of `inkypump`, `v4` or `nft` needs only that. A skip of `inkfun`, `tsunami`, `hookit` or `nftx` also needs a final stop: those sources follow only the curves or collections they loaded when they started (or, for `nftx`, drop events of a collection not yet stored), so a launch from the skipped span would otherwise lose its later events. Their replay runs to the cursor block with `start` stopped, and `start` follows the replayed curves after it restarts. Their skips store the same replay sources as a pause. A pause of a launchpad source also replays `v4-swaps`.
- **Clear.** `pnpm quarantine clear <source>` takes an exact source name and marks that source's open pause cleared, after which `start` includes it again on its next start. With no open pause it says so.
- **Backfills.** A backfill keeps its own watch, applies the same skip and pause rules for the length of its run and never reads live pauses, so a replay can run the source that is paused. Its rows record where to resume with `pnpm backfill --from <from> --to <to> --sources <sources>`.

## Consequences

- A source with bad data no longer stops the others. The other sources write every span, and the quarantine rows say which blocks a replay has to cover.
- The watch is held in memory. A restart inside the 2-span window allows one more skip before a pause.
- A skipped launch's later events need its replay: until then the source cannot attach them to the launch, so they are dropped or paused with it.
- If the re-run's read fails after a skip row is stored, the next tick runs the source on that span again. A refusal that is deterministic then pauses the source from the same block, so a skip can become a pause.
- If recording a row fails, the recording error propagates and carries the refused write as its `cause`.
- Replays are manual. A paused source stays paused through restarts until a fixed release is deployed, the range is replayed and the pause is cleared.
