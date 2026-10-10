# 0014. HTTP reads with timeouts, error threshold and stall exit

Date: 2026-10-10
Status: Accepted

Supersedes the transport parts of ADR 0013.

## Context

The indexer runs on hosts that sleep and lose their network. Two long backfills ended badly after exactly that.

1. A dead WebSocket surfaced through viem's fallback transport on a tick read and stopped the process (fixed by ADR 0013's retry and bench rules).
2. The next run then sat for hours with no error and no exit. Reads were retried forever, but a retried request never returned. viem's WebSocket transport waits for a (re)connect with no timeout, so a half-open socket can hold a request open indefinitely, and no failover can happen while a request is open. The head watchdog kept logging while the cursor stood still.

## Decision

- Reads, state calls and `eth_getLogs` use HTTP. Each configured URL gets an HTTP URL with the same host, port, path and query: `wss` becomes `https`, `ws` becomes `http`, and an `https://` or `http://` entry is used as given. Ink's WebSocket-only Gelato host maps to its HTTP host. `INK_RPC_WS_URLS` stays the only endpoint setting, and every configured host must serve HTTP RPC.
- Every request has a hard 15 second limit for the whole request, response body included: viem's own timer stops once the headers arrive, so the fetch also carries `AbortSignal.timeout`.
- viem's fallback moves a failed request to the next endpoint and re-ranks endpoints every 10 seconds by recent success and latency (pinging with `eth_blockNumber`), so a dead endpoint stops being tried first. Reads therefore no longer follow the configured order; the order still breaks ties for `getLogs` routing. Per-endpoint log transports, ranges, benching and head clamping (ADR 0010) run over HTTP with one refinement: a request that fails before any response (network down, DNS, reset, abort) benches the endpoint at once and leaves its range alone, while an HTTP status error (429, 5xx) halves the range as before.
- WebSocket is used only for the `newHeads` subscription, from the `ws://` and `wss://` entries. Its failures are logged and are not fatal; the no-head timer still ticks. With only `http(s)://` entries the indexer logs a warning and polls for heads every second.
- Transport errors (socket, HTTP and timeout errors) are retried with a 1 to 30 second backoff. From the 5th consecutive failure of one call each retry is logged at error level with the call name and endpoint. The process keeps trying. A log transport that fails 5 times in a row is logged at error level on each further failure (the count is independent of benching), and is benched.
- Errors that are not transport errors still stop the process with exit code 1: reverts, RPC error responses, undecodable logs and database errors.
- Stall watchdog, `start` only: every 30 seconds the cursor (held in memory by the indexer, so a stuck database cannot block the check) is compared with the last head the loop observed. If the cursor has not moved for 5 minutes and either it is behind that head or no head fetch has succeeded in those 5 minutes (including since start), the process logs `indexer stalled: ...`, closes the database (bounded wait) and exits 1. A cursor at a head that keeps being refreshed never trips it on those grounds. It also trips when the cursor has not moved and no tick has completed without error for 5 minutes, which catches a read endpoint stuck behind the cursor: heads stay fresh, `getBlock` for the cursor block keeps coming back empty and every tick ends in a "block not yet served" warning. Ticks on an idle chain complete normally, so they reset that window. The window is measured on a monotonic clock, which does not advance while the machine sleeps (macOS and Linux), so a sleep alone does not trip it. A supervisor is expected to restart the process.
- SIGINT and SIGTERM exit 0 as in ADR 0013. Run the entry point directly under a supervisor (`node --env-file=.env --import tsx apps/indexer/src/main.ts start`) so the signal reaches the process.

## Consequences

- A dead or hung endpoint costs at most one timeout per call until it is ranked down, and no request can hang.
- If every endpoint is down for 5 minutes the process exits and the supervisor restarts it; it resumes from the stored cursor.
- Every configured host must serve HTTP RPC at the derived URL.
- viem re-ranks endpoints while a request is in flight, so a call can occasionally fail over to the endpoint it just left; the retry covers it.
