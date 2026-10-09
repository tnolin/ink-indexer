# 0009. InkyPump hook discovery

Date: 2026-10-08
Status: Accepted

## Context

InkyPump V2 runs one hook contract per deployment. On Ink there are two native hooks and one hook per xStocks asset. All of them emit the same events. Native hooks were deployed through the generic CREATE2 deployer, so nothing on-chain lists them. xStocks hooks are created by two factories that emit an event naming each new hook.

## Decision

- Native hooks are listed in `packages/sdk/src/inkypump/deployments.ts`.
- xStocks hooks are registered from the factories' hook-created events, which the indexer reads in the same `eth_getLogs` call as hook events.
- The log filter is by topic only, with no address filter. Events from contracts that are neither a known hook nor a known factory are ignored, and the indexer logs a warning once per address. A new native hook therefore shows up at its first launch.

## Consequences

- New xStocks hooks need no code change.
- A new native hook needs a config entry, a release and a `backfill --from <its start block>`.
- Contracts that copy InkyPump's event signatures never reach the events table.
