-- Tsunami launches: one curve contract per token, and the hooks of Tsunami's Calamari pools.
alter table indexer.hooks drop constraint hooks_kind_check;
alter table indexer.hooks add constraint hooks_kind_check
  check (kind in ('native', 'xstocks', 'inkfun', 'tsunami'));

-- tokens.hook references indexer.hooks, so each pool hook needs a row. quote_asset and quote_decimals
-- are not null there but are not read for Tsunami: a hook serves every quote currency, and each
-- token's quote is on its tokens row.
insert into indexer.hooks (address, launchpad, kind, abi_family, quote_asset, quote_decimals, discovered_block)
values
  ('0x110aac8ee9cd4853fb2c12f4f73937996ecfa8cc', 'tsunami', 'tsunami', 'tsunami', '0x0000000000000000000000000000000000000000', 18, 54686019),
  ('0xba7286377d0369f566256770dbe2fc59d13128cc', 'tsunami', 'tsunami', 'tsunami', '0x0000000000000000000000000000000000000000', 18, 55055393),
  ('0x5dc5426a33c1d095b9fd0449ac16f6aaebeee8cc', 'tsunami', 'tsunami', 'tsunami', '0x0000000000000000000000000000000000000000', 18, 55742827)
on conflict do nothing;
