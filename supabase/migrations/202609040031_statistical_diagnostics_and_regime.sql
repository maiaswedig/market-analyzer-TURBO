begin;

-- Carry the causal regime computed by the Edge engine through the existing
-- registration wrapper without rewriting the large immutable registration
-- function. The transaction-local setting exists only for this RPC call.
create or replace function public.register_market_decision(p_decision jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_decision signal_atlas.decision_events%rowtype;
  v_regime text := coalesce(nullif(p_decision->>'regime', ''), 'indefinido');
begin
  if v_regime not in (
    'alta volatilidade', 'baixa volatilidade (squeeze)',
    'tendência forte de alta', 'tendência forte de baixa',
    'tendência fraca de alta', 'tendência fraca de baixa',
    'consolidação', 'indefinido'
  ) then
    raise exception using errcode = '23514', message = 'invalid market regime';
  end if;
  perform pg_catalog.set_config('signal_atlas.decision_regime', v_regime, true);

  v_result := signal_atlas.register_market_decision_legacy_v2(p_decision);
  if coalesce(v_result->>'kind', '') in ('signal', 'low-signal')
     and nullif(v_result->>'id', '') is not null then
    select * into v_decision
    from signal_atlas.decision_events d
    where d.id = (v_result->>'id')::uuid;
    if found then
      return v_result || pg_catalog.jsonb_build_object(
        'kind', case when v_decision.quality = 'low' then 'low-signal' else 'signal' end,
        'quality', v_decision.quality,
        'probability', v_decision.probability,
        'probabilityLb', v_decision.probability_lb,
        'evNet', v_decision.expected_ev,
        'economicContractVersion', coalesce(
          (v_decision.config_snapshot->>'economic_contract_version')::integer,
          2
        )
      );
    end if;
  end if;
  return v_result;
end
$function$;

create or replace function signal_atlas.attach_causal_regime_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_regime text := pg_catalog.current_setting('signal_atlas.decision_regime', true);
begin
  if coalesce(v_regime, '') <> '' then
    new.feature_snapshot := new.feature_snapshot || pg_catalog.jsonb_build_object(
      'regime', v_regime,
      'regime_schema', 'cloud-regime-v1'
    );
  end if;
  return new;
end
$function$;

drop trigger if exists zz_attach_causal_regime_before_insert
on signal_atlas.decision_events;
create trigger zz_attach_causal_regime_before_insert
before insert on signal_atlas.decision_events
for each row execute function signal_atlas.attach_causal_regime_snapshot();

create index if not exists decision_regime_diagnostic_idx
  on signal_atlas.decision_events ((feature_snapshot->>'regime'), decision_at desc)
  where feature_snapshot ? 'regime';

create or replace function signal_atlas.cloud_single_naive_baselines_rows()
returns table(
  strategy text,
  opportunities bigint,
  trades bigint,
  wins bigint,
  losses bigint,
  ties bigint,
  coverage numeric,
  win_rate numeric,
  ev_per_opportunity numeric,
  ev_per_trade numeric,
  sample_scope text
)
language sql
stable
security definer
set search_path = ''
as $function$
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
      and not exists (
        select 1 from signal_atlas.correction_events ce
        where ce.correction_type = 'invalidate'
          and ((ce.target_type = 'decision' and ce.target_id = d.id)
            or (ce.target_type = 'outcome' and ce.target_id = o.id))
      )
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
      pg_catalog.avg((payout_ratio - 1) / 2 - operation_cost) as ev
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
    0, 0, 0, 1::numeric, 0.5::numeric, r.ev, r.ev,
    'mathematical expectation at 50%; not a sampled random sequence'::text
  from expected_random r
  order by strategy
$function$;

create or replace view public.cloud_single_naive_baselines
with (security_invoker = true, security_barrier = true)
as select * from signal_atlas.cloud_single_naive_baselines_rows();

create or replace function signal_atlas.cloud_single_grade_calibration_rows()
returns table(
  grade text,
  trades bigint,
  wins bigint,
  losses bigint,
  ties bigint,
  win_rate numeric,
  wilson_lower numeric,
  wilson_upper numeric,
  ev_per_trade numeric
)
language sql
stable
security definer
set search_path = ''
as $function$
  with resolved as (
    select coalesce(nullif(d.feature_snapshot->>'grade', ''), 'D') as grade,
      o.decision_result as result,
      signal_atlas.trade_pnl(
        d.direction, o.entry_price, o.close_price, d.stake,
        d.payout_ratio, d.operation_cost, d.tie_policy
      ) as pnl
    from signal_atlas.decision_events d
    join signal_atlas.outcomes o on o.decision_event_id = d.id
    join signal_atlas.policy_versions p on p.id = d.policy_version_id
    where p.policy_key = 'cloud-engine-single'
      and d.mode = 'neutro'
      and o.resolved_at >= d.expiry_at
      and not exists (
        select 1 from signal_atlas.correction_events ce
        where ce.correction_type = 'invalidate'
          and ((ce.target_type = 'decision' and ce.target_id = d.id)
            or (ce.target_type = 'outcome' and ce.target_id = o.id))
      )
  ), agg as (
    select grade,
      pg_catalog.count(*)::bigint as n,
      pg_catalog.count(*) filter (where result = 'win')::bigint as w,
      pg_catalog.count(*) filter (where result = 'loss')::bigint as l,
      pg_catalog.count(*) filter (where result = 'tie')::bigint as t,
      pg_catalog.avg(pnl) as ev
    from resolved
    group by grade
  ), rates as (
    select *, w::numeric / greatest(n, 1) as p, 1.96::numeric as z
    from agg
  )
  select grade, n, w, l, t, p,
    (p + z*z/(2*n) - z*pg_catalog.sqrt(p*(1-p)/n + z*z/(4*n*n))) / (1+z*z/n),
    (p + z*z/(2*n) + z*pg_catalog.sqrt(p*(1-p)/n + z*z/(4*n*n))) / (1+z*z/n),
    ev
  from rates
  order by case grade when 'A+' then 1 when 'A' then 2 when 'B' then 3 when 'C' then 4 else 5 end
$function$;

create or replace view public.cloud_single_grade_calibration
with (security_invoker = true, security_barrier = true)
as select * from signal_atlas.cloud_single_grade_calibration_rows();

create or replace function signal_atlas.cloud_grade_a_diagnostic_rows()
returns table(
  symbol text,
  timeframe text,
  direction text,
  reason text,
  trades bigint,
  wins bigint,
  win_rate numeric,
  ev_per_trade numeric
)
language sql
stable
security definer
set search_path = ''
as $function$
  with grade_a as (
    select a.symbol, d.timeframe, d.direction, d.id, d.reasons,
      o.decision_result,
      signal_atlas.trade_pnl(
        d.direction, o.entry_price, o.close_price, d.stake,
        d.payout_ratio, d.operation_cost, d.tie_policy
      ) as pnl
    from signal_atlas.decision_events d
    join signal_atlas.assets a on a.id = d.asset_id
    join signal_atlas.outcomes o on o.decision_event_id = d.id
    join signal_atlas.policy_versions p on p.id = d.policy_version_id
    where p.policy_key = 'cloud-engine-single'
      and d.feature_snapshot->>'grade' = 'A'
      and o.resolved_at >= d.expiry_at
      and not exists (
        select 1 from signal_atlas.correction_events ce
        where ce.correction_type = 'invalidate'
          and ((ce.target_type = 'decision' and ce.target_id = d.id)
            or (ce.target_type = 'outcome' and ce.target_id = o.id))
      )
  ), expanded as (
    select g.*, coalesce(r.reason, 'sem motivo registrado') as reason
    from grade_a g
    left join lateral pg_catalog.jsonb_array_elements_text(g.reasons) r(reason) on true
  )
  select symbol, timeframe::text, direction::text, reason,
    pg_catalog.count(*)::bigint,
    pg_catalog.count(*) filter (where decision_result = 'win')::bigint,
    pg_catalog.avg((decision_result = 'win')::integer::numeric),
    pg_catalog.avg(pnl)
  from expanded
  group by symbol, timeframe, direction, reason
  having pg_catalog.count(*) >= 5
  order by pg_catalog.count(*) desc, symbol, timeframe, direction, reason
$function$;

create or replace view public.cloud_grade_a_diagnostics
with (security_invoker = true, security_barrier = true)
as select * from signal_atlas.cloud_grade_a_diagnostic_rows();

revoke all on function public.register_market_decision(jsonb)
from public, anon, authenticated;
grant execute on function public.register_market_decision(jsonb) to service_role;

revoke all on function signal_atlas.attach_causal_regime_snapshot(),
  signal_atlas.cloud_single_naive_baselines_rows(),
  signal_atlas.cloud_single_grade_calibration_rows(),
  signal_atlas.cloud_grade_a_diagnostic_rows()
from public, anon, authenticated, service_role;
grant execute on function signal_atlas.cloud_single_naive_baselines_rows(),
  signal_atlas.cloud_single_grade_calibration_rows(),
  signal_atlas.cloud_grade_a_diagnostic_rows()
to anon, authenticated, service_role;

revoke all on public.cloud_single_naive_baselines,
  public.cloud_single_grade_calibration,
  public.cloud_grade_a_diagnostics
from public, anon, authenticated, service_role;
grant select on public.cloud_single_naive_baselines,
  public.cloud_single_grade_calibration,
  public.cloud_grade_a_diagnostics
to anon, authenticated, service_role;

comment on view public.cloud_single_naive_baselines is
  'Fixed-rule retrospective diagnosis on the same single-policy outcomes; it never selects or promotes a strategy.';
comment on view public.cloud_single_grade_calibration is
  'Observed grade curve with 95% Wilson interval and canonical paper EV; grades come from immutable snapshots.';
comment on view public.cloud_grade_a_diagnostics is
  'Aggregate reason-level investigation for grade A. One decision can contribute to multiple reason rows.';

commit;
