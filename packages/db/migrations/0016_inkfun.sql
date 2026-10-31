-- ink.fun launches: one curve contract per token and the pool hook as a hooks row.
alter table indexer.hooks drop constraint hooks_kind_check;
alter table indexer.hooks add constraint hooks_kind_check check (kind in ('native', 'xstocks', 'inkfun'));

alter table indexer.tokens alter column gain_bps drop not null;

create table indexer.inkfun_curves (
  token text primary key references indexer.tokens (address) on delete cascade,
  curve text not null unique,
  virtual_quote numeric(78,0) not null,
  virtual_tokens numeric(78,0) not null,
  curve_supply numeric(78,0) not null,
  lp_supply numeric(78,0) not null,
  graduation_target numeric(78,0) not null
);

insert into indexer.hooks (address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block)
values ('0x735458d31dcf29dc204109430b1f7f96738568cc', 'inkfun', 'inkfun', 'inkfun',
        '0x0000000000000000000000000000000000000000', 18, 57611992)
on conflict do nothing;
