-- One request budget for one OpenSea API key, shared by every process that uses the key. A token
-- bucket in a single row: tokens refill at refill_per_s up to capacity, and each request takes one.
-- The row is seeded at 500 requests an hour so a reader can take before the indexer configures it.
create table indexer.opensea_budget (
  id int primary key check (id = 1),
  tokens double precision not null,
  capacity double precision not null,
  refill_per_s double precision not null,
  updated_at timestamptz not null default now(),
  -- No request may be made before this time (set after a 429).
  blocked_until timestamptz not null default 'epoch'
);
insert into indexer.opensea_budget (id, tokens, capacity, refill_per_s) values (1, 500, 500, 500 / 3600.0);

-- Sets the hourly limit. Tokens already accrued are kept, up to the new capacity.
create function indexer.opensea_configure(per_hour int) returns void
language plpgsql security definer set search_path = indexer, pg_temp as $$
begin
  if per_hour is null or per_hour <= 0 then
    raise exception 'per_hour must be positive';
  end if;
  update opensea_budget set
    tokens = least(per_hour, capacity, tokens + refill_per_s *
      greatest(0, extract(epoch from clock_timestamp() - updated_at))),
    capacity = per_hour,
    refill_per_s = per_hour / 3600.0,
    updated_at = clock_timestamp()
  where id = 1;
end $$;

-- Takes one token for a request of the given class. Returns 0 when the request may go ahead, else
-- the milliseconds to wait (at least 50) until both a token above the class floor and the end of any
-- block are available. A class may only draw the bucket down to its floor, a share of capacity kept
-- for the classes above it: 0 bot 0, 1 ranks 5%, 2 discovery and drops 10%, 3 stats 25%, 4 background 50%.
-- The row is locked and updated in one statement, so concurrent callers never take the same token:
-- the `for update` read waits for any other caller, then sees its committed row, and the update
-- writes the decision made on that row.
create function indexer.opensea_take(class int) returns int
language plpgsql security definer set search_path = indexer, pg_temp as $$
declare
  wait_ms int;
begin
  if class is null or class < 0 or class > 4 then
    raise exception 'class must be 0 to 4';
  end if;
  with cur as (
    select tokens, capacity, refill_per_s, blocked_until, clock_timestamp() as ts, updated_at
    from opensea_budget where id = 1 for update
  ),
  calc as (
    select ts,
      avail,
      (array[0, 0.05, 0.10, 0.25, 0.50])[class + 1] * capacity as floor_tokens,
      refill_per_s,
      blocked_until
    from (
      select *, least(capacity, tokens + refill_per_s * greatest(0, extract(epoch from ts - updated_at)))
        as avail
      from cur
    ) c
  ),
  decided as (
    select *,
      avail - 1 >= floor_tokens and ts >= blocked_until as ok,
      greatest(
        case when avail - 1 >= floor_tokens then 0
          else coalesce((floor_tokens + 1 - avail) / nullif(refill_per_s, 0) * 1000, 3600000) end,
        case when blocked_until > ts then extract(epoch from blocked_until - ts) * 1000 else 0 end,
        0
      ) as wait
    from calc
  )
  update opensea_budget b set
    tokens = case when d.ok then d.avail - 1 else d.avail end,
    updated_at = d.ts
  from decided d
  where b.id = 1
  returning case when d.ok then 0 else least(greatest(50, ceil(d.wait)), 3600000)::int end
  into wait_ms;
  return wait_ms;
end $$;

-- Stops every class until ms from now, at most an hour. A shorter block never replaces a longer one.
create function indexer.opensea_block(ms int) returns void
language sql security definer set search_path = indexer, pg_temp as $$
  update opensea_budget set
    blocked_until = greatest(blocked_until, clock_timestamp() + least(greatest(ms, 0), 3600000) * interval '1 millisecond')
  where id = 1
$$;

-- The functions are the only way in. The bot's role is granted EXECUTE on opensea_take and
-- opensea_block, and nothing on the table.
revoke all on function indexer.opensea_configure(int), indexer.opensea_take(int), indexer.opensea_block(int) from public;
