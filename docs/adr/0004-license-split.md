# 0004. MIT for SDK, events and MCP; AGPL for indexer and API

Date: 2026-10-02
Status: Accepted

## Context

The SDK is the reusable piece for other Ink builders. The indexer and hosted API are the operated service.

## Decision

- `packages/sdk`, `packages/events`, `apps/mcp`: MIT.
- `apps/indexer`, `apps/api`, `packages/db`: AGPL-3.0.
- Contributors sign a CLA before their first pull request.

## Consequences

- Anyone can build on the SDK without obligations.
- Anyone running a modified hosted copy of the indexer publishes their changes.
- The CLA keeps relicensing of future versions possible; released versions keep their license.
