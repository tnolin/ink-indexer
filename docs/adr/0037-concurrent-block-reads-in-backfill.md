# 0037. Concurrent block reads in backfill

Date: 2026-10-31
Status: Accepted

Amended by [0038](0038-backfill-beside-start.md) (2026-11-02): a backfill may run beside `start`, so the consequence that it still runs with `start` stopped no longer applies; the number of block reads in flight is set with `--block-reads` (default 8).

## Context

The Tsunami and v4 swap sources need the sender of every transaction that holds one of their logs, which takes one block read per block with logs. Tsunami also reads each launch block's token supplies and fetches each launch's metadata. A backfill span in a busy range held hundreds of such blocks, and reading them one after another took about 1.8 seconds per block against public Ink endpoints, so a span of 10,000 blocks took over half an hour.

## Decision

- **Backfill reads up front.** In a backfill span both sources read the senders of every block they need before they process any log, with 8 requests in flight. Tsunami's launch supplies are read 4 launch blocks at a time and its metadata is fetched alongside them, instead of after them.
- **The live tick is unchanged.** A live span reads each block when it reaches it, one at a time and in block order, and reads supplies and metadata in the same order as before.
- **Same rows.** The up-front reads only fill a map. Logs are still processed one by one in block and log order against the same in-memory state, so a backfill writes the rows it wrote before. A block whose read failed, was not served or answered with another hash fails the span at that block, and an earlier block's failure always surfaces before a later one's.
- **One request per block.** Each block is its own `getBlockSenders` call, so a failure is retried on its own and moved to the next endpoint by the existing client, and the per-endpoint call counts keep counting every read.
- **No JSON-RPC batches.** The default public Ink endpoints limit batch items per second, refuse batches above a few requests, or answer a large batch more slowly than the request timeout. Batching would need per-endpoint sizes, a longer timeout and a per-item fallback, and still only matches what plain concurrent requests give.

## Consequences

- A backfill of a busy range runs several times faster. A quiet range is bounded by `eth_getLogs`, which is unchanged.
- Backfill still runs with `start` stopped: two writers break the guarantee that event `id` order matches commit order.
- A span holds the hash, timestamp and sender map of each block it reads, which is a few thousand blocks at most.
- The number of reads in flight is a constant in the code; it needs no setting.
