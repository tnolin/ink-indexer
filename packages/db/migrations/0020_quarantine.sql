-- Spans of blocks a source skipped and sources paused after a refused write. A skip row names the
-- blocks to replay; a live pause keeps its source out of the indexer until it is cleared. Every
-- statement adds a table or an index.

create table indexer.quarantine (
  id bigserial primary key,
  -- A source name: inkypump, inkfun, tsunami, hookit, v4, nft or nftx.
  source text not null,
  kind text not null check (kind in ('skip', 'pause')),
  mode text not null check (mode in ('live', 'backfill')),
  -- First block of the failing span (a pause: of the first span skipped).
  from_block bigint not null,
  -- A skip: the span's last block. A backfill pause: the run's --to. A live pause has no end.
  to_block bigint,
  -- The backfill --sources value that replays the span: the source's groups.
  replay_sources text not null,
  sqlstate text not null,
  message text not null check (char_length(message) <= 500),
  created_at timestamptz not null default now(),
  -- Set when a live pause is lifted. Skip rows are never cleared.
  cleared_at timestamptz,
  check ((kind = 'pause' and mode = 'live') = (to_block is null))
);

-- At most one open live pause per source.
create unique index quarantine_open_live_pause on indexer.quarantine (source)
  where kind = 'pause' and mode = 'live' and cleared_at is null;
