begin;

-- A versioned observation says what was known about one event.  A complete
-- snapshot says which events were actually present in a provider response.
-- Keeping both is necessary to reproduce cancellations/removals causally.
create table if not exists signal_atlas.economic_calendar_snapshots (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  source text not null,
  snapshot_hash text not null,
  events jsonb not null,
  first_seen_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (source, snapshot_hash),
  check (pg_catalog.length(pg_catalog.btrim(source)) between 1 and 80),
  check (pg_catalog.length(snapshot_hash) = 64),
  check (pg_catalog.jsonb_typeof(events) = 'array'),
  check (pg_catalog.jsonb_array_length(events) <= 500)
);

create table if not exists signal_atlas.economic_calendar_fetch_snapshots (
  fetch_id uuid primary key references signal_atlas.economic_calendar_fetches(id),
  snapshot_id uuid not null references signal_atlas.economic_calendar_snapshots(id),
  linked_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index if not exists economic_calendar_fetch_snapshots_snapshot_idx
  on signal_atlas.economic_calendar_fetch_snapshots (snapshot_id, fetch_id);
create index if not exists economic_calendar_snapshots_first_seen_idx
  on signal_atlas.economic_calendar_snapshots (first_seen_at desc);

alter table signal_atlas.economic_calendar_snapshots enable row level security;
alter table signal_atlas.economic_calendar_snapshots force row level security;
alter table signal_atlas.economic_calendar_fetch_snapshots enable row level security;
alter table signal_atlas.economic_calendar_fetch_snapshots force row level security;

drop trigger if exists economic_calendar_snapshots_append_only_guard
  on signal_atlas.economic_calendar_snapshots;
create trigger economic_calendar_snapshots_append_only_guard
before update or delete on signal_atlas.economic_calendar_snapshots
for each row execute function signal_atlas.reject_update_delete();

drop trigger if exists economic_calendar_fetch_snapshots_append_only_guard
  on signal_atlas.economic_calendar_fetch_snapshots;
create trigger economic_calendar_fetch_snapshots_append_only_guard
before update or delete on signal_atlas.economic_calendar_fetch_snapshots
for each row execute function signal_atlas.reject_update_delete();

-- Replace only the public ingestion wrapper.  The already-audited canonical
-- archive remains untouched; after it validates and stores the observation,
-- this wrapper links the fetch to the exact complete event set it received.
create or replace function public.archive_economic_calendar(
  p_run_id uuid,
  p_fetched_at timestamptz,
  p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_fetch_id uuid;
  v_snapshot_id uuid;
  v_source text;
  v_events jsonb;
  v_canonical_events jsonb;
  v_hash text;
begin
  v_result := signal_atlas.archive_economic_calendar_at(
    p_run_id, p_fetched_at, p_snapshot
  );

  -- Failed provider calls stay in the fetch audit but cannot become a usable
  -- historical snapshot.
  if coalesce(v_result->>'status', '') <> 'success' then
    return v_result || pg_catalog.jsonb_build_object('snapshotLinked', false);
  end if;

  v_fetch_id := (v_result->>'fetchId')::uuid;
  v_source := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(p_snapshot->>'source'), ''), 'unknown'),
    80
  );
  v_events := coalesce(p_snapshot->'events', '[]'::jsonb);

  select coalesce(pg_catalog.jsonb_agg(item.value order by item.value->>'eventKey'), '[]'::jsonb)
  into v_canonical_events
  from pg_catalog.jsonb_array_elements(v_events) item(value);

  v_hash := pg_catalog.encode(
    extensions.digest(v_canonical_events::text, 'sha256'),
    'hex'
  );

  insert into signal_atlas.economic_calendar_snapshots(
    source, snapshot_hash, events, first_seen_at
  ) values (
    v_source, v_hash, v_canonical_events, p_fetched_at
  )
  on conflict (source, snapshot_hash) do nothing
  returning id into v_snapshot_id;

  if v_snapshot_id is null then
    select s.id into strict v_snapshot_id
    from signal_atlas.economic_calendar_snapshots s
    where s.source = v_source and s.snapshot_hash = v_hash;
  end if;

  insert into signal_atlas.economic_calendar_fetch_snapshots(fetch_id, snapshot_id)
  values (v_fetch_id, v_snapshot_id)
  on conflict (fetch_id) do nothing;

  return v_result || pg_catalog.jsonb_build_object(
    'snapshotLinked', true,
    'snapshotId', v_snapshot_id,
    'snapshotHash', v_hash
  );
end
$$;

-- Bounded, read-only replay bridge.  The browser cannot call this RPC
-- directly; the JWT-protected calendar-replay Edge Function is the only public
-- transport and the service role is the only database role granted EXECUTE.
create or replace function public.calendar_replay_snapshots(
  p_points jsonb,
  p_max_stale_minutes integer default 360
)
returns table(
  point_key text,
  known_at timestamptz,
  fetched_at timestamptz,
  source text,
  events jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_points is null or pg_catalog.jsonb_typeof(p_points) <> 'array' then
    raise exception using errcode = '22023', message = 'replay points must be a JSON array';
  end if;
  v_count := pg_catalog.jsonb_array_length(p_points);
  if v_count < 1 or v_count > 750 then
    raise exception using errcode = '22023', message = 'replay batch must contain 1 to 750 points';
  end if;
  if p_max_stale_minutes < 1 or p_max_stale_minutes > 360 then
    raise exception using errcode = '22023', message = 'max stale minutes must be between 1 and 360';
  end if;

  return query
  with parsed as (
    select
      pg_catalog.left(pg_catalog.btrim(item.value->>'key'), 80) as point_key,
      pg_catalog.to_timestamp((item.value->>'knownAt')::double precision / 1000.0) as known_at,
      pg_catalog.to_timestamp((item.value->>'from')::double precision / 1000.0) as window_from,
      pg_catalog.to_timestamp((item.value->>'to')::double precision / 1000.0) as window_to
    from pg_catalog.jsonb_array_elements(p_points) with ordinality item(value, ordinal)
  ), validated as (
    select p.*
    from parsed p
    where pg_catalog.length(p.point_key) between 1 and 80
      and p.known_at <= pg_catalog.clock_timestamp()
      and p.window_from <= p.window_to
      and p.window_to - p.window_from <= interval '25 hours'
  )
  select
    p.point_key,
    p.known_at,
    latest.fetched_at,
    latest.source,
    coalesce((
      select pg_catalog.jsonb_agg(event.value order by (event.value->>'at')::double precision, event.value->>'eventKey')
      from pg_catalog.jsonb_array_elements(latest.snapshot_events) event(value)
      where pg_catalog.to_timestamp((event.value->>'at')::double precision / 1000.0)
        between p.window_from and p.window_to
    ), '[]'::jsonb) as events
  from validated p
  left join lateral (
    select f.fetched_at, f.source, s.events as snapshot_events
    from signal_atlas.economic_calendar_fetches f
    join signal_atlas.economic_calendar_fetch_snapshots link on link.fetch_id = f.id
    join signal_atlas.economic_calendar_snapshots s on s.id = link.snapshot_id
    where f.status = 'success'
      and f.fetched_at <= p.known_at
      and f.fetched_at >= p.known_at - pg_catalog.make_interval(mins => p_max_stale_minutes)
    order by f.fetched_at desc, f.id desc
    limit 1
  ) latest on true
  order by p.known_at, p.point_key;
end
$$;

revoke all on signal_atlas.economic_calendar_snapshots,
  signal_atlas.economic_calendar_fetch_snapshots
from public, anon, authenticated, service_role;

revoke all on function public.archive_economic_calendar(uuid,timestamptz,jsonb),
  public.calendar_replay_snapshots(jsonb,integer)
from public, anon, authenticated, service_role;

grant execute on function public.archive_economic_calendar(uuid,timestamptz,jsonb),
  public.calendar_replay_snapshots(jsonb,integer)
to service_role;

comment on table signal_atlas.economic_calendar_snapshots is
  'Private append-only complete provider snapshots used to reproduce removals and cancellations causally.';
comment on table signal_atlas.economic_calendar_fetch_snapshots is
  'Private append-only mapping from each successful fetch to its exact complete snapshot.';
comment on function public.calendar_replay_snapshots(jsonb,integer) is
  'Service-role-only bounded batch reconstruction of the latest complete calendar snapshot known at each replay point.';

commit;
