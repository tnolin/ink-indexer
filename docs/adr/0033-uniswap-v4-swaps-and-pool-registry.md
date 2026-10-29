# 0033. Uniswap v4 swaps and the pool registry

Date: 2026-10-29
Status: Accepted

## Context

An InkyPump token trades on its bonding curve until it bonds, then in a Uniswap v4 pool. The indexer stopped at the bond: `launchpad.trade` covers the curve only, so a bonded token had no price, market cap or trader after the bond. Other launchpads put tokens in v4 pools too, some from their first block.

Every swap on the PoolManager is one log. Most belong to pools the indexer does not track, and a response that held them all would be far larger than the tracked part.

## Decision

**One decoder, any PoolManager.** `decodeSwap` reads the PoolManager `Swap` event whichever contract emitted it. Pool identity is the pool id and the manager's address, both kept in the registry.

**A registry fed by launchpad sources.** `indexer.pools` holds one row per tracked pool: id, manager, token, launchpad, quote asset, the token's currency side and the block it was created in. `PoolRegistry` is its in-memory copy, shared by the sources. The InkyPump source registers a pool when it processes a bond and reloads the registry after a rollback. Migration 0015 seeds the table from past `launchpad.bond` events.

**Two requests with topic filters.** The `v4-swaps` source reads swaps with a PoolManager filter on `[Swap, poolIds]` and burns with a `Transfer` filter on the token addresses with the dead address as recipient. The topics past position 0 differ from every other filter's, so each is its own request, and the responses hold only tracked logs. A span that contains a bond makes one more `eth_getLogs` for that pool's swaps in the same span, because the span's requests were built before the bond was processed.

**The trader is the transaction sender.** A swap log names the router that called the PoolManager, not the wallet. One `eth_getBlockByNumber` with transactions per block that holds a tracked swap maps each transaction hash to its sender. A trade made through a smart wallet shows the bundler.

**Market cap is on circulating supply.** Supply is `totalSupply` minus the dead address's balance. The balance is read once per token, then kept current from `Transfer` logs to the dead address. A reorg re-reads it at the fork block. Market cap is the pool price times that supply, in quote base units.

**Liquidity is the quote side.** `quoteLiquidity` is computed from the pool's in-range liquidity `L` and the price `√P`. It is exact for a pool whose liquidity is full range and approximate when other positions exist.

**The ath is one figure per token**, in quote base units, covering curve trades and pool swaps. `indexer.tokens.ath_market_cap` holds it, and a rollback restores it to the highest market cap among the events that remain.

## Consequences

- Each span makes two more `eth_getLogs` calls once a pool is registered, one `eth_getBlockByNumber` per block with a tracked swap, and one `eth_blockNumber` plus one balance multicall for each newly bonded token. The measured totals are in the pull request that introduced this source.
- The request carries every tracked pool id, so its size grows with the number of bonded tokens.
- On a database with no registered pool, the swaps of the first bond that fall in its own span are missed.
- Backfill: `pnpm backfill --sources v4-swaps` reads swaps and burns for the pools in the registry. The cost is about one `eth_getBlockByNumber` per block with a tracked swap, plus two `eth_getLogs` per span.
- A token whose pool was seeded by the migration has its dead balance read at head, so backfilled swaps use today's burned amount.
