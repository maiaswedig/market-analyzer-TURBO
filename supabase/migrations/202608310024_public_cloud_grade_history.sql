-- Read-only browser projection for the prospectively frozen A/A+ paper ledger.
-- This migration does not update historical records and this view is never
-- consumed by ranking, inference, training or model promotion.

begin;

create index if not exists decision_grade_history_idx
on signal_atlas.decision_events (mode, decision_at desc)
where model_role = 'champion'
  and pg_catalog.upper(coalesce(feature_snapshot->>'grade', 'D')) in ('A', 'A+');

create or replace function signal_atlas.cloud_grade_history_rows()
returns table(
  id uuid,
  symbol text,
  market text,
  timeframe text,
  mode text,
  direction text,
  expiration text,
  grade text,
  quality text,
  score numeric,
  probability numeric,
  sample_size integer,
  expected_ev numeric,
  decision_at timestamptz,
  entry_at timestamptz,
  expiry_at timestamptz,
  data_age_ms integer,
  source_latency_ms integer,
  used_live_candle boolean,
  outcome text,
  resolved_at timestamptz,
  entry_price numeric,
  close_price numeric,
  pnl numeric,
  reason text
)
language sql
stable
security definer
set search_path = ''
as $function$
select
  d.id,
  a.symbol,
  a.market::text,
  d.timeframe::text,
  d.mode::text,
  d.direction::text,
  d.expiration::text,
  pg_catalog.upper(coalesce(d.feature_snapshot->>'grade', 'D')),
  d.quality::text,
  d.score,
  d.probability,
  d.statistical_sample_size,
  d.expected_ev,
  d.decision_at,
  d.entry_at,
  d.expiry_at,
  d.data_age_ms,
  d.source_latency_ms,
  d.used_live_candle,
  case
    when o.id is not null then o.decision_result
    when ra.id is not null then 'unresolved_missing_data'
    when pg_catalog.statement_timestamp() < d.expiry_at then 'pending'
    else 'awaiting_resolution'
  end::text,
  coalesce(o.resolved_at, ra.abandoned_at),
  o.entry_price,
  o.close_price,
  pe.pnl,
  coalesce(d.reasons->>0, 'registro prospectivo congelado antes da entrada')
from signal_atlas.decision_events d
join signal_atlas.assets a on a.id = d.asset_id
left join signal_atlas.outcomes o on o.decision_event_id = d.id
left join signal_atlas.resolution_abandonments ra on ra.decision_event_id = d.id
left join signal_atlas.paper_trades pt on pt.decision_event_id = d.id
left join signal_atlas.paper_trade_events pe
  on pe.paper_trade_id = pt.id
 and pe.event_type = 'resolved'::signal_atlas.paper_event_code
where d.model_role = 'champion'
  and pg_catalog.upper(coalesce(d.feature_snapshot->>'grade', 'D')) in ('A', 'A+')
  and not exists (
    select 1
    from signal_atlas.correction_events c
    where c.correction_type = 'invalidate'
      and (
        (c.target_type = 'decision' and c.target_id = d.id)
        or (c.target_type = 'paper_trade' and c.target_id = pt.id)
        or (c.target_type = 'outcome' and c.target_id = o.id)
      )
  )
$function$;

create or replace view public.cloud_grade_history
with (security_invoker = true)
as
select * from signal_atlas.cloud_grade_history_rows();

revoke all on function signal_atlas.cloud_grade_history_rows()
from public, anon, authenticated, service_role;
grant execute on function signal_atlas.cloud_grade_history_rows()
to anon, authenticated, service_role;

revoke all on public.cloud_grade_history
from public, anon, authenticated, service_role;
grant select on public.cloud_grade_history
to anon, authenticated, service_role;

comment on function signal_atlas.cloud_grade_history_rows() is
  'Fixed-search-path projection of frozen champion A/A+ paper decisions, including low quality; UI diagnostics only.';
comment on view public.cloud_grade_history is
  'Read-only A/A+ paper history. It never feeds ranking, training, inference or model promotion.';

commit;
