# 0013. Endpoint outages: bench, retry or fail fast

Date: 2026-10-09
Status: Accepted

## Context

The indexer holds one WebSocket per endpoint. viem's keepalive ping and request path report a dead socket as `WebSocketRequestError` or `SocketClosedError`, and a stalled socket as `TimeoutError`. After a host sleep or network drop every endpoint can be down at once, and the fallback transport then returns the last endpoint's error to the caller.

## Decision

- Bench: a socket error from an `eth_getLogs` or `eth_blockNumber` call on a log transport is logged as a warning and benches that transport for 60 seconds at once, without changing its range. Request timeouts there keep the range-halving behaviour of ADR 0010.
- Retry: block and state reads (block number, block, launch states, total supplies, token metadata) that fail with a socket error or a request timeout, including when either is the cause of a contract-call error, are logged and retried with a 1 to 30 second backoff, one warning per retry. Retrying stops once shutdown has begun and the last error is rethrown.
- Fail fast: every other error stops the process with exit code 1. That covers undecodable logs, reverts, JSON-RPC errors, and database errors.
- A SIGINT or SIGTERM exits 0. Failures after it starts are ignored, a second signal does nothing, and the running tick is awaited for up to 10 seconds before the database is closed.

## Consequences

- A network outage shows as repeated warnings and the indexer resumes by itself, with the cursor unchanged.
- A read that times out every time is retried indefinitely and visible in the logs.
- Data and database errors still surface immediately.
