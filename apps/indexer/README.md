# @ink-indexer/indexer

Follows Ink mainnet and writes InkyPump V2 launches, curve trades and bonds into Postgres as normalized events. AGPL-3.0-only.

    pnpm start                                  # backfill to head, then follow new blocks
    pnpm backfill --from <block> [--to <block>] # re-scan a range; safe to repeat

Environment: `DATABASE_URL` (required), `INK_RPC_WS_URLS` (optional, comma-separated WebSocket URLs in priority order) and `LOG_LEVEL`.

How it works: `docs/adr/0008-ingestion-loop-and-reorgs.md`, `0009-hook-discovery.md`, `0010-log-range-routing.md` and `0011-progress-from-curve.md`.
