-- One log can yield several events (a sweep sells many items in one order). `sub` tells them apart;
-- an event that is the only one from its log keeps sub = ''.
alter table indexer.events add column sub text not null default '';

-- Drop the old (tx_hash, log_index) unique constraint by looking up its name rather than assuming it.
do $$
declare
  name text;
begin
  select c.conname into strict name
  from pg_constraint c
  where c.conrelid = 'indexer.events'::regclass
    and c.contype = 'u'
    and (
      select array_agg(a.attname::text order by a.attname)
      from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
    ) = array['log_index', 'tx_hash'];
  execute format('alter table indexer.events drop constraint %I', name);
end
$$;

alter table indexer.events add unique (tx_hash, log_index, sub);

-- The bot's per-collection reads: the latest events of one type for one entity.
create index events_type_entity_id on indexer.events (type, entity, id);
