# 0015. Optional Sentry for fatal and stall exits

Date: 2026-10-12
Status: Accepted

## Context

The indexer runs unattended under a supervisor. A fatal error or a stall exit restarts it, and nobody sees why unless they read the journal.

## Decision

- When `SENTRY_DSN` is set, the indexer initialises `@sentry/node` with `release` from `SENTRY_RELEASE` and `environment: production`. It collects no user info, cookies, headers, query params or request bodies (`dataCollection`).
- It reports only what stops the process: startup failures, the error behind a fatal exit, and the stall reason. It flushes for up to 2 seconds before exiting.
- HTTP, fetch and console breadcrumbs are dropped, and every configured endpoint URL (`DATABASE_URL` and each `INK_RPC_WS_URLS` entry, with its HTTP form) is replaced with `[redacted]` in events, because RPC keys sit in URL paths and client errors quote the URL.
- Transport retries and warnings stay in the logs.
- Without a DSN nothing changes.

## Consequences

- Each restart has a matching Sentry event with the cause.
- Exit takes up to 2 seconds longer when Sentry is configured.
