# 0005. Index both Tsunami factories from the official docs

Date: 2026-10-02
Status: Accepted

## Context

Tsunami has two factory contracts. Its docs publish addresses and an events reference ([addresses](https://docs.tsunami.trade/#/reference/addresses), [events](https://docs.tsunami.trade/#/reference/events)).

## Decision

Index both factories: `0x5934a5C377309453746EE8aa5194F671930c09fa` and `0x1fC16511f5Fa4b4C1591ffeB8C38AFfc367076f1`. Track `TokenLaunched` and `PoolCreated` on the factories, and `TokenBought`, `TokenSold` and `TokenMigrated` on curves. `TokenMigrated` marks graduation to Calamari (PoolManager `0x6E4723A612831AfB9f5B2a5aE22723c37aAB9560`).

## Consequences

- Full launch coverage on Tsunami.
- Graduated tokens hand off to the Calamari source.
