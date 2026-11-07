-- Hookit: Master tokens trade in concentrated pools from launch and can have several pools; Classic
-- tokens bond on a curve. Every statement adds a nullable column, a row or a looser constraint.
alter table indexer.hooks drop constraint hooks_kind_check;
alter table indexer.hooks add constraint hooks_kind_check
  check (kind in ('native', 'xstocks', 'inkfun', 'tsunami', 'hookit'));

-- A token that starts in a pool never has a curve, so it gets its own phase.
alter table indexer.tokens drop constraint tokens_phase_check;
alter table indexer.tokens add constraint tokens_phase_check
  check (phase in ('curve', 'bonded', 'pool'));

alter table indexer.tokens
  alter column target_raise drop not null,
  alter column sale_supply drop not null,
  add column total_supply_block bigint;

alter table indexer.pools
  add column hook text,
  add column tick_lower int,
  add column tick_upper int,
  add column ath_market_cap numeric(78,0),
  add column ath_block bigint;

-- A Classic curve's starting reserves and net tokens sold. Every later state is derived from them.
create table indexer.hookit_curves (
  token text primary key references indexer.tokens (address) on delete cascade,
  launch_number numeric(78,0) not null unique,
  virtual_quote numeric(78,0) not null,
  virtual_tokens numeric(78,0) not null,
  curve_supply numeric(78,0) not null,
  tokens_sold numeric(78,0) not null,
  updated_block bigint not null
);

-- tokens.hook references indexer.hooks, so each Hookit hook needs a row. quote_asset and
-- quote_decimals are not null there but are not read for Hookit: each token's quote is on its tokens row.
insert into indexer.hooks (address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block)
values
  ('0xbd7e7815c640a67cabd9a93a15d1f250aaeeaac8', 'hookit', 'hookit', 'hookit', '0x0000000000000000000000000000000000000000', 18, 56517960),
  ('0x7c629422e9ac982ce72323d48ead94fcc092aac8', 'hookit', 'hookit', 'hookit', '0x0000000000000000000000000000000000000000', 18, 56618517),
  ('0x33200d9521ed99afbda8575f05348a583c7aaac8', 'hookit', 'hookit', 'hookit', '0x0000000000000000000000000000000000000000', 18, 56759989),
  ('0x4b533c432516fc1be4b0baefe6bff0942ad87fff', 'hookit', 'hookit', 'hookit', '0x0000000000000000000000000000000000000000', 18, 57556983),
  ('0x8a29b2c508007707bbff1814386aa968bbecbfff', 'hookit', 'hookit', 'hookit', '0x0000000000000000000000000000000000000000', 18, 58683272),
  ('0x1eee7628d070280da1b676c04d358d68b36f3fff', 'hookit', 'hookit', 'hookit', '0x0000000000000000000000000000000000000000', 18, 59883877),
  ('0xaac738f140d529bc0662bddd812964d843362088', 'hookit', 'hookit', 'hookit', '0x0000000000000000000000000000000000000000', 18, 56517988)
on conflict do nothing;
