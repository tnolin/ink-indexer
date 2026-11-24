# 0046. Launchpad auctions and the second Locker

Date: 2026-11-24
Status: Accepted

## Context

NFTX's launchpad runs a collection's launch from one transaction. It creates the collection through the Locker, mints a separate ERC-20 claim token for it, and starts a Uniswap continuous clearing auction that sells the claim token. After the auction settles, each whole claim token is exchanged for a newly minted NFT and any fraction is paid in the floor token. The launchpad logs `LaunchCreated` with the collection, its creator, the floor token, the claim token and the auction. The auction may be paid in ETH or in an ERC-20 the NFTX hook allows as a pair token.

Floor-token auctions (ADR 0044) are kept only when they sell the collection's floor token for ETH and were started by the collection's creator, its owner or the launchpad. A launchpad auction sells neither, so none of those checks can hold for it.

The launchpad works with a second Locker, deployed in block 61,714,955 with its own hook and Listings contract. Its events match the first Locker's. The first Locker has created no collection since the second was deployed.

## Decision

**The launchpad is watched.** `LaunchCreated` is accepted only from the launchpad address. The auction it names is the collection's own, because the launchpad created both in one transaction. When that auction is in the factory's creations and sells the claim token the log names, it is kept for the launch's collection at once. No floor-token, currency, supply, sender or first-auction check applies. The launch's collection is marked `launchpad_created` and so gets the automatic `real` verdict, whoever sent the transaction. Auctions outside the launchpad follow ADR 0044 unchanged.

**The event reports what was sold.** For a launchpad auction `token` is the claim token, and `currency` is `"ETH"` or the currency's lowercase address. One claim token is one NFT, so the per-NFT prices, the supply and the cleared amount keep their meaning. Prices and raised amounts are in the currency's smallest unit.

**Both Lockers are read.** The Lockers, hooks and Listings contracts of both generations are in one list, and each kind of log is accepted from any contract of its kind. A Listings read goes to the contract that logged the listing. A collection's pool size is read from the Locker and Listings contract of its generation, which its creation block names, because the first Locker creates nothing after the second's first block.

## Consequences

- A launchpad auction is announced from its creation through its end, in whatever currency it sells.
- Prices of a non-ETH auction are in that currency's units, so a consumer must read the currency's decimals before it shows an amount.
- A third Locker that runs beside the second needs the Locker stored with each collection.
- Zaps of the second Locker are not read; a trade made through one is not announced.
