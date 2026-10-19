-- Collection stats: one row per poll, and the schedule the stats job keeps on each collection.

-- `at` is the poll time. Rows are what the 24 hour floor change is read from. Amounts are wei.
create table indexer.nft_stats (
  contract text not null,
  at timestamptz not null,
  floor_wei numeric(78, 0),
  owners int,
  volume_24h_wei numeric(78, 0),
  sales_24h int,
  -- The supply the poll reported (see the stats job); null when none was known.
  total_supply int,
  -- Listings counted by this poll (see the stats job); null when it did not count.
  listed_count int,
  listed_capped bool,
  primary key (contract, at)
);

alter table indexer.nft_collections
  -- The collection's total supply as its OpenSea page states it.
  add column total_supply int,
  -- 'hot', 'warm' or 'cold'; null for a collection that gets no stats.
  add column stats_tier text check (stats_tier in ('hot', 'warm', 'cold')),
  add column next_stats_at timestamptz,
  -- The last listing written for the collection, by the listing source.
  add column last_listing_at timestamptz,
  -- The last on-demand stats refresh (they run at most once per 30 minutes).
  add column stats_requested_at timestamptz,
  -- A listed count is wanted from this time on (set at a sell-out); cleared once counted.
  add column listed_due_at timestamptz,
  add column listed_counted_at timestamptz,
  -- Number of `nft.stats` events written.
  add column stats_n int not null default 0;

create index nft_collections_stats_due on indexer.nft_collections (next_stats_at)
  where slug is not null and next_stats_at is not null;
create index nft_collections_listed_due on indexer.nft_collections (listed_due_at)
  where slug is not null and listed_due_at is not null;
