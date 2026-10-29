-- Uniswap v4 pools of tracked tokens, the token's all-time-high market cap, and the dead address's
-- balance. Every statement is either a new table or a nullable column, so a live database is not
-- rewritten or locked for long.
create table indexer.pools (
  pool_id text primary key,
  pool_manager text not null,
  token text not null references indexer.tokens (address) on delete cascade,
  launchpad text not null,
  quote_asset text not null,
  token_is_currency0 boolean not null,
  created_block bigint not null
);
create index pools_token on indexer.pools (token);

alter table indexer.tokens
  add column ath_market_cap numeric(78,0),
  add column ath_block bigint,
  add column dead_balance numeric(78,0),
  add column dead_balance_block bigint;

alter table indexer.trades add column pool_id text;

insert into indexer.pools (pool_id, pool_manager, token, launchpad, quote_asset, token_is_currency0, created_block)
select lower(e.payload->>'poolId'), '0x360e68faccca8ca495c1b759fd9eee466db9fb32', e.entity, 'inkypump',
       lower(e.payload->>'quoteAsset'), e.entity < lower(e.payload->>'quoteAsset'), e.block
from indexer.events e
where e.type = 'launchpad.bond'
on conflict do nothing;

update indexer.tokens t set ath_market_cap = m.mc, ath_block = m.block
from (
  select distinct on (entity) entity, (payload->>'marketCap')::numeric as mc, block
  from indexer.events where type = 'launchpad.trade'
  order by entity, (payload->>'marketCap')::numeric desc, block
) m
where m.entity = t.address;
