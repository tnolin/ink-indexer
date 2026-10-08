# 0002. Custom viem ingester over Envio HyperIndex

Date: 2026-10-02
Status: Accepted

## Context

Envio HyperIndex supports Ink and handles reorgs and factory-deployed contracts. Its free cloud tier deletes deployments after 30 days, and self-hosting needs a rate-limited HyperSync token ([Envio pricing](https://envio.dev/pricing)).

## Decision

Build a custom ingester on viem for v0: WebSocket subscriptions, backfill from the last processed block, confirmation tracking. Keep Envio as the upgrade path if volume outgrows it.

## Consequences

- No third-party hosting dependency or token limits.
- Reorg handling and backfill are our code to test.
- Source modules stay small enough to port to Envio handlers later.
