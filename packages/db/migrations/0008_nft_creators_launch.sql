-- Creator accounts and the state behind two discovery fixes.

-- OpenSea accounts looked up for collection creators, one row per address. A 404 is cached as a
-- row with no username and verified = false. Rows are read again after seven days.
create table indexer.nft_accounts (
  address text primary key,
  username text,
  verified boolean not null default false,
  fetched_at timestamptz not null
);

alter table indexer.nft_collections
  -- The collection owner as the collection page names it.
  add column owner text,
  -- The creator named by a launchpad campaign (Chimera). It wins over `owner`.
  add column creator_address text,
  -- When the drop page was last found missing. A collection with no first mint is looked at again
  -- a day later; one with a first mint is not.
  add column drop_404_at timestamptz,
  -- When new activity last restarted slug discovery: it restarts at most once a day.
  add column attempts_reset_at timestamptz;
