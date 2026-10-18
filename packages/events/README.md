# @ink-indexer/events

Typed, versioned event schema for ink-indexer. These are the payloads in the indexer's `indexer.events` table and the contract for anything that reads it. MIT licensed.

Every event has `v` (schema version, currently `1`), `type`, `chainId` (57073), `txHash`, `logIndex`, `blockNumber` (decimal string) and `blockTimestamp` (unix seconds). `launchpad.*` events also have `launchpad`, `token` and `launchId`. `nft.*` events have `contract` and `source` (`chain` or `opensea`; `txHash` is a synthetic id for OpenSea events) and are typed as `NftEvent`. Addresses and hashes are lowercase. Amounts are decimal strings in base units.

## `launchpad.launch`

```json
{
  "v": 1, "type": "launchpad.launch", "chainId": 57073, "launchpad": "inkypump",
  "token": "0x00000000000000000000000000000000000000d1",
  "launchId": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "txHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "logIndex": 3, "blockNumber": "45300000", "blockTimestamp": 1790000000,
  "hook": "0x893183da2411c7df81f103bfef09e4e46c326ac4",
  "creator": "0x00000000000000000000000000000000000000c1",
  "name": "Shark", "ticker": "FIN", "description": null, "imageUrl": "https://img/x.png",
  "links": { "telegram": null, "twitter": "https://x.com/fin", "website": null },
  "quoteAsset": "0x0000000000000000000000000000000000000000",
  "targetRaise": "1000000000000000000", "totalSupply": "1000000000000000000000000000"
}
```

`quoteAsset` is the zero address for ETH-quoted launches, or the xStocks wrapper token for stock-quoted launches.

## `launchpad.trade`

```json
{
  "v": 1, "type": "launchpad.trade", "chainId": 57073, "launchpad": "inkypump",
  "token": "0x00000000000000000000000000000000000000d1",
  "launchId": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "txHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "logIndex": 3, "blockNumber": "45300000", "blockTimestamp": 1790000000,
  "side": "buy", "trader": "0x00000000000000000000000000000000000000e1",
  "tokenAmount": "7", "quoteAmount": "9", "price": "1000",
  "curveValue": "500000000000000000", "target": "1000000000000000000",
  "progressBpsBefore": 1234, "progressBpsAfter": 5000, "soldBps": 5000,
  "marketCap": "1000000000000",
  "quoteAsset": "0x0000000000000000000000000000000000000000"
}
```

- `quoteAmount` is the gross amount paid on a buy and the net payout on a sell.
- `price` is the price the contract reports with the trade, in quote base units per whole token. `marketCap` is `price × totalSupply / 10^18`.
- `curveValue` is the bonding curve's own value at the new tokens-sold figure. A launch bonds when it reaches `target`, so `progressBps = curveValue × 10000 / target`, from 0 to 10,000. It can differ from the contract's `raised` field, which on newer InkyPump hooks also counts buy fees.
- `soldBps` is tokens sold over sale supply in basis points (capped at 10,000) and is the figure inkypump.com displays for curve tokens.
- `progressBpsAfter` tracks value raised on the curve, and both `soldBps` and `progressBpsAfter` reach 10,000 at bond.

## `launchpad.bond`

```json
{
  "v": 1, "type": "launchpad.bond", "chainId": 57073, "launchpad": "inkypump",
  "token": "0x00000000000000000000000000000000000000d1",
  "launchId": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "txHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "logIndex": 3, "blockNumber": "45300000", "blockTimestamp": 1790000000,
  "poolId": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "liquidityQuote": "2", "liquidityTokens": "3",
  "quoteAsset": "0x0000000000000000000000000000000000000000"
}
```

## Identity

`(txHash, logIndex)` is the stable identity of an event. The table's `id` can change after a reorg rollback, because rolled-back events are deleted and the new fork's events are inserted with new ids, so consumers dedupe on `(txHash, logIndex)`.

## Confirmation

The indexer writes events as soon as their block is seen, with `confirmed = false`, and marks them confirmed one block later. Consumers choose whether to act on unconfirmed events.

Confirmed is not final. A reorg rollback deletes every row above the fork point, up to 128 blocks back, confirmed rows included, and the new fork's events are inserted with new ids. Dedupe on `(txHash, logIndex)` and treat events within the last 128 blocks of the chain head as revisable.
