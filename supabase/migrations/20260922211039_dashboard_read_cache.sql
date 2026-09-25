begin;

set local lock_timeout='3s';

set local statement_timeout='120s';

create materialized view signal_atlas.cloud_grade_a_session_diagnostics_cache as select row_number() over () as cache_row_id,q.*,statement_timestamp() as cached_as_of from (SELECT symbol,
    timeframe,
    direction,
    utc_session,
    utc_hour,
    source,
    data_age_bucket,
    latency_bucket,
    trades,
    wins,
    losses,
    ties,
    win_rate,
    ev_per_trade,
    avg_data_age_ms,
    avg_source_latency_ms
   FROM signal_atlas.cloud_grade_a_session_diagnostic_rows() cloud_grade_a_session_diagnostic_rows(symbol, timeframe, direction, utc_session, utc_hour, source, data_age_bucket, latency_bucket, trades, wins, losses, ties, win_rate, ev_per_trade, avg_data_age_ms, avg_source_latency_ms)) q;

create unique index cloud_grade_a_session_diagnostics_cache_pk on signal_atlas.cloud_grade_a_session_diagnostics_cache(cache_row_id);

revoke all on signal_atlas.cloud_grade_a_session_diagnostics_cache from public,anon,authenticated;

create function signal_atlas.cloud_grade_a_session_diagnostics_cached_rows() returns setof signal_atlas.cloud_grade_a_session_diagnostics_cache language sql stable security definer set search_path='' as $$ select * from signal_atlas.cloud_grade_a_session_diagnostics_cache; $$;

revoke all on function signal_atlas.cloud_grade_a_session_diagnostics_cached_rows() from public;

grant execute on function signal_atlas.cloud_grade_a_session_diagnostics_cached_rows() to anon,authenticated,service_role;

create or replace view public.cloud_grade_a_session_diagnostics with (security_invoker=true) as select symbol,
    timeframe,
    direction,
    utc_session,
    utc_hour,
    source,
    data_age_bucket,
    latency_bucket,
    trades,
    wins,
    losses,
    ties,
    win_rate,
    ev_per_trade,
    avg_data_age_ms,
    avg_source_latency_ms,cached_as_of from signal_atlas.cloud_grade_a_session_diagnostics_cached_rows();

select cron.schedule('refresh-cloud_grade_a_session_diagnostics_cache','0,15,30,45 * * * *',$cron$set statement_timeout='50s'; refresh materialized view concurrently signal_atlas.cloud_grade_a_session_diagnostics_cache;$cron$);

create materialized view signal_atlas.cloud_single_grade_calibration_cache as select row_number() over () as cache_row_id,q.*,statement_timestamp() as cached_as_of from (SELECT grade,
    trades,
    wins,
    losses,
    ties,
    win_rate,
    wilson_lower,
    wilson_upper,
    ev_per_trade
   FROM signal_atlas.cloud_single_grade_calibration_rows() cloud_single_grade_calibration_rows(grade, trades, wins, losses, ties, win_rate, wilson_lower, wilson_upper, ev_per_trade)) q;

create unique index cloud_single_grade_calibration_cache_pk on signal_atlas.cloud_single_grade_calibration_cache(cache_row_id);

revoke all on signal_atlas.cloud_single_grade_calibration_cache from public,anon,authenticated;

create function signal_atlas.cloud_single_grade_calibration_cached_rows() returns setof signal_atlas.cloud_single_grade_calibration_cache language sql stable security definer set search_path='' as $$ select * from signal_atlas.cloud_single_grade_calibration_cache; $$;

revoke all on function signal_atlas.cloud_single_grade_calibration_cached_rows() from public;

grant execute on function signal_atlas.cloud_single_grade_calibration_cached_rows() to anon,authenticated,service_role;

create or replace view public.cloud_single_grade_calibration with (security_invoker=true) as select grade,
    trades,
    wins,
    losses,
    ties,
    win_rate,
    wilson_lower,
    wilson_upper,
    ev_per_trade,cached_as_of from signal_atlas.cloud_single_grade_calibration_cached_rows();

select cron.schedule('refresh-cloud_single_grade_calibration_cache','1,16,31,46 * * * *',$cron$set statement_timeout='50s'; refresh materialized view concurrently signal_atlas.cloud_single_grade_calibration_cache;$cron$);

create materialized view signal_atlas.cloud_single_naive_baselines_cache as select row_number() over () as cache_row_id,q.*,statement_timestamp() as cached_as_of from (SELECT strategy,
    opportunities,
    trades,
    wins,
    losses,
    ties,
    coverage,
    win_rate,
    ev_per_opportunity,
    ev_per_trade,
    sample_scope
   FROM signal_atlas.cloud_single_naive_baselines_rows() cloud_single_naive_baselines_rows(strategy, opportunities, trades, wins, losses, ties, coverage, win_rate, ev_per_opportunity, ev_per_trade, sample_scope)) q;

create unique index cloud_single_naive_baselines_cache_pk on signal_atlas.cloud_single_naive_baselines_cache(cache_row_id);

revoke all on signal_atlas.cloud_single_naive_baselines_cache from public,anon,authenticated;

create function signal_atlas.cloud_single_naive_baselines_cached_rows() returns setof signal_atlas.cloud_single_naive_baselines_cache language sql stable security definer set search_path='' as $$ select * from signal_atlas.cloud_single_naive_baselines_cache; $$;

revoke all on function signal_atlas.cloud_single_naive_baselines_cached_rows() from public;

grant execute on function signal_atlas.cloud_single_naive_baselines_cached_rows() to anon,authenticated,service_role;

create or replace view public.cloud_single_naive_baselines with (security_invoker=true) as select strategy,
    opportunities,
    trades,
    wins,
    losses,
    ties,
    coverage,
    win_rate,
    ev_per_opportunity,
    ev_per_trade,
    sample_scope,cached_as_of from signal_atlas.cloud_single_naive_baselines_cached_rows();

select cron.schedule('refresh-cloud_single_naive_baselines_cache','2,17,32,47 * * * *',$cron$set statement_timeout='50s'; refresh materialized view concurrently signal_atlas.cloud_single_naive_baselines_cache;$cron$);

create materialized view signal_atlas.cloud_single_paper_summary_cache as select row_number() over () as cache_row_id,q.*,statement_timestamp() as cached_as_of from (SELECT trades,
    ev_net_per_trade,
    total_pnl,
    max_drawdown,
    updated_at,
    mode,
    benchmark_ev_per_trade,
    edge_vs_benchmark
   FROM signal_atlas.cloud_single_paper_summary_rows() cloud_single_paper_summary_rows(trades, ev_net_per_trade, total_pnl, max_drawdown, updated_at, mode, benchmark_ev_per_trade, edge_vs_benchmark)) q;

create unique index cloud_single_paper_summary_cache_pk on signal_atlas.cloud_single_paper_summary_cache(cache_row_id);

revoke all on signal_atlas.cloud_single_paper_summary_cache from public,anon,authenticated;

create function signal_atlas.cloud_single_paper_summary_cached_rows() returns setof signal_atlas.cloud_single_paper_summary_cache language sql stable security definer set search_path='' as $$ select * from signal_atlas.cloud_single_paper_summary_cache; $$;

revoke all on function signal_atlas.cloud_single_paper_summary_cached_rows() from public;

grant execute on function signal_atlas.cloud_single_paper_summary_cached_rows() to anon,authenticated,service_role;

create or replace view public.cloud_single_paper_summary with (security_invoker=true) as select trades,
    ev_net_per_trade,
    total_pnl,
    max_drawdown,
    updated_at,
    mode,
    benchmark_ev_per_trade,
    edge_vs_benchmark,cached_as_of from signal_atlas.cloud_single_paper_summary_cached_rows();

select cron.schedule('refresh-cloud_single_paper_summary_cache','3,18,33,48 * * * *',$cron$set statement_timeout='50s'; refresh materialized view concurrently signal_atlas.cloud_single_paper_summary_cache;$cron$);

create materialized view signal_atlas.cloud_single_quality_paper_summary_cache as select row_number() over () as cache_row_id,q.*,statement_timestamp() as cached_as_of from (SELECT trades,
    wins,
    losses,
    ties,
    win_rate,
    ev_net_per_trade,
    total_pnl,
    max_drawdown,
    updated_at,
    mode,
    quality,
    benchmark_ev_per_trade,
    edge_vs_benchmark,
    sample_status
   FROM signal_atlas.cloud_single_quality_paper_summary_rows() cloud_single_quality_paper_summary_rows(trades, wins, losses, ties, win_rate, ev_net_per_trade, total_pnl, max_drawdown, updated_at, mode, quality, benchmark_ev_per_trade, edge_vs_benchmark, sample_status)) q;

create unique index cloud_single_quality_paper_summary_cache_pk on signal_atlas.cloud_single_quality_paper_summary_cache(cache_row_id);

revoke all on signal_atlas.cloud_single_quality_paper_summary_cache from public,anon,authenticated;

create function signal_atlas.cloud_single_quality_paper_summary_cached_rows() returns setof signal_atlas.cloud_single_quality_paper_summary_cache language sql stable security definer set search_path='' as $$ select * from signal_atlas.cloud_single_quality_paper_summary_cache; $$;

revoke all on function signal_atlas.cloud_single_quality_paper_summary_cached_rows() from public;

grant execute on function signal_atlas.cloud_single_quality_paper_summary_cached_rows() to anon,authenticated,service_role;

create or replace view public.cloud_single_quality_paper_summary with (security_invoker=true) as select trades,
    wins,
    losses,
    ties,
    win_rate,
    ev_net_per_trade,
    total_pnl,
    max_drawdown,
    updated_at,
    mode,
    quality,
    benchmark_ev_per_trade,
    edge_vs_benchmark,
    sample_status,cached_as_of from signal_atlas.cloud_single_quality_paper_summary_cached_rows();

select cron.schedule('refresh-cloud_single_quality_paper_summary_cache','4,19,34,49 * * * *',$cron$set statement_timeout='50s'; refresh materialized view concurrently signal_atlas.cloud_single_quality_paper_summary_cache;$cron$);

create materialized view signal_atlas.cloud_strategy_lab_cache as select row_number() over () as cache_row_id,q.*,statement_timestamp() as cached_as_of from (SELECT strategy_version,
    arm,
    opportunities,
    distinct_days,
    trades,
    wins,
    losses,
    ties,
    coverage,
    win_rate,
    ev_per_opportunity,
    random_benchmark_ev,
    delta_vs_random,
    delta_vs_random_lb95,
    review_ready,
    beats_random_conservatively,
    first_decision_at,
    last_resolved_at,
    ev_per_trade,
    coverage_matched_random_ev,
    random_benchmark_ev_per_trade
   FROM signal_atlas.strategy_lab_summary_rows() strategy_lab_summary_rows(strategy_version, arm, opportunities, distinct_days, trades, wins, losses, ties, coverage, win_rate, ev_per_opportunity, random_benchmark_ev, delta_vs_random, delta_vs_random_lb95, review_ready, beats_random_conservatively, first_decision_at, last_resolved_at, ev_per_trade, coverage_matched_random_ev, random_benchmark_ev_per_trade)) q;

create unique index cloud_strategy_lab_cache_pk on signal_atlas.cloud_strategy_lab_cache(cache_row_id);

revoke all on signal_atlas.cloud_strategy_lab_cache from public,anon,authenticated;

create function signal_atlas.cloud_strategy_lab_cached_rows() returns setof signal_atlas.cloud_strategy_lab_cache language sql stable security definer set search_path='' as $$ select * from signal_atlas.cloud_strategy_lab_cache; $$;

revoke all on function signal_atlas.cloud_strategy_lab_cached_rows() from public;

grant execute on function signal_atlas.cloud_strategy_lab_cached_rows() to anon,authenticated,service_role;

create or replace view public.cloud_strategy_lab with (security_invoker=true) as select strategy_version,
    arm,
    opportunities,
    distinct_days,
    trades,
    wins,
    losses,
    ties,
    coverage,
    win_rate,
    ev_per_opportunity,
    random_benchmark_ev,
    delta_vs_random,
    delta_vs_random_lb95,
    review_ready,
    beats_random_conservatively,
    first_decision_at,
    last_resolved_at,
    ev_per_trade,
    coverage_matched_random_ev,
    random_benchmark_ev_per_trade,cached_as_of from signal_atlas.cloud_strategy_lab_cached_rows();

select cron.schedule('refresh-cloud_strategy_lab_cache','5,20,35,50 * * * *',$cron$set statement_timeout='50s'; refresh materialized view concurrently signal_atlas.cloud_strategy_lab_cache;$cron$);

create materialized view signal_atlas.opportunity_history_cache as 
  select
    d.asset_id,
    d.timeframe,
    d.direction,
    d.expiration,
    d.mode,
    pg_catalog.count(*)::bigint as resolved,
    pg_catalog.count(*) filter (where e.result = 'win')::bigint as wins,
    pg_catalog.avg((e.result = 'win')::integer::numeric) as win_rate,
    pg_catalog.avg(e.pnl) as ev_net_per_trade,
    pg_catalog.count(*) filter (where e.result = 'tie') as ties,
    pg_catalog.avg(case when e.result = 'tie' then case d.tie_policy when 'win' then d.stake * d.payout_ratio - d.operation_cost when 'refund' then -d.operation_cost else -d.stake - d.operation_cost end else d.stake * (d.payout_ratio - 1) / 2 - d.operation_cost end) as benchmark_ev
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
    and not exists (select 1 from signal_atlas.correction_events x where x.correction_type = 'invalidate' and (x.target_type = 'decision' and x.target_id = d.id))
    and not exists (select 1 from signal_atlas.correction_events x where x.correction_type = 'invalidate' and (x.target_type = 'paper_trade' and x.target_id = t.id))
    and not exists (select 1 from signal_atlas.correction_events x where x.correction_type = 'invalidate' and (x.target_type = 'outcome' and x.target_id = e.outcome_id))
  group by d.asset_id, d.timeframe, d.direction, d.expiration, d.mode
;

create unique index opportunity_history_cache_pk on signal_atlas.opportunity_history_cache(asset_id,timeframe,direction,expiration,mode);

revoke all on signal_atlas.opportunity_history_cache from public,anon,authenticated;

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
), valid as (
  select
    d.*,
    a.symbol,
    a.market,
    pg_catalog.row_number() over (
      partition by d.asset_id, d.timeframe, d.mode
      order by d.probability desc, d.score desc, d.decision_at desc, d.id desc
    ) as segment_rank
  from signal_atlas.decision_events d
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



select cron.schedule('refresh-opportunity-history','6,21,36,51 * * * *',$cron$set statement_timeout='50s'; refresh materialized view concurrently signal_atlas.opportunity_history_cache;$cron$);

commit;
