begin;

-- Prospective strategy laboratory. These arms are frozen with each new
-- canonical decision, before entry and before outcome. They are diagnostics
-- only: none can change the visible signal, train a model or promote itself.
create table if not exists signal_atlas.strategy_shadow_arms (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  decision_event_id uuid not null references signal_atlas.decision_events(id),
  strategy_version integer not null default 1 check (strategy_version >= 1),
  arm text not null check (arm in (
    'technical_current',
    'technical_inverse',
    'grade_a_or_a_plus'
  )),
  action text not null check (action in ('buy', 'sell', 'wait')),
  direction signal_atlas.direction_code,
  predicted_at timestamptz not null,
  feature_cutoff_at timestamptz not null,
  candle_set_hash text not null,
  policy_hash_snapshot text not null,
  config_snapshot jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (decision_event_id, strategy_version, arm),
  check (
    (action = 'wait' and direction is null)
    or (action <> 'wait' and direction::text = action)
  ),
  check (feature_cutoff_at <= predicted_at),
  check (pg_catalog.length(candle_set_hash) >= 32),
  check (pg_catalog.length(policy_hash_snapshot) >= 32),
  check (pg_catalog.jsonb_typeof(config_snapshot) = 'object')
);

create index if not exists strategy_shadow_arms_arm_decision_idx
  on signal_atlas.strategy_shadow_arms(arm, decision_event_id);

alter table signal_atlas.strategy_shadow_arms enable row level security;
alter table signal_atlas.strategy_shadow_arms force row level security;

drop trigger if exists strategy_shadow_arms_append_only_guard
on signal_atlas.strategy_shadow_arms;
create trigger strategy_shadow_arms_append_only_guard
before update or delete on signal_atlas.strategy_shadow_arms
for each row execute function signal_atlas.reject_update_delete();

create or replace function signal_atlas.freeze_strategy_shadow_arms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_inverse signal_atlas.direction_code;
begin
  -- Only the canonical single-policy ledger is eligible. WAIT events are held
  -- in analysis_waits and therefore never enter this trigger.
  if new.mode <> 'neutro' then
    return new;
  end if;
  if new.decision_at >= new.entry_at then
    raise exception using errcode = '23514',
      message = 'strategy shadow must be frozen before entry';
  end if;

  v_inverse := case when new.direction = 'buy' then 'sell' else 'buy' end;

  insert into signal_atlas.strategy_shadow_arms(
    decision_event_id, strategy_version, arm, action, direction,
    predicted_at, feature_cutoff_at, candle_set_hash,
    policy_hash_snapshot, config_snapshot
  ) values
  (
    new.id, 1, 'technical_current', new.direction::text, new.direction,
    new.decision_at, new.feature_cutoff_at, new.candle_set_hash,
    new.policy_hash_snapshot,
    pg_catalog.jsonb_build_object(
      'prospective', true,
      'selection', 'all canonical technical directions',
      'purpose', 'current-strategy control; diagnostic only'
    )
  ),
  (
    new.id, 1, 'technical_inverse', v_inverse::text, v_inverse,
    new.decision_at, new.feature_cutoff_at, new.candle_set_hash,
    new.policy_hash_snapshot,
    pg_catalog.jsonb_build_object(
      'prospective', true,
      'selection', 'opposite of canonical technical direction',
      'purpose', 'anti-signal diagnostic; never auto-applied'
    )
  ),
  (
    new.id, 1, 'grade_a_or_a_plus',
    case when new.grade in ('A', 'A+') then new.direction::text else 'wait' end,
    case when new.grade in ('A', 'A+') then new.direction else null end,
    new.decision_at, new.feature_cutoff_at, new.candle_set_hash,
    new.policy_hash_snapshot,
    pg_catalog.jsonb_build_object(
      'prospective', true,
      'selection', 'trade canonical direction only for grades A or A+',
      'purpose', 'tests whether the visible grade adds selection value'
    )
  )
  on conflict (decision_event_id, strategy_version, arm) do nothing;

  return new;
end
$function$;

drop trigger if exists freeze_strategy_shadow_arms_after_decision
on signal_atlas.decision_events;
create trigger freeze_strategy_shadow_arms_after_decision
after insert on signal_atlas.decision_events
for each row execute function signal_atlas.freeze_strategy_shadow_arms();

create or replace function signal_atlas.strategy_lab_summary_rows()
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
  last_resolved_at timestamptz
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
      ((d.payout_ratio - 1) / 2 - d.operation_cost) as benchmark_ev
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
      pg_catalog.avg(pnl - benchmark_ev) as daily_delta
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
    pg_catalog.avg(s.pnl - s.benchmark_ev) as delta_vs_random,
    ds.daily_delta_mean - 1.96 * coalesce(ds.daily_delta_sd, 0) /
      pg_catalog.sqrt(greatest(ds.day_count, 1)::numeric) as delta_vs_random_lb95,
    pg_catalog.count(*) >= 500 and pg_catalog.count(distinct s.decision_day) >= 20 as review_ready,
    pg_catalog.count(*) >= 500
      and pg_catalog.count(distinct s.decision_day) >= 20
      and ds.daily_delta_mean - 1.96 * coalesce(ds.daily_delta_sd, 0) /
        pg_catalog.sqrt(greatest(ds.day_count, 1)::numeric) > 0
      as beats_random_conservatively,
    pg_catalog.min(s.decision_at) as first_decision_at,
    pg_catalog.max(s.resolved_at) as last_resolved_at
  from scored s
  join daily_stats ds
    on ds.strategy_version = s.strategy_version and ds.arm = s.arm
  group by s.strategy_version, s.arm,
    ds.day_count, ds.daily_delta_mean, ds.daily_delta_sd
  order by s.strategy_version desc, s.arm
$function$;

create or replace view public.cloud_strategy_lab
with (security_invoker = true, security_barrier = true)
as select * from signal_atlas.strategy_lab_summary_rows();

revoke all on signal_atlas.strategy_shadow_arms
from public, anon, authenticated, service_role;

revoke all on function signal_atlas.freeze_strategy_shadow_arms(),
  signal_atlas.strategy_lab_summary_rows()
from public, anon, authenticated, service_role;

grant execute on function signal_atlas.strategy_lab_summary_rows()
to anon, authenticated, service_role;

revoke all on public.cloud_strategy_lab
from public, anon, authenticated, service_role;
grant select on public.cloud_strategy_lab
to anon, authenticated, service_role;

comment on table signal_atlas.strategy_shadow_arms is
  'Immutable prospective controls for current, inverse and A/A+ technical policies; diagnostic only.';
comment on view public.cloud_strategy_lab is
  'Read-only prospective strategy comparison. Review readiness requires 500 opportunities over 20 days; no arm auto-promotes.';

commit;
