# 0039. Hookit source

Date: 2026-11-07
Status: Accepted

## Context

Hookit launches tokens through two kinds of factory. Master factories create a token that trades from its first block in a concentrated, single-sided Uniswap v4 pool under a Hookit hook, and a launch can open several pools, one per quote currency. The bonding factory (Classic) sells a token on a curve and, at graduation, moves it into a full-range pool under the graduated-fee hook. Five Master factories exist, all emitting the same events, and their numeric launch ids repeat across factories. Some hooks buy the token back in the pool, and some burn tokens by sending them to the zero address, so a token's supply falls over time.

## Decision

- **One filter.** The source reads a single topic-only filter for the Master and Classic launch events, the Master `MarketLaunched`, `LaunchConfigured` and `DevBuyExecuted`, and the Classic `Bought`, `Sold`, `HktHolderDrop` and `Graduated`. It has the same shape as the other launchpads' filters, so the log planner merges them into one `eth_getLogs` request.
- **Trust by emitter.** Master launch events are accepted from the five Master factories and Classic events from the Classic factory. Everything else is dropped with one warning per emitter address.
- **Launches per transaction.** A Master launch is spread over several logs. The source collects a transaction's `MarketLaunched`, `LaunchConfigured` and `TokenLaunched` logs and builds the launch at `TokenLaunched`, registering every market's pool before the dev-buy swaps that follow it in the same span. A launch's `launchId` is its token address padded to 32 bytes, since the factories' numeric ids repeat. A Master launch has `startsInPool` true and no `targetRaise` or sale supply, lists its hook modules in the order Hookit shows them, and carries `markets` when it has more than one pool.
- **Approval from the factory.** A token counts as approved when its launch event has `customHook` false. Each hook the source has not seen gets an `indexer.hooks` row of kind `hookit` as it appears, so a hook added later needs no migration.
- **Classic state from `tokensSold`.** The Classic events carry no curve state. The source reads the curve's starting reserves, supply and graduation quote once, at the launch block, and derives every later state from the net tokens sold. Progress (`soldBps` and `progressBpsAfter`) is the net quote raised over the graduation quote, capped at 10,000 and 10,000 at the trade that graduates. `HktHolderDrop` moves the curve but is not a trade: its tokens are added to the tokens sold and no event is written.
- **Trader.** The trader is the transaction's sender, read with one block fetch per block that holds Hookit logs. The dev-buy swap of a Master launch takes the buyer named by `DevBuyExecuted`, because the launch's creator can be a payout contract that does not send the transaction.
- **The hook's own swaps update state only.** A swap whose sender is its pool's own hook is a buyback. The `v4` source applies it to the pool's price and liquidity but writes no `launchpad.swap` event or trade, so a user's buy is not counted again. Swaps by the protocol's buyback contract are events, with that contract as their trader.
- **Burns lower supply.** For Hookit tokens the burn filter also takes transfers to the zero address, in the same request, and each one lowers the token's cached supply. A `total_supply_block` guards against counting a burn that is already in a supply read, and a process that starts following a token reads its supply again at the span's read block. Other launchpads are unaffected: Tsunami's vault inventory is already left out of its supply, and ink.fun's graduation burn is in the supply read at migration.
- **Range-aware liquidity.** `quoteLiquidity` is the quote amount inside the pool's tick range, computed from the in-range liquidity and the price clamped to the range, so a price outside the range leaves one side at zero. Swaps also carry the optional `tokenLiquidity`, the token amount inside the range. For a full-range pool the two sides are equal in value and the figures match the earlier formula.
- **Ath per pool.** For a token with more than one market the all-time-high market cap is kept for each pool, because the pools' quote currencies differ. A token with one market keeps one ath.
- **Metadata from `ipfs://` and inline JSON.** A launch's metadata URI is read from the token. A `data:application/json;base64,` URI of at most 8,192 characters is decoded in process; an `ipfs://` URI is fetched through `HOOKIT_IPFS_GATEWAY`. Any other URI leaves the launch without description, image and links. The description is cut at 4,000 characters, and the image is kept only as an `https` URL or an `ipfs://` link served through the gateway, and links only as `https` URLs or bare hosts.
- **Amounts in the quote's own units.** Every amount, price, market cap and liquidity is in the quote currency's base units; nothing is scaled to 18 decimals.
- **Storage.** Migration 0018 adds the `hookit` hook kind, makes `target_raise` and `sale_supply` nullable, adds `total_supply_block` to tokens, adds `hook`, tick bounds and per-pool ath columns to pools, creates `hookit_curves` for the starting reserves and tokens sold of Classic curves, and inserts the seven known hooks.
- **Platform.** `hookit` is a platform in `INDEXER_SOURCES` (on by default) and a backfill name; it also turns on `v4-swaps`. A backfill beside `start` follows ADR 0038.

## Consequences

- A Hookit launch adds no `eth_getLogs` request. A block that holds Hookit logs adds one block fetch for senders, and a launch block adds a supply read, a metadata URI read and, for an `ipfs://` URI, one gateway fetch.
- A token's market cap uses its current supply, so a token that burns reads lower than a figure computed on its launch supply.
- Concentrated liquidity is valued with the launch's tick range; positions a hook adds later at other ranges are counted as if they shared it.
- A dev buy made while a backfill runs beside `start` can be written by the live process first, with the transaction's sender as trader; the first copy stands.
