-- Lookups made by readers of indexer.events (the MAKO bot):
-- a creator's launches (dev history on alerts) and the latest events of one type (latest bonds).
create index events_launch_creator on indexer.events ((payload->>'creator'), id)
  where type = 'launchpad.launch';
create index events_type_id on indexer.events (type, id);
