begin;

-- A selective arm must be compared with a random rule that trades exactly the
-- same selected opportunities. Otherwise WAIT receives zero while the random
-- reference pays the negative payout spread on every opportunity, allowing an
-- all-WAIT arm to appear superior without predicting anything.
drop view if exists public.cloud_strategy_lab;
drop function if exists signal_atlas.strategy_lab_summary_rows();

create function signal_atlas.strategy_lab_summary_rows()
returns table(
  strategy_version integer,
  arm text,
  opportunities bigint,
  distinct_days bigint,
  trades bigint,
  wins bigint,
  losses bigint,
  ties bigint,
  coverage numeric,
  win_rate numeric,
  ev_per_opportunity numeric,
  random_benchmark_ev numeric,
  delta_vs_random numeric,
  delta_vs_random_lb95 numeric,
  review_ready boolean,
  beats_random_conservatively boolean,
  first_decision_at timestamptz,
  last_resolved_at timestamptz,
  ev_per_trade numeric,
  coverage_matched_random_ev numeric,
  random_benchmark_ev_per_trade numeric
)
language sql
stable
security definer
set search_path = ''
as $function$
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
      ((d.payout_ratio - 1) / 2 - d.operation_cost) as benchmark_ev,
      case when s.action = 'wait' then 0::numeric
        else ((d.payout_ratio - 1) / 2 - d.operation_cost)
      end as coverage_benchmark_ev
    from signal_atlas.strategy_shadow_arms s
    join signal_atlas.decision_events d on d.id = s.decision_event_id
    join signal_atlas.outcomes o on o.decision_event_id = d.id
    where s.predicted_at < d.entry_at
      and o.resolved_at >= d.expiry_at
      and not exists (
        select 1 from signal_atlas.correction_events ce
        where ce.correction_type = 'invalidate'
          and ((ce.target_type = 'decision' and ce.target_id = d.id)
            or (ce.target_type = 'outcome' and ce.target_id = o.id))
      )
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
$function$;

create view public.cloud_strategy_lab
with (security_invoker = true, security_barrier = true)
as select * from signal_atlas.strategy_lab_summary_rows();

revoke all on function signal_atlas.strategy_lab_summary_rows()
from public, anon, authenticated, service_role;
grant execute on function signal_atlas.strategy_lab_summary_rows()
to anon, authenticated, service_role;

revoke all on public.cloud_strategy_lab
from public, anon, authenticated, service_role;
grant select on public.cloud_strategy_lab
to anon, authenticated, service_role;

comment on view public.cloud_strategy_lab is
  'Prospective strategy controls compared against a coverage-matched random rule. WAIT is compared with WAIT; no arm auto-promotes.';

commit;
