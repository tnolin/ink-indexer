# @ink-indexer/indexer

Follows Ink mainnet and writes InkyPump V2 launches, curve trades and bonds into Postgres as normalized events. AGPL-3.0-only.

    pnpm start                                  # backfill to head, then follow new blocks
    pnpm backfill --from <block> [--to <block>] # re-scan a range; safe to repeat

Under a supervisor (systemd, launchd, a container) run the entry point directly, from the repository root, so signals reach the process and the exit code is the process's own. `--env-file` fails if `.env` is missing (`pnpm start` tolerates that):

    node --env-file=.env --import tsx apps/indexer/src/main.ts start

Environment: `DATABASE_URL` (required), `INK_RPC_WS_URLS` (optional, comma-separated, empty uses the Ink defaults) and `LOG_LEVEL`.

Endpoints: each `ws://` or `wss://` entry also gives an HTTP URL (same host, port, path and query, `https` for `wss`); an `https://` or `http://` entry is used as given for reads. Every host must serve HTTP RPC at that URL, and a keyed path may differ between the two forms, so write the HTTP form if it does. Reads and `getLogs` use HTTP; `ws(s)` entries are used for new-head notifications, and with only `http(s)` entries the indexer polls for heads every 4 seconds. Every request has a 15 second limit including its body and moves to the next endpoint on failure. Reads follow recent success and latency, not the listed order; the order breaks ties for `getLogs`. Repeated failures are logged at error level and retried. A log endpoint that cannot be reached is skipped for 60 seconds.

Exit codes: `0` after SIGINT or SIGTERM (the running tick finishes first, up to 10 seconds) or a finished `backfill`. `1` on data or database errors, and when `start` makes no progress: the stored cursor stays behind the chain head for 5 minutes. Restart it with a supervisor. `2` for bad usage or missing configuration.

How it works: `docs/adr/0008-ingestion-loop-and-reorgs.md`, `0009-hook-discovery.md`, `0010-log-range-routing.md`, `0011-progress-from-curve.md` and `0014-http-reads-and-stall-exit.md`.
