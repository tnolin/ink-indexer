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

## NFT events

`nft.*` events share a base instead of the `launchpad`, `token` and `launchId` fields: `v`, `type`, `chainId`, `contract` (the collection, also the row's `entity`), `source`, `txHash`, `logIndex`, `blockNumber` and `blockTimestamp`.

- `source: "chain"` events have a real `txHash` and `logIndex`, and `blockTimestamp` is the block time.
- `source: "opensea"` events have a synthetic `txHash` (`os:list:<order hash>`, `os:col:<contract>:<n>`, `os:drop:<contract>:<n>`, `os:stats:<contract>:<n>`), `logIndex` 0, and `blockTimestamp` is the receipt time. `blockNumber` is the chain's latest ingested block when the event was received. After a reorg the row, and `blockNumber` with it, moves to the fork block rather than being deleted.
- Wei amounts are decimal strings. Fields that OpenSea or the chain may not give are `null`.

### `nft.collection`

A snapshot, written at discovery and whenever a field changes.

```json
{
  "v": 1, "type": "nft.collection", "chainId": 57073,
  "contract": "0x00000000000000000000000000000000000000a1", "source": "opensea",
  "txHash": "os:col:0x00000000000000000000000000000000000000a1:3", "logIndex": 0,
  "blockNumber": "58966378", "blockTimestamp": 1790000000,
  "slug": "example-collection", "name": "Example", "imageUrl": "https://img/x.png",
  "links": { "twitter": "example", "website": "https://example.xyz", "discord": null },
  "standard": "erc721", "kind": "drop", "verdict": "real",
  "gates": { "page": "pass", "structure": "pass", "traits": "pending", "farm": "pass", "farmShareBps": 410 },
  "manual": false, "safelist": "not_requested", "maxSupply": "2222", "seadrop": true,
  "openseaUrl": "https://opensea.io/collection/example-collection",
  "rarityCalculatedAt": 1790000000, "maxRank": 2222,
  "launchpad": null, "launchToken": null,
  "creator": { "address": "0x00000000000000000000000000000000000000c1", "username": "maker", "verified": false }
}
```

- `kind` is `drop` (the collection has a mint phase), `continuous` (NFTs keep minting and burning with no stages, as in Chimera collections) or `legacy` (the mint finished before the indexer's NFT history, so there are no mint events).
- `verdict` is `real` when the collection passes the quality checks, `pending` while they are undecided, and `filtered` when one has failed. `gates` shows each check: `page`, `structure`, `traits` and `farm` are `pass`, `fail` or `pending` (`structure` and `farm` are `n/a` where they do not apply), and `farmShareBps` is the share of minters that are farm wallets. `manual` is true when the verdict or kind was set by hand.
- `creator` is `null` while unknown, and absent on snapshots written before the field existed, so test with `== null`.

### `nft.drop`

```json
{
  "v": 1, "type": "nft.drop", "chainId": 57073,
  "contract": "0x00000000000000000000000000000000000000a1", "source": "opensea",
  "txHash": "os:drop:0x00000000000000000000000000000000000000a1:1", "logIndex": 0,
  "blockNumber": "58966378", "blockTimestamp": 1790000000,
  "slug": "example-collection", "maxSupply": "2222",
  "stages": [
    { "type": "signed_presale", "label": "GTD", "priceWei": "0", "startTime": 1790003600, "endTime": 1790014400, "maxPerWallet": 2, "allowlistCount": 588 },
    { "type": "public_sale", "label": "Public", "priceWei": "500000000000000", "startTime": 1790025200, "endTime": null, "maxPerWallet": null, "allowlistCount": null }
  ]
}
```

`stages` is ordered by start time. Times are unix seconds.

### `nft.mint`

A mint milestone: `stage_start`, `progress` or `sold_out`. A contract that had items minted before the indexer's first stored mint for it gets no `stage_start` or `progress` events, only `sold_out`.

```json
{
  "v": 1, "type": "nft.mint", "chainId": 57073,
  "contract": "0x00000000000000000000000000000000000000a1", "source": "chain",
  "txHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "logIndex": 7,
  "blockNumber": "58966378", "blockTimestamp": 1790000000,
  "kind": "progress", "stageIndex": 0, "stageLabel": "Public", "stagePriceWei": "500000000000000",
  "markBps": 5000, "minted": "1111", "maxSupply": "2222",
  "mintStartTs": 1789995000, "stageStartTs": 1789995000, "minters": 612
}
```

`markBps` is 2500, 5000 or 7500 on `progress` and `null` otherwise. `minters` counts distinct recipients in the indexer's mint history, which spans at most 8 days. A `sold_out` event also has `stageCounts`: `{ stageIndex, label, minted }` per stage. A `stage_start` can come from the schedule before any mint (its `txHash` is then `nft:stage:<contract>:<index>`).

### `nft.listing`

A listing that passed the indexer's filter: public, paid in ETH or WETH, open for at least an hour, and priced below the last listing written for that item.

```json
{
  "v": 1, "type": "nft.listing", "chainId": 57073,
  "contract": "0x00000000000000000000000000000000000000a1", "source": "opensea",
  "txHash": "os:list:0x1111111111111111111111111111111111111111111111111111111111111111", "logIndex": 0,
  "blockNumber": "58966378", "blockTimestamp": 1790000000,
  "tokenId": "4405", "priceWei": "44000000000000000", "currency": "ETH",
  "maker": "0x00000000000000000000000000000000000000b1", "expiresAt": 1790021600,
  "orderHash": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "itemName": "Example #4405", "imageUrl": "https://img/4405.png",
  "floorWei": "42000000000000000", "floorAt": 1789998000,
  "rank": 41, "maxRank": 4440
}
```

`priceWei` is per unit. `rank` is OpenSea's rarity rank. It is fetched only for listings priced at or under the floor plus 10%, so it is `null` for the rest, and `null` where OpenSea has no rank.

### `nft.sale`

One event per NFT item in a Seaport fill.

```json
{
  "v": 1, "type": "nft.sale", "chainId": 57073,
  "contract": "0x00000000000000000000000000000000000000a1", "source": "chain",
  "txHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "logIndex": 12,
  "blockNumber": "58966378", "blockTimestamp": 1790000000,
  "tokenId": "4405", "priceWei": "44000000000000000", "currency": "ETH",
  "buyer": "0x00000000000000000000000000000000000000b2", "seller": "0x00000000000000000000000000000000000000b1",
  "orderHash": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "itemName": "Example #4405", "imageUrl": "https://img/4405.png",
  "rank": 41, "maxRank": 4440, "floorWei": "42000000000000000"
}
```

- The price is the ETH or WETH paid on the side opposite the NFTs, split evenly across the items, and per unit for ERC-1155.
- When a buyer's offer is filled against the seller's order in one transaction, the NFT is one sale. The buyer is the offerer of the order that has the NFT in its consideration, the seller is the offerer of the order that has it in its offer, and the price is the buyer order's payment.
- `floorWei` is the latest known floor and can be `null`.

### `nft.stats`

```json
{
  "v": 1, "type": "nft.stats", "chainId": 57073,
  "contract": "0x00000000000000000000000000000000000000a1", "source": "opensea",
  "txHash": "os:stats:0x00000000000000000000000000000000000000a1:18", "logIndex": 0,
  "blockNumber": "58966378", "blockTimestamp": 1790000000,
  "floorWei": "42000000000000000", "floor24hAgoWei": "40000000000000000",
  "owners": 731, "volume24hWei": "3500000000000000000", "sales24h": 64,
  "totalSupply": "2222", "maxSupply": "2222", "listedCount": 120, "listedCapped": false
}
```

`floor24hAgoWei` comes from the indexer's own stats history and is `null` under 24 hours of history. `listedCount` is `null` when not counted; it stops at 300 with `listedCapped` true.

### `nft.launch`

A Chimera campaign was created. `contract` is the collection.

```json
{
  "v": 1, "type": "nft.launch", "chainId": 57073,
  "contract": "0x00000000000000000000000000000000000000a1", "source": "chain",
  "txHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "logIndex": 4,
  "blockNumber": "58966378", "blockTimestamp": 1790000000,
  "launchpad": "chimera", "campaignId": "5",
  "token": "0x00000000000000000000000000000000000000d1", "tokenSymbol": "EXA", "tokenName": "Example",
  "creator": "0x00000000000000000000000000000000000000c1",
  "poolId": "0x2222222222222222222222222222222222222222222222222222222222222222"
}
```

## Identity

`(txHash, logIndex)` is the stable identity of a launchpad event. One log can yield several NFT events (a sweep sells many items in one log, and one SeaDrop log can cross two mint milestones), so an NFT event's identity is the row's `(tx_hash, log_index, sub)`, and deduping NFT events on `(txHash, logIndex)` would drop real events. A consumer that reads only payloads can use:

| Event | Identity from the payload |
| --- | --- |
| `launchpad.*` | `txHash`, `logIndex` |
| `nft.sale` | `txHash`, `logIndex`, `contract`, `tokenId` |
| `nft.mint` | `txHash`, `logIndex`, `kind`, and `markBps` (for `progress`) or `stageIndex` (for `stage_start`) |
| `nft.launch` | `txHash`, `logIndex` |
| OpenSea-derived events (`nft.collection`, `nft.drop`, `nft.listing`, `nft.stats`, and stage starts from the schedule) | `txHash`, which is a unique synthetic id |

The table's `id` can change after a reorg rollback, because rolled-back chain events are deleted and the new fork's events are inserted with new ids, so dedupe on these identities and not on `id`.

## Confirmation

The indexer writes events as soon as their block is seen, with `confirmed = false`, and marks them confirmed one block later. Consumers choose whether to act on unconfirmed events.

Confirmed is not final. A reorg rollback deletes every chain row above the fork point, up to 128 blocks back, confirmed rows included, and the new fork's events are inserted with new ids. Off-chain `os:` and `nft:` rows are moved to the fork block, unconfirmed, and keep their ids (see [ADR 0018](../../docs/adr/0018-off-chain-events.md)). Identify events as the [Identity](#identity) table says, and treat events within the last 128 blocks of the chain head as revisable.
