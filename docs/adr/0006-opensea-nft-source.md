# 0006. OpenSea API v2 and Stream API for NFTs

Date: 2026-10-02
Status: Accepted. Amended by ADR 0017.

Amended by ADR 0017: Blockscout is not used. Chain data comes from Ink RPC logs, and the Stream feeds listings.

## Context

Ink is a supported OpenSea chain ([chains](https://support.opensea.io/en/articles/8867082-which-blockchains-are-compatible-with-opensea)). Instant API keys allow 600 reads per hour ([API keys](https://docs.opensea.io/reference/api-keys)).

## Decision

Use OpenSea API v2 with chain slug `ink` for collections and stats, the Stream API for live sales and listings, and Blockscout token transfers as fallback (superseded, see ADR 0017). Request a full API key.

## Consequences

- Listings and floor data come from the marketplace that holds them.
- Stream outages fall back to on-chain transfers, which cover sales but not listings (superseded, see ADR 0017: the chain sources in ADR 0016 provide sales).
