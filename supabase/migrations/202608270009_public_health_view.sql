-- Keep health readable through RLS without exposing the private candle store.
-- The scanner run timestamp is the authoritative public collection heartbeat.

begin;

create or replace view public.cloud_system_health
with (security_invoker = true)
as
with latest_run as (
  select * from signal_atlas.scanner_runs
  order by finished_at desc, id desc
  limit 1
), counts as (
  select count(*) as resolved from signal_atlas.outcomes
)
select
  coalesce(r.details->>'last_symbol', '—') as processed_asset,
  coalesce(r.details->>'last_timeframe', '') as timeframe,
  r.finished_at as last_collection_at,
  c.resolved as resolved_prospective_signals,
  coalesce(r.status::text, 'initializing') as status,
  r.finished_at as updated_at
from counts c
left join latest_run r on true;

revoke all on public.cloud_system_health from public;
grant select on public.cloud_system_health to anon, authenticated, service_role;

commit;
