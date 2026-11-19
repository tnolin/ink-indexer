-- NFTX v4 markets and Uniswap continuous clearing auctions of NFTX floor tokens. Every statement
-- adds a nullable column or a table, or loosens a constraint.

-- A collection can open on Chimera and on NFTX, so a launch is keyed by its launchpad as well.
-- NFTX launches have no campaign, core, rewards or vault.
alter table indexer.nft_launches drop constraint nft_launches_pkey;
alter table indexer.nft_launches add primary key (collection, launchpad);
alter table indexer.nft_launches
  alter column campaign_id drop not null,
  alter column core drop not null,
  alter column rewards drop not null,
  alter column vault drop not null;

-- The collection's name in NFTX's URLs, from NFTX's API.
alter table indexer.nft_collections add column nftx_slug text;

-- Where a sale happened; null is OpenSea.
alter table indexer.nft_sales add column market text check (market in ('opensea', 'nftx'));

-- Stats rows written from NFTX pool moves carry their block, so a rollback deletes them; rows from
-- the OpenSea poll have no block. `floor_wei` is the combined floor, `os_floor_wei` the OpenSea
-- floor alone and `nftx_floor_wei` the pool's spot price; `floor_market` says which one won and is
-- null on rows written before NFTX.
alter table indexer.nft_stats
  add column floor_market text check (floor_market in ('opensea', 'nftx')),
  add column os_floor_wei numeric(78, 0),
  add column nftx_floor_wei numeric(78, 0),
  add column pool_count int,
  add column block bigint;
create index nft_stats_block_at on indexer.nft_stats (contract, at desc) where block is not null;
create index nft_stats_block on indexer.nft_stats (block) where block is not null;

-- A max supply set by hand with `nft:mark --max-supply`.
alter table indexer.nft_overrides add column max_supply numeric(78, 0);

-- One row per collection that has an NFTX market. `floor_token` is the ERC-20 the Locker mints.
create table indexer.nftx_collections (
  collection text primary key,
  floor_token text not null unique,
  creator text not null,
  name text,
  symbol text,
  created_block bigint not null,
  -- Set when trading opens (CollectionInitialized).
  initialized_block bigint,
  pool_id text,
  -- Null when the pool is not an NFTX pool or has no flETH side; no prices are stored for it.
  fleth_is_currency0 boolean,
  -- NFTs seeded into the pool when it opened, each counted once.
  seeded int,
  sunset_block bigint,
  -- True when NFTX's launchpad created the collection.
  launchpad_created boolean not null default false,
  -- The pool size last emitted and the block it was read at.
  pool_count int,
  pool_count_block bigint,
  -- The pool price last emitted in an nft.stats event and its block.
  stats_price_wei numeric(78, 0),
  stats_block bigint,
  -- The time of the first combined (OpenSea and NFTX) stats row written live. Combined floor
  -- history starts here.
  combined_since timestamptz
);
create index nftx_collections_created_block on indexer.nftx_collections (created_block);

-- One row per PoolStateUpdated. `price_wei` is wei per NFT and null for a price that is not defined.
create table indexer.nftx_prices (
  collection text not null,
  block bigint not null,
  log_index int not null,
  sqrt_price_x96 numeric(78, 0) not null,
  price_wei numeric(78, 0),
  at timestamptz not null,
  primary key (collection, block, log_index)
);
create index nftx_prices_block on indexer.nftx_prices (block);

-- Every auction the factory created, kept or not. `floor_price_q96` is the starting price in
-- Q96 currency per token unit; `amount` is what the factory was told to sell and `total_supply`
-- what the auction received.
create table indexer.nftx_auctions (
  auction text primary key,
  token text not null,
  currency text not null,
  start_block bigint not null,
  end_block bigint not null,
  claim_block bigint not null,
  floor_price_q96 numeric(78, 0) not null,
  required_raise numeric(78, 0) not null,
  amount numeric(78, 0) not null,
  total_supply numeric(78, 0),
  -- The creating transaction's sender and target.
  sender text not null,
  tx_to text,
  created_block bigint not null,
  created_log_index int not null,
  collection text,
  kept boolean not null default false,
  kept_block bigint,
  -- Linked by hand with `nft:auction`; a rollback does not unkeep it.
  manual boolean not null default false,
  tokens_received_block bigint,
  created_emitted_block bigint,
  live_block bigint,
  ended_block bigint
);
create index nftx_auctions_created_block on indexer.nftx_auctions (created_block);
create index nftx_auctions_token on indexer.nftx_auctions (token);
create index nftx_auctions_open on indexer.nftx_auctions (auction)
  where kept and (created_emitted_block is null or live_block is null or ended_block is null);

create table indexer.nftx_auction_bids (
  auction text not null,
  block bigint not null,
  log_index int not null,
  kind text not null check (kind in ('bid', 'exit', 'claim')),
  bid_id numeric(78, 0) not null,
  owner text not null,
  primary key (auction, block, log_index)
);
create index nftx_auction_bids_block on indexer.nftx_auction_bids (block);
