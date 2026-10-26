-- Gate 1 compares links and names across collections. The key functions give two spellings of the
-- same X handle, website or name the same key, and the indexes keep the comparison a lookup.
create function indexer.nft_handle_key(t text) returns text language sql immutable as $$
  select nullif(lower(btrim(t)), '')
$$;

-- Lowercase host and path: no scheme, no leading "www.", no query or fragment, no trailing slash.
create function indexer.nft_site_key(t text) returns text language sql immutable as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(btrim(t)), '^[a-z][a-z0-9+.-]*://', ''),
          '^www\.', ''),
        '[?#].*$', ''),
      '/+$', ''),
    '')
$$;

create function indexer.nft_name_key(t text) returns text language sql immutable as $$
  select nullif(lower(regexp_replace(btrim(t), '\s+', ' ', 'g')), '')
$$;

create index nft_collections_handle_key on indexer.nft_collections (indexer.nft_handle_key(twitter));
create index nft_collections_site_key on indexer.nft_collections (indexer.nft_site_key(website));
create index nft_collections_name_key on indexer.nft_collections (indexer.nft_name_key(name));

-- Why gate 1 failed, in words; null while it has not failed.
alter table indexer.nft_collections add column page_reason text;

-- Every collection is looked at once more, so the new gate 1 rules apply to the ones already stored.
update indexer.nft_collections set verdict_dirty = true;
