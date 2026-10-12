# 0015. Optional Sentry for fatal and stall exits

Date: 2026-10-12
Status: Accepted

## Context

The indexer runs unattended under a supervisor. A fatal error or a stall exit restarts it, and nobody sees why unless they read the journal.

## Decision

- When `SENTRY_DSN` is set, the indexer initialises `@sentry/node` with `release` from `SENTRY_RELEASE`, `environment: production` and `sendDefaultPii: false`.
- It reports only what stops the process: startup failures, the error behind a fatal exit, and the stall reason. It flushes for up to 2 seconds before exiting.
- Transport retries and warnings stay in the logs.
- Without a DSN nothing changes.

## Consequences

- Each restart has a matching Sentry event with the cause.
- Exit takes up to 2 seconds longer when Sentry is configured.
