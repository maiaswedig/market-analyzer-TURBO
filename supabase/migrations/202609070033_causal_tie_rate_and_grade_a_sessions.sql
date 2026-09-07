begin;

-- The causal tie-rate change lives in the versioned Edge artifact (validation
-- policy v4). This migration adds the read-only database diagnosis requested
-- for the grade-A investigation without rewriting any historical decision.
create index if not exists decision_grade_a_session_diagnostic_idx
  on signal_atlas.decision_events (
    asset_id,
    timeframe,
    decision_at,
    data_age_ms,
    source_latency_ms
  )
  where mode = 'neutro'
    and feature_snapshot->>'grade' = 'A';

create or replace function signal_atlas.cloud_grade_a_session_diagnostic_rows()
returns table(
  symbol text,
  timeframe text,
  direction text,
  utc_session text,
  utc_hour smallint,
  source text,
  data_age_bucket text,
  latency_bucket text,
  trades bigint,
  wins bigint,
  losses bigint,
  ties bigint,
  win_rate numeric,
  ev_per_trade numeric,
  avg_data_age_ms numeric,
  avg_source_latency_ms numeric
)
language sql
stable
security definer
set search_path = ''
as $function$
  with valid_grade_a as (
    select
      a.symbol,
      d.timeframe,
      d.direction,
      extract(hour from d.decision_at at time zone 'UTC')::smallint as utc_hour,
      coalesce(nullif(d.data_lineage->>'source', ''), a.source::text, 'indefinido') as source,
      d.data_age_ms,
      d.source_latency_ms,
      o.decision_result,
      signal_atlas.trade_pnl(
        d.direction,
        o.entry_price,
        o.close_price,
        d.stake,
        d.payout_ratio,
        d.operation_cost,
        d.tie_policy
      ) as pnl
    from signal_atlas.decision_events d
    join signal_atlas.assets a on a.id = d.asset_id
    join signal_atlas.outcomes o on o.decision_event_id = d.id
    join signal_atlas.policy_versions p on p.id = d.policy_version_id
    where p.policy_key = 'cloud-engine-single'
      and d.mode = 'neutro'
      and d.feature_snapshot->>'grade' = 'A'
      and o.resolved_at >= d.expiry_at
      and not exists (
        select 1
        from signal_atlas.correction_events ce
        where ce.correction_type = 'invalidate'
          and ((ce.target_type = 'decision' and ce.target_id = d.id)
            or (ce.target_type = 'outcome' and ce.target_id = o.id))
      )
  ), bucketed as (
    select
      v.*,
      case
        when v.utc_hour < 8 then 'UTC 00–07'
        when v.utc_hour < 16 then 'UTC 08–15'
        else 'UTC 16–23'
      end as utc_session,
      case
        when v.data_age_ms < 1000 then '<1s'
        when v.data_age_ms < 5000 then '1–5s'
        when v.data_age_ms < 30000 then '5–30s'
        else '>30s'
      end as data_age_bucket,
      case
        when v.source_latency_ms < 1000 then '<1s'
        when v.source_latency_ms < 5000 then '1–5s'
        when v.source_latency_ms < 30000 then '5–30s'
        else '>30s'
      end as latency_bucket
    from valid_grade_a v
  )
  select
    b.symbol,
    b.timeframe::text,
    b.direction::text,
    b.utc_session,
    b.utc_hour,
    b.source,
    b.data_age_bucket,
    b.latency_bucket,
    pg_catalog.count(*)::bigint as trades,
    pg_catalog.count(*) filter (where b.decision_result = 'win')::bigint as wins,
    pg_catalog.count(*) filter (where b.decision_result = 'loss')::bigint as losses,
    pg_catalog.count(*) filter (where b.decision_result = 'tie')::bigint as ties,
    pg_catalog.avg((b.decision_result = 'win')::integer::numeric) as win_rate,
    pg_catalog.avg(b.pnl) as ev_per_trade,
    pg_catalog.avg(b.data_age_ms::numeric) as avg_data_age_ms,
    pg_catalog.avg(b.source_latency_ms::numeric) as avg_source_latency_ms
  from bucketed b
  group by
    b.symbol,
    b.timeframe,
    b.direction,
    b.utc_session,
    b.utc_hour,
    b.source,
    b.data_age_bucket,
    b.latency_bucket
  having pg_catalog.count(*) >= 5
  order by pg_catalog.count(*) desc, b.symbol, b.timeframe, b.direction, b.utc_hour
$function$;

create or replace view public.cloud_grade_a_session_diagnostics
with (security_invoker = true, security_barrier = true)
as select * from signal_atlas.cloud_grade_a_session_diagnostic_rows();

revoke all on function signal_atlas.cloud_grade_a_session_diagnostic_rows()
from public, anon, authenticated, service_role;
grant execute on function signal_atlas.cloud_grade_a_session_diagnostic_rows()
to anon, authenticated, service_role;

revoke all on public.cloud_grade_a_session_diagnostics
from public, anon, authenticated, service_role;
grant select on public.cloud_grade_a_session_diagnostics
to anon, authenticated, service_role;

comment on function signal_atlas.cloud_grade_a_session_diagnostic_rows() is
  'Read-only grade-A diagnosis by UTC session/hour, provider and data-age/latency buckets. Uses only valid outcomes resolved at or after expiry.';
comment on view public.cloud_grade_a_session_diagnostics is
  'Aggregate diagnostic for grade A. It never changes signal direction, score weights, quality or model promotion.';

commit;
