# 0016. NFT chain sources: mints, burns, SeaDrop, Seaport and Chimera

Date: 2026-10-18
Status: Accepted

## Context

The indexer follows InkyPump V2. NFTs on Ink need five more kinds of chain data: mints, burns, SeaDrop drop logs, Seaport sales and Chimera launches. One block range can yield several events from a single log (a sweep sells many items in one order; one SeaDrop mint can cross two milestones), and every source should share the reorg handling of ADR 0008.

Measured on Ink mainnet between 2026-10-17 and 2026-10-20:
- About 232,000 ERC-721 mints a day across about 480 contracts, 300 of them minting through SeaDrop v1.
- About 16% of Seaport sale transactions fill a buyer's offer against the seller's order, so the same NFT appears in two `OrderFulfilled` logs.
- ERC-20 transfers use the same event signature as ERC-721 transfers and differ only in having 3 topics.

## Decision

**Source interface.** A source is `Source` in `apps/indexer/src/sources/source.ts`: its log filters, `process` (network reads, no writes), `write` (inside the batch transaction), and `prepareRollback`, `rollback` and `reload`. The InkyPump code is the first source and NFTs the second. The loop runs every source over the same block range and writes all batches, the events and the cursor in one transaction. There is one cursor, one reorg check and one rollback for all sources. The cursor row keeps its historical name `inkypump`. A backfill can name sources (`inkypump`, `nft-mints`, `nft-sales`, `nft-launches`), and a filter it does not pick is not fetched. ADR 0010's range routing applies to each filter.

**Chain sources.** One NFT source reads seven filters:
1. ERC-721 `Transfer` from the zero address (mints).
2. ERC-721 `Transfer` to the zero address (burns).
3. ERC-1155 `TransferSingle` and `TransferBatch` from the zero address.
4. ERC-1155 `TransferSingle` and `TransferBatch` to the zero address.
5. Every log from SeaDrop v1.
6. `OrderFulfilled` from Seaport 1.6 and 1.5.
7. `CampaignCreated` from the Chimera factory proxy `0xa66c05f14e79f40952531c20de0b60282e3800be`.

Transfers with 3 topics are ERC-20 and are dropped; only 4-topic logs are NFTs. Rows go to `nft_mints`, `nft_burns`, `nft_seadrop_mints`, `nft_seadrop_config`, `nft_sales` and `nft_launches`, and a rollback deletes the ones above the fork block.

**The `sub` column.** One log can yield several events, so `indexer.events` has a `sub` column (default `''`) and the unique key is `(tx_hash, log_index, sub)`. Launchpad events keep `''`. Milestones use `mint:<kind>:<stage index or mark>`, and sales use `sale:<token id>` (with the contract appended when one transaction sells two collections). Payloads keep the real `txHash` and `logIndex`. The same migration adds an index on `(type, entity, id)` for per-collection reads.

**Sales.**
- Each `OrderFulfilled` becomes one `nft.sale` per ERC-721 or ERC-1155 item.
- The price is the ETH or WETH on the side opposite the NFTs: the consideration for a filled listing, the offer for an accepted offer. It is split evenly across the NFT items. Summing both sides would double-count fees on accepted offers. Orders paid in another currency, with no payment item, or with NFTs on both sides are skipped.
- When the NFT is in the order's offer, the seller is the offerer and the buyer the recipient. When it is in the consideration, the buyer is the offerer and the seller the recipient.
- Matched orders: when one transaction fills a buyer's offer against the seller's order, the same NFT is in two `OrderFulfilled` logs. They are merged into one sale. The buyer is the offerer of the order with the NFT in its consideration, the seller is the offerer of the order with the NFT in its offer, and the price is the buyer order's payment. The buyer order's `txHash` and `logIndex` are kept. An NFT in three or more orders of one transaction is not merged (one transaction in three days; those were separate sales).
- ERC-1155 sales with a quantity above 1 report the price per unit.

**Chimera.** A `CampaignCreated` log writes `nft_launches`, emits `nft.launch` and makes the collection `continuous` with launchpad `chimera` from its first block. The backfill for this filter starts at the factory's deploy block, 57,096,880.

**Mint milestones.** For each SeaDrop contract in a batch, the source reads `getMintStats` at the batch's end block for the current supply and max supply, and emits `nft.mint` events when the supply crosses 25%, 50% or 75% of the max supply, at sell-out, and at the first mint of a stage. If the read fails, the contract gets no milestones until a read succeeds. Collections without SeaDrop have progress marks only where a max supply is known.

**Scheduled stage starts.** A stage on the stored drop schedule is announced when its start time passes, without waiting for its first mint: a job looks every 30 seconds and writes an `nft.mint` `stage_start` event stamped with the scheduled start, together with the stage's row, so the stage's first mint announces nothing more. A stage whose start passed more than 10 minutes before the job saw it is not announced this way. A stage with no known on-chain index gets 100 plus its place in the drop's order. A stage that never starts on schedule (the drop page changed after it was stored) is announced by its first mint.

**Legacy collections.** A collection is `legacy` when it minted before the indexer's NFT history starts, so its mint data is incomplete and it has no mint events. The check runs once per collection, at its first stored mint: `totalSupply()` at the block before that mint is above zero. If the contract has no `totalSupply()`, it is legacy when it already had code at the block before the history start. A Chimera collection or a manual kind skips the check. The history start is `NFT_HISTORY_START_BLOCK`, or else the lower of the earliest stored first-mint block and the earliest stored mint.

## Consequences

- A new protocol is a new `Source`; the loop, cursor and rollback do not change.
- Readers on the first event schema keep working: they ignore types they do not know, and `(tx_hash, log_index, sub)` still holds `(tx_hash, log_index)` unique for launchpad events.
- Address-less mint and burn filters fetch every ERC-721 and ERC-1155 mint on Ink, which is about 232,000 logs a day.
- The code-presence fallback calls a contract that was deployed before the history but first minted after it `legacy`. Comparing stored mints with token ids would tell the two apart.
- The deploy migration rebuilds the events unique constraint and adds an index over the whole events table. It takes a lock on `indexer.events` for its duration.
