# 0045. Listings carry no minimum lifetime

Date: 2026-11-19
Status: Accepted. Supersedes item 3 of the listing filter in [ADR 0017](0017-opensea-source.md).

## Context

ADR 0017 dropped an OpenSea listing that lived under an hour (expiry minus listing time), and the NFTX source applied the same rule to the time left on a listing. A short listing priced under the floor is still buyable for as long as it is open, so an alert for it is useful. The other listing filters already keep the stream small. On OpenSea, a maker who relists one item again and again is limited by the rule that a listing must be lower than the last price written for that item.

## Decision

An OpenSea or NFTX listing is announced whatever its expiry. Every other filter stays. For OpenSea:
- the listing is not private;
- it is priced in ETH or WETH;
- for ERC-1155, the price is per unit;
- it is lower than the last price written for that item.

An NFTX listing is announced when its pool has a price.

`LISTING_MIN_LIFE_S` is removed.

## Consequences

- Listings that expire within the hour now produce `nft.listing` events. A consumer that wants to skip them compares `expiresAt` with the event's time.
- The per-item last-price state of OpenSea listings still expires with the listing, so a short listing does not hold its price longer than it is open.
