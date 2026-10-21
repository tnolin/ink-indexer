-- Mint milestones. A stage is recorded the first time a mint of that stage index is seen, so a
-- reorg that removes its first mint removes the stage and its start event can fire again.
create table indexer.nft_stages (
  contract text not null,
  stage_index int not null,
  first_block bigint not null,
  first_ts timestamptz not null,
  primary key (contract, stage_index)
);
create index nft_stages_first_block on indexer.nft_stages (first_block);

-- A collection's drop as the marketplace describes it: stage names and windows, used to label the
-- stages that mints report only by index. Filled by the drops job; empty until it runs.
create table indexer.nft_drops (
  contract text primary key,
  slug text,
  -- The drop's stages in order of start, as the NftDropStage list of @ink-indexer/events.
  stages jsonb not null default '[]',
  max_supply numeric(78, 0),
  fetched_at timestamptz not null
);
