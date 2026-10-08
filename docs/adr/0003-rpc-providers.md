# 0003. dRPC primary with Ink public endpoints as failover

Date: 2026-10-02
Status: Accepted

## Context

The indexer needs WebSocket subscriptions on Ink mainnet. [Ink's RPC docs](https://docs.inkonchain.com/tools/rpc) list several providers with WebSocket support.

## Decision

Use dRPC (`wss://ink.drpc.org`) as the primary endpoint and Ink's public QuickNode and Gelato endpoints as failover, behind one transport that rotates on errors.

## Consequences

- Free to start.
- Failover is built in from v0.
- RPC is the cost line most likely to grow; a paid tier is the first upgrade.
