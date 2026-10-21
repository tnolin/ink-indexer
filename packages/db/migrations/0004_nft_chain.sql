-- Raw NFT rows from the chain source: mints, burns, SeaDrop logs and Seaport sales, one row per
-- decoded item, all stamped with their block so a reorg can delete everything above the fork.
-- Token ids and amounts are uint256, so numeric(78, 0).

-- One row per contract. Later migrations add the columns of the other sources.
create table indexer.nft_collections (
  contract text primary key,
  -- Null until a transfer shows the standard; a SeaDrop log can name a contract before any mint.
  standard text check (standard in ('erc721', 'erc1155')),
  kind text,
  launchpad text,
  launch_token text,
  first_mint_block bigint,
  first_mint_ts timestamptz,
  seadrop boolean not null default false,
  max_supply numeric(78, 0),
  last_mark_bps int not null default 0,
  sold_out_block bigint,
  created_at timestamptz not null default now()
);

-- One row per token id in a transfer: a TransferBatch log yields several, told apart by `idx`.
create table indexer.nft_mints (
  tx_hash text not null,
  log_index int not null,
  idx int not null,
  contract text not null,
  token_id numeric(78, 0) not null,
  recipient text not null,
  qty numeric(78, 0) not null,
  block bigint not null,
  primary key (tx_hash, log_index, idx)
);
create index nft_mints_contract_block on indexer.nft_mints (contract, block);
create index nft_mints_block on indexer.nft_mints (block);

create table indexer.nft_burns (
  tx_hash text not null,
  log_index int not null,
  idx int not null,
  contract text not null,
  token_id numeric(78, 0) not null,
  holder text not null,
  qty numeric(78, 0) not null,
  block bigint not null,
  primary key (tx_hash, log_index, idx)
);
create index nft_burns_contract_block on indexer.nft_burns (contract, block);
create index nft_burns_block on indexer.nft_burns (block);

create table indexer.nft_seadrop_mints (
  tx_hash text not null,
  log_index int not null,
  contract text not null,
  minter text not null,
  payer text not null,
  qty numeric(78, 0) not null,
  unit_price numeric(78, 0) not null,
  stage int not null,
  block bigint not null,
  primary key (tx_hash, log_index)
);
create index nft_seadrop_mints_contract_block on indexer.nft_seadrop_mints (contract, block);
create index nft_seadrop_mints_block on indexer.nft_seadrop_mints (block);

-- Every other SeaDrop log naming a collection. `event` is the event name when it is decoded, the
-- first topic otherwise.
create table indexer.nft_seadrop_config (
  tx_hash text not null,
  log_index int not null,
  contract text not null,
  event text not null,
  fields jsonb not null default '{}',
  block bigint not null,
  primary key (tx_hash, log_index)
);
create index nft_seadrop_config_contract_block on indexer.nft_seadrop_config (contract, block);
create index nft_seadrop_config_block on indexer.nft_seadrop_config (block);

-- One row per NFT item of a Seaport fill; one order can carry the same token id from two contracts.
-- `price_wei` is for one unit, so the line total is price_wei * qty.
create table indexer.nft_sales (
  tx_hash text not null,
  log_index int not null,
  token_id numeric(78, 0) not null,
  contract text not null,
  qty numeric(78, 0) not null,
  price_wei numeric(78, 0) not null,
  currency text not null check (currency in ('ETH', 'WETH')),
  buyer text not null,
  seller text not null,
  order_hash text not null,
  block bigint not null,
  primary key (tx_hash, log_index, contract, token_id)
);
create index nft_sales_contract_block on indexer.nft_sales (contract, block);
create index nft_sales_block on indexer.nft_sales (block);

-- Launchpad campaigns (Chimera). One row per collection.
create table indexer.nft_launches (
  collection text primary key,
  launchpad text not null,
  campaign_id numeric(78, 0) not null,
  token text not null,
  core text not null,
  pool_id text not null,
  rewards text not null,
  vault text not null,
  creator text not null,
  block bigint not null
);
create index nft_launches_block on indexer.nft_launches (block);

-- The last listing price written for an item, so only a lower price is written again. Filled by
-- the listing source; a sale clears the item's row.
create table indexer.nft_listing_state (
  contract text not null,
  token_id numeric(78, 0) not null,
  last_price_wei numeric(78, 0) not null,
  order_hash text not null,
  expires_at timestamptz not null,
  primary key (contract, token_id)
);
