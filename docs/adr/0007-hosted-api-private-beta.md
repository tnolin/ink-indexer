# 0007. Hosted API as a keyed private beta, after the SDK

Date: 2026-10-02
Status: Accepted

## Context

A public API means paying for other people's queries before there is usage to justify it. The SDK and a local MCP server give builders direct access with their own RPC.

## Decision

Ship the SDK and local MCP server first. Open `apps/api` later as a keyed private beta for a few Ink builders.

## Consequences

- No public infrastructure cost at launch.
- API design is informed by how the bot and SDK are used.
