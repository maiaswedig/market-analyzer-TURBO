begin;

-- Migration 020 committed the enum value in isolation. Runtime helpers may now
-- reference M30 without PostgreSQL's unsafe-new-enum-value error.
create or replace function signal_atlas.timeframe_seconds(p_timeframe signal_atlas.timeframe_code)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select case p_timeframe
    when 'M5'::signal_atlas.timeframe_code then 300
    when 'M15'::signal_atlas.timeframe_code then 900
    when 'M30'::signal_atlas.timeframe_code then 1800
    when 'H1'::signal_atlas.timeframe_code then 3600
  end
$$;

-- The canonical event row is a compact index. Every changing observation
-- (forecast, previous, actual) is stored separately and append-only, making an
-- as-of reconstruction possible without projecting future releases backwards.
create table if not exists signal_atlas.economic_calendar_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  source text not null,
  event_key text not null,
  currency text not null check (currency in ('USD', 'EUR', 'GBP')),
  title text not null,
  category text not null check (category in (
    'rate_decision', 'inflation', 'employment', 'growth',
    'central_bank', 'other_high_impact'
  )),
  category_version integer not null check (category_version >= 1),
  scheduled_at timestamptz not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (source, event_key),
  check (pg_catalog.length(pg_catalog.btrim(source)) between 1 and 80),
  check (pg_catalog.length(pg_catalog.btrim(event_key)) between 1 and 512),
  check (pg_catalog.length(pg_catalog.btrim(title)) between 1 and 240),
  check (last_seen_at >= first_seen_at)
);

create table if not exists signal_atlas.economic_calendar_observations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  event_id uuid not null references signal_atlas.economic_calendar_events(id),
  fetched_at timestamptz not null,
  snapshot_hash text not null,
  payload jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (event_id, snapshot_hash),
  check (pg_catalog.length(snapshot_hash) = 64),
  check (pg_catalog.jsonb_typeof(payload) = 'object')
);

create table if not exists signal_atlas.economic_calendar_fetches (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  run_id uuid not null unique,
  source text not null,
  fetched_at timestamptz not null,
  status text not null check (status in ('success', 'error')),
  event_count integer not null default 0 check (event_count >= 0),
  error_message text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check ((status = 'success' and error_message is null) or status = 'error')
);

create index if not exists economic_calendar_events_schedule_idx
  on signal_atlas.economic_calendar_events (scheduled_at, currency, category);
create index if not exists economic_calendar_observations_asof_idx
  on signal_atlas.economic_calendar_observations (event_id, fetched_at desc);
create index if not exists economic_calendar_fetches_latest_idx
  on signal_atlas.economic_calendar_fetches (fetched_at desc);

alter table signal_atlas.economic_calendar_events enable row level security;
alter table signal_atlas.economic_calendar_events force row level security;
alter table signal_atlas.economic_calendar_observations enable row level security;
alter table signal_atlas.economic_calendar_observations force row level security;
alter table signal_atlas.economic_calendar_fetches enable row level security;
alter table signal_atlas.economic_calendar_fetches force row level security;

drop trigger if exists economic_calendar_observations_append_only_guard
  on signal_atlas.economic_calendar_observations;
create trigger economic_calendar_observations_append_only_guard
before update or delete on signal_atlas.economic_calendar_observations
for each row execute function signal_atlas.reject_update_delete();

drop trigger if exists economic_calendar_fetches_append_only_guard
  on signal_atlas.economic_calendar_fetches;
create trigger economic_calendar_fetches_append_only_guard
before update or delete on signal_atlas.economic_calendar_fetches
for each row execute function signal_atlas.reject_update_delete();

create or replace function signal_atlas.archive_economic_calendar_at(
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
  v_source text;
  v_error text;
  v_status text;
  v_events jsonb;
  v_event jsonb;
  v_event_id uuid;
  v_fetch_id uuid;
  v_scheduled_at timestamptz;
  v_currency text;
  v_title text;
  v_event_key text;
  v_category text;
  v_category_version integer;
  v_payload jsonb;
  v_hash text;
  v_event_count integer := 0;
  v_events_inserted integer := 0;
  v_observations_inserted integer := 0;
  v_rows integer;
begin
  if p_run_id is null then
    raise exception using errcode = '22023', message = 'calendar archive run id is required';
  end if;
  if p_fetched_at is null or p_fetched_at > pg_catalog.clock_timestamp() + interval '5 seconds' then
    raise exception using errcode = '23514', message = 'calendar fetched_at cannot be null or in the future';
  end if;
  if p_snapshot is null or pg_catalog.jsonb_typeof(p_snapshot) <> 'object' then
    raise exception using errcode = '22023', message = 'calendar snapshot must be a JSON object';
  end if;

  v_source := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(p_snapshot->>'source'), ''), 'unknown'), 80);
  v_error := nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_snapshot->>'error', '')), 500), '');
  v_status := case when v_error is null then 'success' else 'error' end;
  v_events := coalesce(p_snapshot->'events', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(v_events) <> 'array' then
    raise exception using errcode = '22023', message = 'calendar events must be a JSON array';
  end if;
  if pg_catalog.jsonb_array_length(v_events) > 500 then
    raise exception using errcode = '22023', message = 'calendar snapshot exceeds 500 events';
  end if;

  insert into signal_atlas.economic_calendar_fetches(
    run_id, source, fetched_at, status, event_count, error_message
  ) values (
    p_run_id, v_source, p_fetched_at, v_status,
    pg_catalog.jsonb_array_length(v_events), v_error
  )
  on conflict (run_id) do nothing
  returning id into v_fetch_id;

  if v_fetch_id is null then
    select f.id into v_fetch_id
    from signal_atlas.economic_calendar_fetches f
    where f.run_id = p_run_id;
  end if;

  for v_event in select value from pg_catalog.jsonb_array_elements(v_events)
  loop
    v_currency := pg_catalog.upper(pg_catalog.btrim(coalesce(v_event->>'currency', '')));
    v_title := pg_catalog.left(pg_catalog.btrim(coalesce(v_event->>'title', '')), 240);
    v_event_key := pg_catalog.left(pg_catalog.btrim(coalesce(v_event->>'eventKey', '')), 512);
    v_category := pg_catalog.btrim(coalesce(v_event->>'category', 'other_high_impact'));
    v_category_version := coalesce(nullif(v_event->>'categoryVersion', '')::integer, 1);
    begin
      v_scheduled_at := pg_catalog.to_timestamp((v_event->>'at')::double precision / 1000.0);
    exception when others then
      raise exception using errcode = '22023', message = 'calendar event has an invalid timestamp';
    end;

    if v_currency not in ('USD', 'EUR', 'GBP')
      or pg_catalog.length(v_title) = 0
      or pg_catalog.length(v_event_key) = 0
      or v_category not in (
        'rate_decision', 'inflation', 'employment', 'growth',
        'central_bank', 'other_high_impact'
      )
      or v_category_version < 1
    then
      raise exception using errcode = '22023', message = 'calendar event violates the archive contract';
    end if;

    v_event_count := v_event_count + 1;
    v_event_id := null;
    insert into signal_atlas.economic_calendar_events(
      source, event_key, currency, title, category, category_version,
      scheduled_at, first_seen_at, last_seen_at
    ) values (
      v_source, v_event_key, v_currency, v_title, v_category,
      v_category_version, v_scheduled_at, p_fetched_at, p_fetched_at
    )
    on conflict (source, event_key) do nothing
    returning id into v_event_id;

    if v_event_id is not null then
      v_events_inserted := v_events_inserted + 1;
    else
      select e.id into strict v_event_id
      from signal_atlas.economic_calendar_events e
      where e.source = v_source and e.event_key = v_event_key;
      update signal_atlas.economic_calendar_events
      set last_seen_at = greatest(last_seen_at, p_fetched_at),
          category = v_category,
          category_version = v_category_version
      where id = v_event_id;
    end if;

    v_payload := pg_catalog.jsonb_build_object(
      'currency', v_currency,
      'title', v_title,
      'scheduledAt', v_scheduled_at,
      'impact', 'high',
      'category', v_category,
      'categoryVersion', v_category_version,
      'forecast', nullif(v_event->>'forecast', ''),
      'previous', nullif(v_event->>'previous', ''),
      'actual', nullif(v_event->>'actual', '')
    );
    v_hash := pg_catalog.encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

    insert into signal_atlas.economic_calendar_observations(
      event_id, fetched_at, snapshot_hash, payload
    ) values (v_event_id, p_fetched_at, v_hash, v_payload)
    on conflict (event_id, snapshot_hash) do nothing;
    get diagnostics v_rows = row_count;
    v_observations_inserted := v_observations_inserted + v_rows;
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'fetchId', v_fetch_id,
    'status', v_status,
    'eventCount', v_event_count,
    'eventsInserted', v_events_inserted,
    'observationsInserted', v_observations_inserted
  );
end
$$;

create or replace function signal_atlas.calendar_events_as_of(
  p_known_at timestamptz,
  p_from timestamptz,
  p_to timestamptz,
  p_currencies text[] default null
)
returns table(
  event_id uuid,
  source text,
  event_key text,
  currency text,
  title text,
  category text,
  scheduled_at timestamptz,
  observed_at timestamptz,
  payload jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.source, e.event_key, e.currency, e.title, e.category,
    e.scheduled_at, observed.fetched_at, observed.payload
  from signal_atlas.economic_calendar_events e
  join lateral (
    select o.fetched_at, o.payload
    from signal_atlas.economic_calendar_observations o
    where o.event_id = e.id and o.fetched_at <= p_known_at
    order by o.fetched_at desc, o.id desc
    limit 1
  ) observed on true
  where p_known_at is not null
    and p_known_at <= pg_catalog.clock_timestamp()
    and p_from is not null and p_to is not null
    and p_from <= p_to
    and p_to - p_from <= interval '370 days'
    and e.scheduled_at >= p_from and e.scheduled_at <= p_to
    and (p_currencies is null or e.currency = any(p_currencies))
  order by e.scheduled_at, e.currency, e.id
$$;

create or replace function public.archive_economic_calendar(
  p_run_id uuid,
  p_fetched_at timestamptz,
  p_snapshot jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select signal_atlas.archive_economic_calendar_at(p_run_id, p_fetched_at, p_snapshot)
$$;

revoke all on signal_atlas.economic_calendar_events,
  signal_atlas.economic_calendar_observations,
  signal_atlas.economic_calendar_fetches
from public, anon, authenticated, service_role;

revoke all on function signal_atlas.archive_economic_calendar_at(uuid,timestamptz,jsonb),
  signal_atlas.calendar_events_as_of(timestamptz,timestamptz,timestamptz,text[]),
  public.archive_economic_calendar(uuid,timestamptz,jsonb)
from public, anon, authenticated, service_role;

grant execute on function public.archive_economic_calendar(uuid,timestamptz,jsonb)
to service_role;

comment on table signal_atlas.economic_calendar_events is
  'Private canonical index of economic events first observed prospectively.';
comment on table signal_atlas.economic_calendar_observations is
  'Append-only snapshots; fetched_at is the causal availability boundary for backtests.';
comment on table signal_atlas.economic_calendar_fetches is
  'Append-only audit of successful and failed calendar provider fetches.';
comment on function signal_atlas.calendar_events_as_of(timestamptz,timestamptz,timestamptz,text[]) is
  'Private causal reconstruction: returns only observations known by p_known_at.';
comment on function public.archive_economic_calendar(uuid,timestamptz,jsonb) is
  'Service-role-only ingestion of one bounded economic-calendar snapshot.';

commit;
