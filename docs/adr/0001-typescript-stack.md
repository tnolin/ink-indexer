# 0001. TypeScript for SDK, indexer and tools

Date: 2026-10-02
Status: Accepted

## Context

The SDK, indexer and the MAKO bot share event types. Existing launchpad tooling in this space is TypeScript, and viem is the standard EVM client in that ecosystem.

## Decision

Use TypeScript end to end: viem for chain access, Postgres for storage, pnpm workspaces for the monorepo.

## Consequences

- One language and one set of types from decoder to bot card.
- `packages/events` can be imported directly by consumers.
- Contributors need Node and pnpm only.
