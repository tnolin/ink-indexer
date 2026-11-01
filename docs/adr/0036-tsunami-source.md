# 0036. Tsunami source

Date: 2026-10-31
Status: Accepted

Amends [0005](0005-tsunami-both-factories.md).

## Context

Tsunami launches tokens on a bonding curve of their own (one contract per launch) and graduates them into a pool in Calamari, a Uniswap v4 fork with its own PoolManager. Quote currencies vary per launch (ETH, USDC, wrapped BTC and stock tokens, with 6, 8 or 18 decimals). The indexer needs launches, trades and graduations as the same `launchpad.*` events the other launchpads produce, with each token's image, description and links from its IPFS metadata.

## Decision

- **One filter.** The source reads a single topic-only filter for `TokenLaunched` (both signatures), `TokenBought`, `TokenSold`, `TokenMigrated`, `CreatorPoolMigrated` and the PoolManager `Initialize`. It has the same shape as the other launchpads' filters, so the log planner merges them into one `eth_getLogs` request and a tick makes no extra request.
- **Both factories.** `TokenLaunched` is accepted from either factory. The second factory was paused shortly after it was created and has launched nothing; trusting it costs no request.
- **Trust by emitter.** `TokenBought`, `TokenSold`, `TokenMigrated` and `CreatorPoolMigrated` are accepted only from a curve the source has seen launched, and `TokenMigrated` only for that curve's own token. A Calamari `Initialize` counts only in a launch's own transaction for the launched token, as the source of that launch's hook, and only for Tsunami's hooks; the same topic from any other pool is dropped silently. Everything else is dropped with one warning per emitter address, and after 1,000 addresses one warning says there are more.
- **Curve state from the events.** Each curve event carries the whole post-trade reserves, so price, curve value, market cap and progress need no contract reads. Progress is the net quote raised over the raise target, which is what Tsunami's site shows, and is 10,000 at the closing trade whether the raised quote lands a few wei over or under the target.
- **Trader from the transaction.** The buyer in a curve event is the router or the factory. The trader is the transaction's sender, read with one block fetch per block that holds Tsunami logs.
- **Hook from the launch transaction.** A launch's hook is the one its own `Initialize` names. A launch without one uses the factory's current hook and logs a warning.
- **Bond from `TokenMigrated`.** The pool id is the hash of the pool key in the event, and the pool sits in Calamari's PoolManager. v4 orders a pool's currencies by address, so the token is currency0 in some pools and currency1 in others; the quote is the key's other currency. The supply is read at the migration block, stored on the token and given to the pool registry.
- **Pool moves.** `CreatorPoolMigrated` registers the destination pool for the same token with the same currencies. The source pool stays registered because its swaps are real. A move naming a pool that is not registered for that curve's token is ignored with one warning. No event is emitted: the schema has no field for it.
- **Supply without the Riptide inventory.** A Riptide launch mints a second supply to the Riptide vault, which trades it for 24 hours and then burns what is left. Supply for market cap is the total supply less the vault's balance, read at launch and again at graduation.
- **One swap request across PoolManagers.** The v4 source asks every PoolManager in the pool registry in one request and keeps a swap only when its emitter is its pool's PoolManager.
- **Metadata through a Tsunami gateway.** The IPFS document is fetched through `TSUNAMI_IPFS_GATEWAY`, before the launch event is built, for an `ipfs://` URI or an `https://<host>/ipfs/<cid>` URI; the URI's own host is never contacted, and any other URI leaves the launch without image, description and links. An image is kept only as an `https` URL of at most 2,048 characters without credentials, or an `ipfs://` link served through the gateway.
- **Amounts in the quote's own units.** Every amount, price, market cap and liquidity is in the quote currency's base units; nothing is scaled to 18 decimals.

## Consequences

- Enabling `tsunami` also enables `v4-swaps`.
- The vault's own buys, sells and burns after the launch and graduation reads are not counted in the supply.
- A quote currency that Tsunami enables later needs no change in the indexer; readers need its decimals.
