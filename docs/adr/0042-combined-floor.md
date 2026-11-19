# 0042. Combined floor

Date: 2026-11-19
Status: Accepted

## Context

A collection with an NFTX market can be bought two ways: at the lowest OpenSea listing, or from the NFTX pool at its spot price. The cheapest way to buy one NFT is the lower of the two, and a floor that shows only OpenSea's price overstates it whenever the pool is cheaper. The pool also moves on every trade, far more often than OpenSea's stats are polled.

## Decision

**The floor is the lower of the two.** For a collection whose NFTX pool is open and not sunset, `floorWei` in `nft.stats` and `nft.listing` is the lower of the newest OpenSea floor and the pool's spot price; a tie goes to OpenSea. `floorMarket` says which one won, `nftxFloorWei` is the pool price, `poolCount` the NFTs in the pool and `nftxSlug` the collection's name in NFTX's URLs. A collection with no NFTX market keeps the OpenSea floor and the fields stay absent.

**Rows keep both parts.** An `nft_stats` row stores the combined `floor_wei`, the OpenSea floor alone in `os_floor_wei`, and the pool price in `nftx_floor_wei`. Rows written before NFTX carry the raw OpenSea floor in `floor_wei` and a null `floor_market`, so the newest OpenSea row speaks for the OpenSea part of any collection.

**Pool moves are announced.** A pool price that moves 1% or more from the last announced price, or the first price of a collection, writes an `nft_stats` row with its block and emits `nft.stats` with `source: "chain"`. The pool size is read at that block. Owners, volume and sales are copied from the newest OpenSea row at or before the move's time, and are null when there is none. A price that is not defined is never announced. A backfill over blocks the live tick already announced compares against the rows before them, so the same moves qualify again and give the same rows.

**History.** `floor24hAgoWei` is the combined floor from the stats history. The history is combined from the first combined row written live (`combined_since`), and a backfill does not start it. Rows with a block are removed by a rollback, so a reorg cannot leave a price that never was.

**Listings.** An `nft.listing` event for a collection with an NFTX market carries the combined floor. When it is the pool's, `floorAt` is the event's own time, because the pool's price holds until its next trade.

## Consequences

- A consumer that reads `floorWei` gets the price at which one NFT can be bought now, without knowing which market it is on. A consumer that needs the OpenSea floor alone reads `os_floor_wei` or `floorMarket`.
- A trade-heavy pool emits at most one `nft.stats` per 1% move, not one per swap.
- Pool prices are rounded down, so two readers that apply the formula to the same log get the same number.
