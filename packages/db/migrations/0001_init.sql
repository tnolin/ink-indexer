create table indexer.hooks (
  address text primary key,
  launchpad text not null,
  kind text not null check (kind in ('native', 'xstocks')),
  abi_family text not null,
  quote_asset text not null,
  quote_decimals int not null,
  quote_symbol text,
  asset_id text,
  discovered_block bigint not null
);

create table indexer.tokens (
  address text primary key,
  launchpad text not null,
  hook text not null references indexer.hooks (address),
  launch_id text not null,
  name text,
  ticker text,
  creator text not null,
  created_block bigint not null,
  created_at timestamptz not null,
  phase text not null default 'curve' check (phase in ('curve', 'bonded')),
  bonded_block bigint,
  quote_asset text not null,
  paired_stock text,
  total_supply numeric(78, 0) not null,
  target_raise numeric(78, 0) not null,
  sale_supply numeric(78, 0) not null,
  gain_bps int not null,
  unique (hook, launch_id)
);

create table indexer.curve_state (
  token text primary key references indexer.tokens (address) on delete cascade,
  progress_bps int not null,
  curve_value numeric(78, 0) not null,
  target numeric(78, 0) not null,
  market_cap numeric(78, 0) not null,
  updated_block bigint not null
);

create table indexer.trades (
  tx_hash text not null,
  log_index int not null,
  token text not null references indexer.tokens (address) on delete cascade,
  side text not null check (side in ('buy', 'sell')),
  trader text not null,
  amount_in numeric(78, 0) not null,
  amount_out numeric(78, 0) not null,
  block bigint not null,
  venue text not null,
  primary key (tx_hash, log_index)
);
create index trades_token_block on indexer.trades (token, block);
create index trades_block on indexer.trades (block);

create table indexer.events (
  id bigserial primary key,
  type text not null,
  entity text not null,
  payload jsonb not null,
  block bigint not null,
  block_hash text not null,
  tx_hash text not null,
  log_index int not null,
  confirmed boolean not null,
  created_at timestamptz not null default now(),
  unique (tx_hash, log_index)
);
create index events_entity_id on indexer.events (entity, id);
create index events_block on indexer.events (block);
create index events_unconfirmed on indexer.events (id) where not confirmed;

create table indexer.cursors (
  source text primary key,
  block bigint not null,
  block_hash text not null
);

create table indexer.recent_blocks (
  number bigint primary key,
  hash text not null
);
