# 0041. NFTX source

Date: 2026-11-19
Status: Accepted

## Context

NFTX turns an NFT collection into a fungible floor token and a Uniswap v4 pool. A collection is created in the Locker, opens trading when its pool is initialized, and then trades three ways: a holder sells an NFT to the pool or buys a floor NFT from it, a holder lists an NFT in the Listings contract at a multiple of the pool price, and a buyer fills listings, often through a Zap that pays in ETH. Every one of these is an NFT market event, and the pool's price is a floor that OpenSea does not show. The indexer had no view of any of it, and NFTs that were deposited into the Locker looked like holders leaving or minting wallets churning.

## Decision

**A `nftx` source reads the NFTX contracts.** One address-bound filter covers the Locker, both Zaps, the royalty gate, the Listings contract and the hook. A log is accepted only from the contract that emits its kind, so a look-alike log from any other address is dropped. The platform and backfill name is `nftx`, and it is part of the default `INDEXER_SOURCES`.

**Collections and pools.** `CollectionCreated` stores the collection, its floor token and its name, and gives the collection a snapshot before any mint is indexed. `CollectionInitialized` stores the pool key, which side flETH is on and how many NFTs were seeded, writes an `nft_launches` row and emits `nft.launch` with `launchpad: "nftx"`. A pool whose hook is not the NFTX hook, or that has no flETH side, is stored without a side, writes no launch and logs one warning. Launches are keyed by collection and launchpad, so a collection can have a Chimera launch and an NFTX launch; rolling either back restores the other.

**Pool prices.** Each `PoolStateUpdated` writes one `nftx_prices` row. The price is wei per NFT, `10^18 · 2^192 / sqrtPriceX96²` when the pool pairs the floor token with flETH as currency0 and the inverse otherwise, rounded down; a price that is not defined is stored as null. Logs after `CollectionSunset` add nothing.

**Sales.** One `nft.sale` is written per item, with `market: "nftx"` and a `via`:

- `listing`: a listing was filled or relisted. The buyer is the recipient of the item's `TokenWithdrawal`, and the seller is the listing's owner (the Locker for a floor item, whose owner is zero). A Zap's `ethSpent` is split across the filled items in proportion to their listing prices; without a Zap each item is priced at its listing price times the pool's spot price. A relist pays the old owner and makes the new owner the buyer; a relist of a floor item pays nobody and is no sale.
- `instant_sell`: the item was sold to the pool, so the Locker is the buyer.
- `instant_buy`: a floor item was bought from the pool, so the Locker is the seller.

A transaction's total is split evenly across its items, rounded down, with the remainder on the last. An item is sold once per transaction: the first log that classifies it wins. A listing's record is read from the Listings contract one block before the transaction, because the fill removes it.

**Listings.** Each id of `ListingsCreated`, each relist and each floor-multiple update is announced as `nft.listing` with `market: "nftx"`. The price is the listing's floor multiple times the pool's spot price at the log. A listing is announced whatever its expiry; one whose pool has no price is not announced.

**The Locker and OpenSea sales.** A mint into the Locker, or to a wallet that deposits the token into the Locker in the same transaction, is not stored, counted toward milestones or counted as a minting wallet. A Seaport sale whose item reaches the Locker in the same transaction is stored with `toPool: true`.

**Names.** A collection's name in NFTX's web addresses is read from NFTX's public API, at most three lookups per batch and once per five minutes per collection. The slug is accepted only as lowercase letters, digits and hyphens, because it ends up in a URL, and a failed lookup never stops ingestion.

## Consequences

- NFTX markets appear as ordinary `nft.sale`, `nft.listing`, `nft.launch` and `nft.stats` events with optional fields, so readers that ignore the fields keep working. See `packages/events`.
- Collections that are on NFTX and not on OpenSea have a price and trades.
- The Locker's deposit logs are read by both the `nft-mints` and `nft-sales` backfill groups, because they decide which mints and sales are left out or marked.
- Migration 0019 adds the `nftx_*` tables and the market columns. Every statement adds a nullable column or a table, or loosens a constraint, so a binary from before it keeps working against the migrated schema.
