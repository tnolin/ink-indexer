-- Collection verdicts: manual marks, the traits sample and the verdict job's schedule.

-- Manual marks set by an operator with `pnpm nft:mark`. A row may set the kind, the verdict or both; clearing a mark
-- deletes the row.
create table indexer.nft_overrides (
  contract text primary key,
  kind text check (kind in ('drop', 'continuous')),
  verdict text check (verdict in ('real', 'filtered')),
  note text,
  set_at timestamptz
);

alter table indexer.nft_collections
  -- What the sampled item showed: 'pass' (traits), 'empty' (no traits and no rarity rank) or
  -- 'pending' (not sampled yet, or nothing to decide from).
  add column traits_state text not null default 'pending' check (traits_state in ('pending', 'pass', 'empty')),
  -- Traits checkpoints after the mint ended that are done or skipped (see verdict.ts).
  add column traits_checks int not null default 0,
  add column next_traits_at timestamptz,
  add column next_verdict_at timestamptz,
  -- maxSupply() has been read once (max_supply holds the answer, null when it reverted).
  add column max_supply_checked bool not null default false,
  -- The MINT LIVE stage start of a mint with no SeaDrop stages has been written.
  add column mint_start_emitted bool not null default false,
  -- totalSupply() the block before the first stored mint (null when it reverted), and whether the
  -- collection minted before the mint history: null until decided (see verdict.ts).
  add column prior_supply numeric(78, 0),
  add column prior_minted bool;

create index nft_collections_verdict_due on indexer.nft_collections (next_verdict_at)
  where next_verdict_at is not null;
create index nft_collections_verdict_dirty on indexer.nft_collections (contract)
  where verdict_dirty;
create index nft_collections_traits_due on indexer.nft_collections (next_traits_at)
  where next_traits_at is not null;
-- The farm-wallet check looks up the other mints of a collection's recipients.
create index nft_mints_recipient_block on indexer.nft_mints (recipient, block);
