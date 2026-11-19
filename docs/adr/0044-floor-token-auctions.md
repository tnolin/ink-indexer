# 0044. Floor-token auctions

Date: 2026-11-19
Status: Accepted

## Context

A collection's floor token can be sold in a Uniswap continuous clearing auction: a factory creates an auction contract, the seller sends it the tokens, bidders submit bids over a block range, the clearing price rises as demand fills, and after the end block bidders exit and claim. The factory also creates auctions for tokens that have nothing to do with NFTs. Most of an auction's state, the checkpoint, the amount raised, whether it graduated and the clearing price, is updated lazily: the contract changes it only when someone calls it, so a log-only reader sees stale values.

## Decision

**Every auction the factory creates is stored, with its bids.** `AuctionCreated` stores the auction, its token, currency, block range, starting price, required raise, the amount it was told to sell, and the sender and target of the creating transaction. `TokensReceived`, `BidSubmitted`, `BidExited` and `TokensClaimed` are read from every stored auction. Bids, exits and claims are stored in `nftx_auction_bids`.

**Only some auctions are announced.** An auction is kept, and emits `nft.auction`, when all of these hold:

- its token is a collection's NFTX floor token;
- the sender of its creating transaction is the collection's creator, the NFT contract's `owner()`, or NFTX's launchpad (as the sender or the target);
- its currency is the zero address (ETH);
- the amount it sells is at least half of the floor token's supply at the creation block;
- it is the collection's first such auction.

`pnpm nft:auction <auction> <contract>` keeps an auction by hand, for one the check missed. A hand-kept auction survives a rollback. A kept auction is re-read from the database on every batch, so a link made by another process is announced at the next batch without a reload.

**One event type, four phases.** `created` is written when the auction is kept; `live` at `max(startBlock, the block the tokens arrived)`; `price` for each clearing price update from the start block up to the end block, and never for one after it; `ended` at the end block. Each phase is written once, and the id is `nftx:auction:<auction>:<phase>:<block>`, with the log index for a phase tied to a log.

**Lazy state is read as of a block.** `live`, `price` and `ended` read the auction's `checkpoint()`, `currencyRaised()`, `totalCleared()`, `isGraduated()` and `clearingPrice()` in one multicall as an `eth_call` at the event's block, with the checkpoint advanced, so the numbers are what the contract holds at that block. For `ended` that block is the end block. An auction that did not graduate refunds every bid, so its `ended` event reports `cleared` as `"0"`. When a `live` block has no checkpoint yet, the event reports the starting price and zero raised. A `price` or `ended` block with no checkpoint to read stops the batch, and the batch is retried.

**Prices are per NFT.** The auction's Q96 price times 10^18 over 2^96, rounded down. `currency` is `"ETH"` for the zero address and the lowercase address otherwise; the indexer does not read a token's `symbol()`.

**Late and reorganised.** An auction kept after its collection exists, for instance because the collection was created later, emits `created` at the block of the batch that kept it, and its other phases follow in block order. A rollback deletes the bids, auctions and phases above the fork block, unkeeps an auction that was kept above it (a hand-kept one stays), and clears the phase markers above it, so the phases are written again on the new chain.

## Consequences

- Readers get a complete history of a collection's floor-token sale, from the first bid to the clearing price at the end, with correct raised and cleared amounts.
- Auctions that are not about an NFTX collection are stored but never announced, at the cost of reading their logs.
- `readAuctionCheckpoint` costs one `eth_call` per `live`, `price` or `ended` event; a long auction with many price updates makes that many calls.
