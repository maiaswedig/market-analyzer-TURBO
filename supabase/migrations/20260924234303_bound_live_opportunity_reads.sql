begin;
set local lock_timeout='3s';
CREATE OR REPLACE FUNCTION signal_atlas.cloud_opportunities_rows()
 RETURNS TABLE(id uuid, symbol text, market signal_atlas.market_code, timeframe text, mode text, direction text, expiration text, quality text, score numeric, probability numeric, sample_size integer, ev_net numeric, decision_at timestamp with time zone, entry_at timestamp with time zone, expiry_at timestamp with time zone, data_age_ms integer, source_latency_ms integer, used_live_candle boolean, reason text, rank bigint, grade text, resolved bigint, historical_win_rate numeric, historical_ev_net numeric, benchmark_win_rate numeric, benchmark_ev_per_trade numeric, probability_lb numeric, shrunk_win_rate numeric, ranking_score numeric, sample_status text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
with clock as materialized (select pg_catalog.clock_timestamp() as as_of), champion_ranked as (
  select
    e.asset_id,
    e.timeframe,
    e.model_artifact_id,
    e.action,
    pg_catalog.row_number() over (
      partition by e.asset_id, e.timeframe
      order by e.effective_at desc, e.created_at desc, e.id desc
    ) as rn
  from signal_atlas.model_deployment_events e
  where e.effective_at <= pg_catalog.clock_timestamp()
), champions as (
  select c.asset_id, c.timeframe, c.model_artifact_id
  from champion_ranked c
  where c.rn = 1 and c.action <> 'retire_champion'
), upcoming as materialized (
 select * from signal_atlas.decision_events
 where model_role='champion' and entry_at>pg_catalog.statement_timestamp()
 and decision_at<=pg_catalog.statement_timestamp()
), valid as (
  select
    d.*,
    a.symbol,
    a.market,
    pg_catalog.row_number() over (
      partition by d.asset_id, d.timeframe, d.mode
      order by d.probability desc, d.score desc, d.decision_at desc, d.id desc
    ) as segment_rank
  from upcoming d
  join signal_atlas.assets a on a.id = d.asset_id and a.active
  join champions c
    on c.asset_id = d.asset_id
   and c.timeframe = d.timeframe
   and c.model_artifact_id = d.model_artifact_id
  where d.model_role = 'champion'
    and (select as_of from clock) >= d.decision_at
    and (select as_of from clock) < d.entry_at
    and not exists (
      select 1 from signal_atlas.correction_events x
      where x.target_type = 'decision'
        and x.target_id = d.id
        and x.correction_type = 'invalidate'
    )
), history as (select * from signal_atlas.opportunity_history_cache
), base as (
  select
    v.id,
    v.symbol,
    v.market,
    v.timeframe::text as timeframe,
    v.mode::text as mode,
    v.direction::text as direction,
    v.expiration::text as expiration,
    v.quality::text as quality,
    v.score,
    v.probability,
    v.statistical_sample_size as sample_size,
    v.expected_ev as ev_net,
    v.decision_at,
    v.entry_at,
    v.expiry_at,
    v.data_age_ms,
    v.source_latency_ms,
    v.used_live_candle,
    coalesce(v.reasons->>0, 'Oportunidade prospectiva aguardando entrada.') as reason,
    coalesce(nullif(v.feature_snapshot->>'grade', ''), 'D') as grade,
    coalesce(h.resolved, 0)::bigint as resolved,
    h.win_rate as historical_win_rate,
    h.ev_net_per_trade as historical_ev_net,
    (0.5 * (1 - coalesce(h.ties::numeric / nullif(h.resolved, 0), 0)))::numeric as benchmark_win_rate,
    (coalesce(h.benchmark_ev, v.stake * (v.payout_ratio - 1) / 2 - v.operation_cost))::numeric
      as benchmark_ev_per_trade,
    ((coalesce(h.wins, 0) + 25.0) / (coalesce(h.resolved, 0) + 50.0))::numeric
      as shrunk_win_rate,
    case coalesce(nullif(v.feature_snapshot->>'grade', ''), 'D')
      when 'A+' then 100 when 'A' then 92 when 'B' then 78
      when 'C' then 62 else 45 end::numeric as grade_score,
    case v.quality::text
      when 'confirmed' then 100 when 'technical' then 75 else 45 end::numeric
      as quality_score,
    coalesce(
      v.probability_lb,
      greatest(0::numeric,
        v.probability - 1.5 * pg_catalog.sqrt(
          greatest(0::numeric, v.probability * (1 - v.probability))
          / greatest(v.statistical_sample_size, 1)
        )
      )
    )::numeric as probability_lb
  from valid v
  left join history h
    on h.asset_id = v.asset_id
   and h.timeframe = v.timeframe
   and h.direction = v.direction
   and h.expiration = v.expiration
   and h.mode = v.mode
  where v.segment_rank = 1
), scored as (
  select b.*,
    (
      0.35 * coalesce(b.probability_lb, 0.5) * 100
      + 0.25 * coalesce(b.score, 50)
      + 0.25 * b.shrunk_win_rate * 100
      + 0.10 * b.grade_score
      + 0.05 * b.quality_score
    )::numeric as ranking_score
  from base b
)
select
  s.id,
  s.symbol,
  s.market,
  s.timeframe,
  s.mode,
  s.direction,
  s.expiration,
  s.quality,
  s.score,
  s.probability,
  s.sample_size,
  s.ev_net,
  s.decision_at,
  s.entry_at,
  s.expiry_at,
  s.data_age_ms,
  s.source_latency_ms,
  s.used_live_candle,
  s.reason,
  pg_catalog.row_number() over (
    order by s.ranking_score desc, s.probability_lb desc,
      s.score desc, s.entry_at, s.id
  ) as rank,
  s.grade,
  s.resolved,
  s.historical_win_rate,
  s.historical_ev_net,
  s.benchmark_win_rate,
  s.benchmark_ev_per_trade,
  s.probability_lb,
  s.shrunk_win_rate,
  s.ranking_score,
  case when s.resolved >= 300 then 'prospective_validated' else 'building_sample' end::text
    as sample_status
from scored s
$function$
;
commit;
