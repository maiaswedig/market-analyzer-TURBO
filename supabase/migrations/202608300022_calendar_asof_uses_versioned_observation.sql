begin;

-- Never project a later taxonomy revision into an earlier backtest. The
-- canonical row is only an index; historically visible title/category come
-- from the latest observation that was already known at p_known_at.
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
  select e.id, e.source, e.event_key,
    coalesce(observed.payload->>'currency', e.currency) as currency,
    coalesce(observed.payload->>'title', e.title) as title,
    coalesce(observed.payload->>'category', e.category) as category,
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

revoke all on function signal_atlas.calendar_events_as_of(timestamptz,timestamptz,timestamptz,text[])
from public, anon, authenticated, service_role;

comment on function signal_atlas.calendar_events_as_of(timestamptz,timestamptz,timestamptz,text[]) is
  'Private causal reconstruction using the observation payload/version known at p_known_at.';

commit;
