-- Listings: the OpenSea rank cache and the item names and images that sales are enriched with.

-- One row per item whose rank was fetched. The row is valid while `fetched_at` is under 7 days old
-- and `calculated_at` equals the collection's `rarity_calculated_at` (a reveal moves the latter).
-- A rank is never invented: an item OpenSea has no rank for gets no row.
create table indexer.nft_ranks (
  contract text not null,
  token_id numeric(78, 0) not null,
  rank int not null,
  max_rank int not null,
  -- The collection's `rarity_calculated_at` when the rank was fetched.
  calculated_at timestamptz,
  fetched_at timestamptz not null,
  primary key (contract, token_id)
);

-- The latest name and image of an item, refreshed by each `nft.listing` written. Sales arrive
-- from the chain without metadata, so `nft.sale` reads them here.
create table indexer.nft_items_seen (
  contract text not null,
  token_id numeric(78, 0) not null,
  name text,
  image_url text,
  seen_at timestamptz not null,
  primary key (contract, token_id)
);
