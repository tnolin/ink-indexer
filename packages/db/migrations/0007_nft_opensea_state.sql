-- What the OpenSea jobs keep on each collection: the page fields, when each job is next due, the
-- verdict and the hash of the last `nft.collection` event written.
alter table indexer.nft_collections
  add column slug text,
  add column name text,
  add column image_url text,
  add column twitter text,
  add column website text,
  add column discord text,
  add column safelist text,
  add column opensea_url text,
  add column rarity_calculated_at timestamptz,
  add column max_rank int,
  -- Failed lookups of the contract's slug. Reset to 0 by new activity on a contract with no slug.
  add column discovery_attempts int not null default 0,
  -- Due time of the slug lookup. A new row is due at once (the default); null means not scheduled
  -- (found, or given up after the retry window).
  add column next_discovery_at timestamptz default now(),
  add column discovered_at timestamptz,
  add column next_metadata_at timestamptz,
  add column next_drops_at timestamptz,
  add column drop_first_start timestamptz,
  add column verdict text not null default 'pending' check (verdict in ('real', 'pending', 'junk')),
  add column gates jsonb,
  add column verdict_dirty boolean not null default true,
  -- Hash of the last `nft.collection` event written and how many have been written.
  add column snapshot_hash text,
  add column snapshot_n int not null default 0,
  -- Number of `nft.drop` events written.
  add column drop_n int not null default 0;

create index nft_collections_discovery_due on indexer.nft_collections (next_discovery_at)
  where slug is null and next_discovery_at is not null;
create index nft_collections_metadata_due on indexer.nft_collections (next_metadata_at)
  where slug is not null and next_metadata_at is not null;
create index nft_collections_drops_due on indexer.nft_collections (next_drops_at)
  where slug is not null and next_drops_at is not null;
