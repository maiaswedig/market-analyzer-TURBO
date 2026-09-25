-- Descriptive random benchmark on the same realized outcomes and economics.
-- No training, labels, decisions, promotions or paper PnL are changed.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
CREATE OR REPLACE FUNCTION signal_atlas.cloud_single_paper_summary_rows()
 RETURNS TABLE(trades bigint, ev_net_per_trade numeric, total_pnl numeric, max_drawdown numeric, updated_at timestamp with time zone, mode text, benchmark_ev_per_trade numeric, edge_vs_benchmark numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
with active_policy as (
  select p.id
  from signal_atlas.policy_versions p
  where p.policy_key = 'cloud-engine-single'
    and p.mode = 'neutro'::signal_atlas.mode_code
    and p.version = 1
  order by p.effective_from desc, p.id desc
  limit 1
), events as (
  select
    e.event_at,
    e.paper_trade_id,
    e.result,
    e.pnl,
    d.stake,
    d.tie_policy,
    d.payout_ratio,
    d.operation_cost,
    pg_catalog.sum(e.pnl) over (
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    ) as equity
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
    and d.policy_version_id = (select id from active_policy)
    and not exists (select 1 from signal_atlas.correction_events c where c.correction_type = 'invalidate' and (c.target_type = 'decision' and c.target_id = d.id))
    and not exists (select 1 from signal_atlas.correction_events c where c.correction_type = 'invalidate' and (c.target_type = 'paper_trade' and c.target_id = t.id))
    and not exists (select 1 from signal_atlas.correction_events c where c.correction_type = 'invalidate' and (c.target_type = 'outcome' and c.target_id = e.outcome_id))
), curve as (
  select
    e.*,
    greatest(0::numeric, pg_catalog.max(e.equity) over (
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    )) - e.equity as drawdown
  from events e
), summary as (
  select
    pg_catalog.count(c.paper_trade_id)::bigint as trades,
    pg_catalog.avg(c.pnl) as ev_net_per_trade,
    coalesce(pg_catalog.sum(c.pnl), 0::numeric) as total_pnl,
    coalesce(pg_catalog.max(c.drawdown), 0::numeric) as max_drawdown,
    pg_catalog.max(c.event_at) as updated_at,
    coalesce(pg_catalog.avg(case when c.result = 'tie' then case c.tie_policy when 'win' then c.stake * c.payout_ratio - c.operation_cost when 'refund' then -c.operation_cost else -c.stake - c.operation_cost end else c.stake * (c.payout_ratio - 1) / 2 - c.operation_cost end), -0.075)::numeric as benchmark_ev_per_trade
  from curve c
)
select
  s.trades,
  s.ev_net_per_trade,
  s.total_pnl,
  s.max_drawdown,
  s.updated_at,
  'neutro'::text,
  s.benchmark_ev_per_trade,
  case when s.trades > 0 then (s.ev_net_per_trade - s.benchmark_ev_per_trade)::numeric end
from summary s
$function$

;

CREATE OR REPLACE FUNCTION signal_atlas.cloud_single_quality_paper_summary_rows()
 RETURNS TABLE(trades bigint, wins bigint, losses bigint, ties bigint, win_rate numeric, ev_net_per_trade numeric, total_pnl numeric, max_drawdown numeric, updated_at timestamp with time zone, mode text, quality text, benchmark_ev_per_trade numeric, edge_vs_benchmark numeric, sample_status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
with active_policy as (
  select p.id
  from signal_atlas.policy_versions p
  where p.policy_key = 'cloud-engine-single'
    and p.mode = 'neutro'::signal_atlas.mode_code
    and p.version = 1
  order by p.effective_from desc, p.id desc
  limit 1
), qualities(quality) as (
  values
    ('confirmed'::signal_atlas.signal_quality_code),
    ('technical'::signal_atlas.signal_quality_code),
    ('low'::signal_atlas.signal_quality_code)
), events as (
  select
    d.quality,
    e.event_at,
    e.paper_trade_id,
    e.result,
    e.pnl,
    d.stake,
    d.tie_policy,
    d.payout_ratio,
    d.operation_cost,
    pg_catalog.sum(e.pnl) over (
      partition by d.quality
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    ) as equity
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
    and d.policy_version_id = (select id from active_policy)
    and not exists (select 1 from signal_atlas.correction_events c where c.correction_type = 'invalidate' and (c.target_type = 'decision' and c.target_id = d.id))
    and not exists (select 1 from signal_atlas.correction_events c where c.correction_type = 'invalidate' and (c.target_type = 'paper_trade' and c.target_id = t.id))
    and not exists (select 1 from signal_atlas.correction_events c where c.correction_type = 'invalidate' and (c.target_type = 'outcome' and c.target_id = e.outcome_id))
), curve as (
  select
    e.*,
    greatest(0::numeric, pg_catalog.max(e.equity) over (
      partition by e.quality
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    )) - e.equity as drawdown
  from events e
), summary as (
  select
    q.quality,
    pg_catalog.count(c.paper_trade_id)::bigint as trades,
    pg_catalog.count(c.paper_trade_id) filter (where c.result = 'win')::bigint as wins,
    pg_catalog.count(c.paper_trade_id) filter (where c.result = 'loss')::bigint as losses,
    pg_catalog.count(c.paper_trade_id) filter (where c.result = 'tie')::bigint as ties,
    pg_catalog.avg((c.result = 'win')::integer::numeric) as win_rate,
    pg_catalog.avg(c.pnl) as ev_net_per_trade,
    coalesce(pg_catalog.sum(c.pnl), 0::numeric) as total_pnl,
    coalesce(pg_catalog.max(c.drawdown), 0::numeric) as max_drawdown,
    pg_catalog.max(c.event_at) as updated_at,
    coalesce(pg_catalog.avg(case when c.result = 'tie' then case c.tie_policy when 'win' then c.stake * c.payout_ratio - c.operation_cost when 'refund' then -c.operation_cost else -c.stake - c.operation_cost end else c.stake * (c.payout_ratio - 1) / 2 - c.operation_cost end), -0.075)::numeric as benchmark_ev_per_trade
  from qualities q
  left join curve c on c.quality = q.quality
  group by q.quality
)
select
  s.trades,
  s.wins,
  s.losses,
  s.ties,
  s.win_rate,
  s.ev_net_per_trade,
  s.total_pnl,
  s.max_drawdown,
  s.updated_at,
  'neutro'::text,
  s.quality::text,
  s.benchmark_ev_per_trade,
  case when s.trades > 0 then (s.ev_net_per_trade - s.benchmark_ev_per_trade)::numeric end,
  case when s.trades >= 300 then 'prospective_validated' else 'building_sample' end::text
from summary s
$function$

;

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
), history as (
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

CREATE OR REPLACE FUNCTION signal_atlas.strategy_lab_summary_rows()
 RETURNS TABLE(strategy_version integer, arm text, opportunities bigint, distinct_days bigint, trades bigint, wins bigint, losses bigint, ties bigint, coverage numeric, win_rate numeric, ev_per_opportunity numeric, random_benchmark_ev numeric, delta_vs_random numeric, delta_vs_random_lb95 numeric, review_ready boolean, beats_random_conservatively boolean, first_decision_at timestamp with time zone, last_resolved_at timestamp with time zone, ev_per_trade numeric, coverage_matched_random_ev numeric, random_benchmark_ev_per_trade numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with scored as (
    select
      s.strategy_version,
      s.arm,
      d.id as decision_id,
      d.decision_at,
      o.resolved_at,
      pg_catalog.date_trunc('day', d.entry_at) as decision_day,
      s.action,
      case when s.action = 'wait' then null
        else signal_atlas.trade_result(s.direction, o.entry_price, o.close_price)
      end as result,
      case when s.action = 'wait' then 0::numeric
        else signal_atlas.trade_pnl(
          s.direction, o.entry_price, o.close_price, d.stake,
          d.payout_ratio, d.operation_cost, d.tie_policy
        )
      end as pnl,
      (case when o.entry_price = o.close_price then case d.tie_policy when 'win' then d.stake * d.payout_ratio - d.operation_cost when 'refund' then -d.operation_cost else -d.stake - d.operation_cost end else d.stake * (d.payout_ratio - 1) / 2 - d.operation_cost end) as benchmark_ev,
      case when s.action = 'wait' then 0::numeric
        else (case when o.entry_price = o.close_price then case d.tie_policy when 'win' then d.stake * d.payout_ratio - d.operation_cost when 'refund' then -d.operation_cost else -d.stake - d.operation_cost end else d.stake * (d.payout_ratio - 1) / 2 - d.operation_cost end)
      end as coverage_benchmark_ev
    from signal_atlas.strategy_shadow_arms s
    join signal_atlas.decision_events d on d.id = s.decision_event_id
    join signal_atlas.outcomes o on o.decision_event_id = d.id
    where s.predicted_at < d.entry_at
      and o.resolved_at >= d.expiry_at
      and not exists (select 1 from signal_atlas.correction_events ce where ce.correction_type = 'invalidate' and (ce.target_type = 'decision' and ce.target_id = d.id))
    and not exists (select 1 from signal_atlas.correction_events ce where ce.correction_type = 'invalidate' and (ce.target_type = 'outcome' and ce.target_id = o.id))
  ), daily as (
    select strategy_version, arm, decision_day,
      pg_catalog.avg(pnl - coverage_benchmark_ev) as daily_delta
    from scored
    group by strategy_version, arm, decision_day
  ), daily_stats as (
    select strategy_version, arm,
      pg_catalog.count(*) as day_count,
      pg_catalog.avg(daily_delta) as daily_delta_mean,
      pg_catalog.stddev_samp(daily_delta) as daily_delta_sd
    from daily
    group by strategy_version, arm
  )
  select
    s.strategy_version,
    s.arm,
    pg_catalog.count(*) as opportunities,
    pg_catalog.count(distinct s.decision_day) as distinct_days,
    pg_catalog.count(*) filter (where s.action <> 'wait') as trades,
    pg_catalog.count(*) filter (where s.result = 'win') as wins,
    pg_catalog.count(*) filter (where s.result = 'loss') as losses,
    pg_catalog.count(*) filter (where s.result = 'tie') as ties,
    pg_catalog.count(*) filter (where s.action <> 'wait')::numeric /
      greatest(pg_catalog.count(*), 1) as coverage,
    pg_catalog.count(*) filter (where s.result = 'win')::numeric /
      nullif(pg_catalog.count(*) filter (where s.action <> 'wait'), 0) as win_rate,
    pg_catalog.avg(s.pnl) as ev_per_opportunity,
    pg_catalog.avg(s.benchmark_ev) as random_benchmark_ev,
    pg_catalog.avg(s.pnl - s.coverage_benchmark_ev) as delta_vs_random,
    ds.daily_delta_mean - 1.96 * coalesce(ds.daily_delta_sd, 0) /
      pg_catalog.sqrt(greatest(ds.day_count, 1)::numeric) as delta_vs_random_lb95,
    pg_catalog.count(*) >= 500 and pg_catalog.count(distinct s.decision_day) >= 20 as review_ready,
    pg_catalog.count(*) >= 500
      and pg_catalog.count(distinct s.decision_day) >= 20
      and ds.daily_delta_mean - 1.96 * coalesce(ds.daily_delta_sd, 0) /
        pg_catalog.sqrt(greatest(ds.day_count, 1)::numeric) > 0
      as beats_random_conservatively,
    pg_catalog.min(s.decision_at) as first_decision_at,
    pg_catalog.max(s.resolved_at) as last_resolved_at,
    pg_catalog.avg(s.pnl) filter (where s.action <> 'wait') as ev_per_trade,
    pg_catalog.avg(s.coverage_benchmark_ev) as coverage_matched_random_ev,
    pg_catalog.avg(s.benchmark_ev) filter (where s.action <> 'wait') as random_benchmark_ev_per_trade
  from scored s
  join daily_stats ds
    on ds.strategy_version = s.strategy_version and ds.arm = s.arm
  group by s.strategy_version, s.arm,
    ds.day_count, ds.daily_delta_mean, ds.daily_delta_sd
  order by s.strategy_version desc, s.arm
$function$

;

CREATE OR REPLACE FUNCTION signal_atlas.cloud_single_naive_baselines_rows()
 RETURNS TABLE(strategy text, opportunities bigint, trades bigint, wins bigint, losses bigint, ties bigint, coverage numeric, win_rate numeric, ev_per_opportunity numeric, ev_per_trade numeric, sample_scope text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with resolved as (
    select d.*, o.entry_price, o.close_price,
      prior.direction as prior_direction
    from signal_atlas.decision_events d
    join signal_atlas.outcomes o on o.decision_event_id = d.id
    join signal_atlas.policy_versions p on p.id = d.policy_version_id
    left join lateral (
      select case
        when c.close > c.open then 'buy'::signal_atlas.direction_code
        when c.close < c.open then 'sell'::signal_atlas.direction_code
        else null
      end as direction
      from signal_atlas.candles c
      where c.asset_id = d.asset_id
        and c.timeframe = d.timeframe
        and c.is_closed
        and c.close_time <= d.feature_cutoff_at
      order by c.close_time desc, c.id desc
      limit 1
    ) prior on true
    where p.policy_key = 'cloud-engine-single'
      and d.mode = 'neutro'
      and o.resolved_at >= d.expiry_at
      and not exists (select 1 from signal_atlas.correction_events ce where ce.correction_type = 'invalidate' and (ce.target_type = 'decision' and ce.target_id = d.id))
    and not exists (select 1 from signal_atlas.correction_events ce where ce.correction_type = 'invalidate' and (ce.target_type = 'outcome' and ce.target_id = o.id))
  ), arms as (
    select r.id, r.entry_price, r.close_price, r.stake, r.payout_ratio,
      r.operation_cost, r.tie_policy, a.strategy,
      a.direction as arm_direction,
      case when a.direction is null then 'wait' else a.direction::text end as action
    from resolved r
    cross join lateral (values
      ('market_analyzer'::text, r.direction),
      ('always_buy'::text, 'buy'::signal_atlas.direction_code),
      ('always_sell'::text, 'sell'::signal_atlas.direction_code),
      ('last_closed_candle'::text, r.prior_direction)
    ) a(strategy, direction)
  ), scored as (
    select *,
      case when action = 'wait' then null
        else signal_atlas.trade_result(arm_direction, entry_price, close_price)
      end as result,
      case when action = 'wait' then 0::numeric
        else signal_atlas.trade_pnl(
          arm_direction, entry_price, close_price, stake,
          payout_ratio, operation_cost, tie_policy
        )
      end as pnl
    from arms
  ), summary as (
    select strategy,
      pg_catalog.count(*) as opportunities,
      pg_catalog.count(*) filter (where action <> 'wait') as trades,
      pg_catalog.count(*) filter (where result = 'win') as wins,
      pg_catalog.count(*) filter (where result = 'loss') as losses,
      pg_catalog.count(*) filter (where result = 'tie') as ties,
      pg_catalog.avg(pnl) as ev_per_opportunity,
      pg_catalog.avg(pnl) filter (where action <> 'wait') as ev_per_trade
    from scored
    group by strategy
  ), expected_random as (
    select
      pg_catalog.count(*) as opportunities,
      pg_catalog.avg(case when entry_price = close_price then 0 else 0.5 end) as win_rate,
      pg_catalog.avg(case when entry_price = close_price then case tie_policy when 'win' then stake * payout_ratio - operation_cost when 'refund' then -operation_cost else -stake - operation_cost end else stake * (payout_ratio - 1) / 2 - operation_cost end) as ev
    from resolved
  )
  select s.strategy, s.opportunities, s.trades, s.wins, s.losses, s.ties,
    s.trades::numeric / greatest(s.opportunities, 1),
    s.wins::numeric / nullif(s.trades, 0),
    s.ev_per_opportunity, s.ev_per_trade,
    'retrospective fixed-rule diagnostic on the same single-policy outcomes'::text
  from summary s
  union all
  select 'random_50_expected', r.opportunities, r.opportunities,
    0, 0, 0, 1::numeric, r.win_rate, r.ev, r.ev,
    '50% directional expectation on the same outcomes, including ties; not a sampled random sequence'::text
  from expected_random r
  order by strategy
$function$

;
commit;
