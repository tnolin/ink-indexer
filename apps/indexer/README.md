# @ink-indexer/indexer

Follows Ink mainnet and writes InkyPump V2 launches, curve trades and bonds, and NFT collections, drops, mints, listings, sales and stats, into Postgres as normalized events. AGPL-3.0-only.

    pnpm start                                  # backfill to head, then follow new blocks
    pnpm backfill --from <block> [--to <block>] # re-scan a range; safe to repeat
    pnpm backfill --from <block> --sources nft-sales,nft-launches
    pnpm nft:mark <contract> <real|filtered|continuous|drop|clear>

`--sources` limits a backfill to some sources: `inkypump`, `nft-mints` (ERC-721 and ERC-1155 mints and burns, SeaDrop logs), `nft-sales` (Seaport) and `nft-launches` (Chimera campaigns). The default is every source. `nft:mark` sets a collection's verdict (`real`, `filtered`) or kind (`continuous`, `drop`) by hand, or `clear`s both, and re-evaluates it.

Run `backfill` with `start` stopped: two writers break the guarantee that event `id` order matches commit order, which readers of `where confirmed and id > $1` rely on.

Under a supervisor (systemd, launchd, a container) run the entry point directly, from the repository root, so signals reach the process and the exit code is the process's own. `--env-file` fails if `.env` is missing (`pnpm start` tolerates that):

    node --env-file=.env --import tsx apps/indexer/src/main.ts start

Environment: `DATABASE_URL` (required), `INK_RPC_WS_URLS` (optional, comma-separated, empty uses the Ink defaults) and `LOG_LEVEL`. `INDEXER_SOURCES` (comma-separated platforms: `inkypump`, `opensea`, `chimera`; empty runs all three; an unknown or repeated name stops the start; `backfill` without `--sources` covers the enabled platforms). For NFTs: `OPENSEA_API_KEY` (empty runs the chain sources only, after one warning), `OPENSEA_REQUESTS_PER_HOUR` (default 500, shared by every process using the key), `OPENSEA_MIN_INTERVAL_MS` (default 300, the shortest gap between two requests on the key) `NFT_HISTORY_START_BLOCK` (where the mint backfill started; empty uses the first stored mint) and `TICK_MIN_INTERVAL_MS` (default 0, the least time between the starts of two live ticks, up to 60000). These are optional: an invalid value is logged as a warning and its default is used.

NFT rows are pruned daily at 03:30 UTC: mints, burns and SeaDrop mints after 8 days, sales after 90 days, stats after 8 days, expired listing state, and ranks after 7 days.

Endpoints: each `ws://` or `wss://` entry also gives an HTTP URL (same host, port, path and query, `https` for `wss`); an `https://` or `http://` entry is used as given for reads. Every host must serve HTTP RPC at that URL, and a keyed path may differ between the two forms, so write the HTTP form if it does. Reads and `getLogs` use HTTP; `ws(s)` entries are used for new-head notifications, and with only `http(s)` entries the indexer polls for heads every second. Every request has a 15 second limit including its body and moves to the next endpoint on failure. Reads follow recent success and latency, not the listed order; the order breaks ties for `getLogs`. Repeated failures are logged at error level and retried. A log endpoint that cannot be reached is skipped for 60 seconds.

Exit codes: `0` after SIGINT or SIGTERM (the running tick finishes first, up to 10 seconds) or a finished `backfill`. Only `start` handles signals: `backfill` has no signal handler, so SIGTERM ends it with exit code 143 and no cleanup. `1` on data or database errors, and when `start` stalls: the stored cursor stays behind the chain head for 5 minutes, no chain head has been fetched for 5 minutes, or no tick has completed without error for 5 minutes while the cursor is not moving (for example a read endpoint stuck behind the cursor). Restart it with a supervisor. `2` for bad usage or missing configuration.

How it works: `docs/adr/0008-ingestion-loop-and-reorgs.md`, `0009-hook-discovery.md`, `0010-log-range-routing.md`, `0011-progress-from-curve.md` and `0014-http-reads-and-stall-exit.md`. NFTs: `0016-nft-chain-sources.md`, `0017-opensea-source.md`, `0018-off-chain-events.md` and `0019-opensea-shared-budget.md`.
