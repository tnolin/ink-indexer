# 0018. Off-chain events in the events table

Date: 2026-10-18
Status: Accepted

## Context

Readers of `indexer.events` poll with `where confirmed and id > $1`. That is only safe if no confirmed row ever has a higher id than an unconfirmed one (ADR 0008 writes events unconfirmed and confirms them one block later). OpenSea-derived events (collection snapshots, drop schedules, stats, listings) and scheduled stage starts have no transaction and no log. They are written between chain batches, by jobs that run beside the chain loop.

## Decision

**Synthetic ids.** An event with no transaction gets a namespaced `tx_hash` and `log_index` 0:
- `os:list:<order hash>` for listings;
- `os:col:<contract>:<n>`, `os:drop:<contract>:<n>` and `os:stats:<contract>:<n>` for collection snapshots, drop schedules and stats, where `n` counts that contract's events of the kind;
- `nft:stage:<contract>:<stage index>` and `nft:start:<contract>` for stage starts that come from a schedule or a duration rather than a log.

These can never collide with a 32-byte hash.

**The cursor-block stamp.** The row's `block` and `block_hash` are the chain cursor's block (the last ingested block) at write time, not the chain head, and the row is written unconfirmed. Chain rows written afterwards are for later blocks, so none of them confirms before an earlier off-chain row. The existing confirm step marks the off-chain row confirmed with the chain rows at that block. The payload's `blockNumber` is set to the same block, and `blockTimestamp` is the receipt time. For OpenSea events `blockNumber` therefore means the block at receipt.

**Rollback moves, not deletes.** When a reorg rolls back to a fork block, chain rows above it are deleted and their source rows with them. Off-chain rows above it are moved to the fork block and its hash, set unconfirmed, and have their payload `blockNumber` updated. They cannot be re-created, because their source (an OpenSea response) is not on the chain. Moving them keeps the snapshot counters and the per-item listing state consistent with the events that exist.

**Locks.** Every write path runs under two locks:
- an in-process FIFO mutex, so callers in one process queue without each holding a database connection;
- a Postgres advisory transaction lock, `pg_advisory_xact_lock(570730001)`, taken as the first statement of the transaction. The key is reserved: nothing else on the database may use it.

Batch writes, off-chain writes, rollback and confirmation all take both. A separate process, such as the `nft:mark` command, writes through the same path, so ids are allocated and committed one writer at a time across processes and the reader invariant holds. A backfill must still not run beside `start`: it writes old blocks that are already confirmed, with ids above any unconfirmed row at the head.

## Consequences

- Off-chain writers need a chain cursor; with none yet they refuse to write.
- A write waits for the advisory lock while another writer holds it.
- Network reads for an off-chain event happen before the write, since the write holds the lock.
- Confirmation waits behind any write in flight.
