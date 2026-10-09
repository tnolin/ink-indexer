# 0014. HTTP reads with timeouts, error threshold and stall exit

Date: 2026-10-10
Status: Accepted

Supersedes the transport parts of ADR 0013.

## Context

The indexer runs on hosts that sleep and lose their network. Two long backfills ended badly after exactly that.

1. A dead WebSocket surfaced through viem's fallback transport on a tick read and stopped the process (fixed by ADR 0013's retry and bench rules).
2. The next run then sat for hours with no error and no exit. Reads were retried forever, but a retried request never returned. viem's WebSocket transport waits for a (re)connect with no timeout, so a half-open socket can hold a request open indefinitely, and no failover can happen while a request is open. The head watchdog kept logging while the cursor stood still.

## Decision

- Reads, state calls and `eth_getLogs` use HTTP. Each configured WebSocket URL gets an HTTP URL with the same path (`wss` becomes `https`); Ink's WebSocket-only Gelato host maps to its HTTP host. `INK_RPC_WS_URLS` stays the only endpoint setting.
- Every request has a hard 15 second timeout (abort-based, so it ends even if the endpoint never answers).
- viem's fallback moves a failed request to the next endpoint and re-ranks endpoints every 10 seconds by recent success and latency, so a dead endpoint stops being tried first. Per-endpoint log transports, ranges, benching and head clamping (ADR 0010) are unchanged and now run over HTTP.
- WebSocket is used only for the `newHeads` subscription. Its failures are logged and are not fatal; the no-head watchdog still ticks.
- Transport errors (socket, HTTP and timeout errors) are retried with a 1 to 30 second backoff. From the 5th consecutive failure of one call each retry is logged at error level with the call name and endpoint. The process keeps trying. A `getLogs` transport that fails 5 times in a row is benched and logged at error level.
- Errors that are not transport errors still stop the process with exit code 1: reverts, RPC error responses, undecodable logs and database errors.
- Stall watchdog, `start` only: every 30 seconds the stored cursor is compared with the last head the loop observed. If the cursor has not moved for 5 minutes while behind that head, the process logs `indexer stalled: cursor X behind head Y for N s`, closes the database (bounded wait) and exits 1. A cursor at head, or one that keeps moving, never trips it. A supervisor is expected to restart the process.
- SIGINT and SIGTERM exit 0 as in ADR 0013. Run the entry point directly under a supervisor (`node --env-file=.env --import tsx apps/indexer/src/main.ts start`) so the signal reaches the process.

## Consequences

- A dead or hung endpoint costs at most one timeout per call until it is ranked down, and no request can hang.
- A host that sleeps for hours can trip the stall exit on wake; the restart resumes from the stored cursor.
- All configured WebSocket hosts must also serve HTTP RPC.
- viem re-ranks endpoints while a request is in flight, so a call can occasionally fail over to the endpoint it just left; the retry covers it.
