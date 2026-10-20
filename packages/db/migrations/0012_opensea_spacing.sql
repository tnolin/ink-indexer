-- Minimum spacing between two requests on the OpenSea key. The hourly bucket alone lets a full
-- bucket go out in a burst, and OpenSea also limits over a short window (it answers 429 well before
-- the hourly budget is spent). A take now also needs `min_interval_ms` since the last one.
alter table indexer.opensea_budget
  add column min_interval_ms int not null default 300 check (min_interval_ms >= 0),
  -- When the last token was taken.
  add column last_take_at timestamptz not null default 'epoch';

-- Sets the hourly limit and the spacing. Tokens already accrued are kept, up to the new capacity.
drop function indexer.opensea_configure(int);
create function indexer.opensea_configure(per_hour int, min_interval_ms int default 300) returns void
language plpgsql security definer set search_path = indexer, pg_temp as $$
begin
  if per_hour is null or per_hour <= 0 then
    raise exception 'per_hour must be positive';
  end if;
  if opensea_configure.min_interval_ms is null or opensea_configure.min_interval_ms < 0 then
    raise exception 'min_interval_ms must be zero or more';
  end if;
  update opensea_budget set
    tokens = least(per_hour, capacity, tokens + refill_per_s *
      greatest(0, extract(epoch from clock_timestamp() - updated_at))),
    capacity = per_hour,
    refill_per_s = per_hour / 3600.0,
    min_interval_ms = opensea_configure.min_interval_ms,
    updated_at = clock_timestamp()
  where id = 1;
end $$;
revoke all on function indexer.opensea_configure(int, int) from public;

-- As in 0006, plus the spacing: a take succeeds only when a token above the class floor is
-- available, no block is running and `min_interval_ms` has passed since the last take. Otherwise it
-- returns the milliseconds to wait (at least 50) for all three. Still one locked statement.
-- shortcut: the spacing is first come, first served across classes, so a bot request (class 0) can
-- queue behind background takes for a few intervals. Reserve slots for class 0 if its waits grow.
create or replace function indexer.opensea_take(class int) returns int
language plpgsql security definer set search_path = indexer, pg_temp as $$
declare
  wait_ms int;
begin
  if class is null or class < 0 or class > 4 then
    raise exception 'class must be 0 to 4';
  end if;
  with cur as (
    select tokens, capacity, refill_per_s, blocked_until, min_interval_ms, last_take_at,
      clock_timestamp() as ts, updated_at
    from opensea_budget where id = 1 for update
  ),
  calc as (
    select ts,
      avail,
      (array[0, 0.05, 0.10, 0.25, 0.50])[class + 1] * capacity as floor_tokens,
      refill_per_s,
      blocked_until,
      greatest(0, extract(epoch from
        last_take_at + min_interval_ms * interval '1 millisecond' - ts) * 1000) as spacing_ms
    from (
      select *, least(capacity, tokens + refill_per_s * greatest(0, extract(epoch from ts - updated_at)))
        as avail
      from cur
    ) c
  ),
  decided as (
    select *,
      avail - 1 >= floor_tokens and ts >= blocked_until and spacing_ms = 0 as ok,
      greatest(
        case when avail - 1 >= floor_tokens then 0
          else coalesce((floor_tokens + 1 - avail) / nullif(refill_per_s, 0) * 1000, 3600000) end,
        case when blocked_until > ts then extract(epoch from blocked_until - ts) * 1000 else 0 end,
        spacing_ms,
        0
      ) as wait
    from calc
  )
  update opensea_budget b set
    tokens = case when d.ok then d.avail - 1 else d.avail end,
    last_take_at = case when d.ok then d.ts else b.last_take_at end,
    updated_at = d.ts
  from decided d
  where b.id = 1
  returning case when d.ok then 0 else least(greatest(50, ceil(d.wait)), 3600000)::int end
  into wait_ms;
  return wait_ms;
end $$;
