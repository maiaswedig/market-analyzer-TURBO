begin;

-- Independent prospective policy laboratory.
-- Legacy shadow_predictions and promotion_reviews remain immutable evidence.
-- From comparison_version=2 onward, heuristic, champion and challenger may
-- choose BUY, SELL or WAIT independently on one canonical neutral-mode event.

do $$
begin
  create type signal_atlas.shadow_policy_role_code as enum ('heuristic', 'champion', 'challenger');
exception when duplicate_object then null;
end
$$;

do $$
begin
  create type signal_atlas.shadow_policy_action_code as enum ('buy', 'sell', 'wait');
exception when duplicate_object then null;
end
$$;

create table if not exists signal_atlas.policy_shadow_decisions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  decision_event_id uuid not null references signal_atlas.decision_events(id),
  model_artifact_id uuid references signal_atlas.model_artifacts(id),
  policy_version_id uuid not null references signal_atlas.policy_versions(id),
  evaluation_role signal_atlas.shadow_policy_role_code not null,
  action signal_atlas.shadow_policy_action_code not null,
  direction signal_atlas.direction_code,
  probability_up numeric,
  tie_probability numeric,
  win_probability numeric,
  expected_ev numeric,
  decision_policy_version integer not null default 2,
  predicted_at timestamptz not null,
  feature_cutoff_at timestamptz not null,
  candle_set_hash text not null,
  model_hash_snapshot text,
  policy_hash_snapshot text not null,
  config_snapshot jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (
    (evaluation_role = 'heuristic' and model_artifact_id is null)
    or (evaluation_role <> 'heuristic' and model_artifact_id is not null)
  ),
  check (
    (action = 'wait' and direction is null)
    or (action <> 'wait' and direction::text = action::text)
  ),
  check (probability_up is null or probability_up between 0 and 1),
  check (tie_probability is null or tie_probability between 0 and 1),
  check (win_probability is null or win_probability between 0 and 1),
  check (decision_policy_version >= 1),
  check (feature_cutoff_at <= predicted_at),
  check (pg_catalog.length(candle_set_hash) >= 32),
  check (model_hash_snapshot is null or pg_catalog.length(model_hash_snapshot) >= 32),
  check (pg_catalog.length(policy_hash_snapshot) >= 32),
  check (pg_catalog.jsonb_typeof(config_snapshot) = 'object')
);

create unique index if not exists policy_shadow_heuristic_once_idx
  on signal_atlas.policy_shadow_decisions(decision_event_id)
  where evaluation_role = 'heuristic';

create unique index if not exists policy_shadow_model_once_idx
  on signal_atlas.policy_shadow_decisions(decision_event_id, model_artifact_id)
  where model_artifact_id is not null;

create index if not exists policy_shadow_model_opportunity_idx
  on signal_atlas.policy_shadow_decisions(model_artifact_id, decision_event_id, predicted_at)
  where model_artifact_id is not null;

create index if not exists policy_shadow_role_opportunity_idx
  on signal_atlas.policy_shadow_decisions(evaluation_role, decision_event_id);

alter table signal_atlas.policy_shadow_decisions enable row level security;
alter table signal_atlas.policy_shadow_decisions force row level security;

drop trigger if exists policy_shadow_append_only_guard on signal_atlas.policy_shadow_decisions;
create trigger policy_shadow_append_only_guard
before update or delete on signal_atlas.policy_shadow_decisions
for each row execute function signal_atlas.reject_update_delete();

alter table signal_atlas.promotion_reviews
  add column if not exists comparison_version integer not null default 1,
  add column if not exists unique_opportunities integer,
  add column if not exists distinct_days integer,
  add column if not exists heuristic_ev numeric,
  add column if not exists delta_ev_vs_heuristic numeric,
  add column if not exists delta_ev_vs_heuristic_lb95 numeric,
  add column if not exists delta_ev_vs_heuristic_ub95 numeric,
  add column if not exists champion_coverage numeric,
  add column if not exists challenger_coverage numeric,
  add column if not exists champion_trades integer,
  add column if not exists challenger_trades integer;

create or replace function signal_atlas.validate_independent_policy_promotion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.action = 'promote_champion' and not exists (
    select 1
    from signal_atlas.promotion_reviews r
    join signal_atlas.model_artifacts challenger
      on challenger.id = r.challenger_model_artifact_id
    where r.id = new.promotion_review_id
      and r.passed
      and r.comparison_version = 2
      and coalesce((challenger.training_config->'artifact'->>'decisionPolicyVersion')::integer, 1) >= 2
      and r.unique_opportunities >= 500
      and r.distinct_days >= 20
      and r.challenger_trades >= 100
      and r.delta_ev_lb95 > 0
      and r.delta_ev_vs_heuristic_lb95 > 0
  ) then
    raise exception using errcode = '23514',
      message = 'promotion requires a passing independent policy v2 review';
  end if;
  return new;
end
$$;

drop trigger if exists independent_policy_promotion_guard on signal_atlas.model_deployment_events;
create trigger independent_policy_promotion_guard
before insert on signal_atlas.model_deployment_events
for each row execute function signal_atlas.validate_independent_policy_promotion();

create or replace function signal_atlas.record_policy_shadow_decisions(
  p_decision_id uuid,
  p_predictions jsonb,
  p_predicted_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision signal_atlas.decision_events%rowtype;
  v_model signal_atlas.model_artifacts%rowtype;
  v_prediction jsonb;
  v_probability_up numeric;
  v_tie numeric;
  v_win numeric;
  v_ev numeric;
  v_direction signal_atlas.direction_code;
  v_action signal_atlas.shadow_policy_action_code;
  v_role signal_atlas.shadow_policy_role_code;
  v_version integer;
  v_model_version integer;
  v_inserted integer := 0;
  v_row_count integer;
begin
  if p_predicted_at is null or pg_catalog.jsonb_typeof(p_predictions) <> 'array' then
    raise exception using errcode = '22023', message = 'independent shadow payload is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('policy-shadow|' || p_decision_id::text, 0));
  select * into v_decision
  from signal_atlas.decision_events d
  where d.id = p_decision_id
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'paired decision does not exist';
  end if;
  if v_decision.mode <> 'neutro' then
    raise exception using errcode = '23514', message = 'promotion laboratory accepts only canonical neutral-mode opportunities';
  end if;
  if p_predicted_at < v_decision.decision_at or p_predicted_at >= v_decision.entry_at then
    raise exception using errcode = '23514', message = 'policy shadow must be frozen after decision and before entry';
  end if;

  insert into signal_atlas.policy_shadow_decisions(
    decision_event_id, model_artifact_id, policy_version_id, evaluation_role,
    action, direction, decision_policy_version, predicted_at, feature_cutoff_at,
    candle_set_hash, model_hash_snapshot, policy_hash_snapshot, config_snapshot
  ) values (
    v_decision.id, null, v_decision.policy_version_id, 'heuristic',
    v_decision.direction::text::signal_atlas.shadow_policy_action_code,
    v_decision.direction, 2, v_decision.decision_at, v_decision.feature_cutoff_at,
    v_decision.candle_set_hash, null, v_decision.policy_hash_snapshot,
    pg_catalog.jsonb_build_object(
      'comparison_version', 2,
      'canonical_mode', 'neutro',
      'wait_pnl_per_opportunity', 0,
      'source', 'immutable technical direction'
    )
  ) on conflict do nothing;
  get diagnostics v_row_count = row_count;
  v_inserted := v_inserted + v_row_count;

  for v_prediction in
    select value from pg_catalog.jsonb_array_elements(p_predictions)
  loop
    if nullif(v_prediction->>'model_id', '') is null then continue; end if;
    select * into v_model
    from signal_atlas.model_artifacts m
    where m.id = (v_prediction->>'model_id')::uuid;
    if not found
       or v_model.asset_id <> v_decision.asset_id
       or v_model.timeframe <> v_decision.timeframe
       or v_model.created_at > p_predicted_at then
      raise exception using errcode = '23514', message = 'policy shadow model is missing, late or belongs to another segment';
    end if;

    v_probability_up := (v_prediction->>'probability_up')::numeric;
    v_tie := coalesce((v_model.training_config->'artifact'->>'tieRate')::numeric, 0);
    v_model_version := coalesce((v_model.training_config->'artifact'->>'decisionPolicyVersion')::integer, 1);
    v_version := coalesce((v_prediction->>'decision_policy_version')::integer, v_model_version);
    if v_probability_up < 0 or v_probability_up > 1 or v_tie < 0 or v_tie > 1
       or v_version <> v_model_version then
      raise exception using errcode = '23514', message = 'policy shadow probability/version differs from immutable model';
    end if;

    v_direction := case when v_probability_up >= 0.5 then 'buy' else 'sell' end;
    v_win := (case when v_direction = 'buy' then v_probability_up else 1 - v_probability_up end) * (1 - v_tie);
    v_ev := v_win * v_decision.payout_ratio - (1 - v_win) - v_decision.operation_cost;
    v_action := case when v_ev > 0
      then v_direction::text::signal_atlas.shadow_policy_action_code
      else 'wait'::signal_atlas.shadow_policy_action_code end;
    v_role := case when v_model.id = v_decision.model_artifact_id
      then 'champion'::signal_atlas.shadow_policy_role_code
      else 'challenger'::signal_atlas.shadow_policy_role_code end;

    insert into signal_atlas.policy_shadow_decisions(
      decision_event_id, model_artifact_id, policy_version_id, evaluation_role,
      action, direction, probability_up, tie_probability, win_probability,
      expected_ev, decision_policy_version, predicted_at, feature_cutoff_at,
      candle_set_hash, model_hash_snapshot, policy_hash_snapshot, config_snapshot
    ) values (
      v_decision.id, v_model.id, v_decision.policy_version_id, v_role,
      v_action, case when v_action = 'wait' then null else v_direction end,
      v_probability_up, v_tie, v_win, v_ev, v_model_version,
      p_predicted_at, v_decision.feature_cutoff_at, v_decision.candle_set_hash,
      v_model.artifact_sha256, v_decision.policy_hash_snapshot,
      pg_catalog.jsonb_build_object(
        'comparison_version', 2,
        'canonical_mode', 'neutro',
        'payout_ratio', v_decision.payout_ratio,
        'operation_cost', v_decision.operation_cost,
        'tie_policy', v_decision.tie_policy,
        'decision_rule', 'choose higher directional probability; trade only when net EV > 0; otherwise WAIT',
        'wait_pnl_per_opportunity', 0
      )
    ) on conflict do nothing;
    get diagnostics v_row_count = row_count;
    v_inserted := v_inserted + v_row_count;
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'comparisonVersion', 2,
    'decisionId', v_decision.id,
    'inserted', v_inserted
  );
end
$$;

create or replace function public.register_policy_shadow_decisions(
  p_decision_id uuid,
  p_predictions jsonb,
  p_predicted_at timestamptz
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select signal_atlas.record_policy_shadow_decisions(p_decision_id, p_predictions, p_predicted_at)
$$;

create or replace function signal_atlas.review_challenger(
  p_asset_id uuid,
  p_timeframe signal_atlas.timeframe_code,
  p_challenger_model_artifact_id uuid,
  p_window_start_at timestamptz,
  p_window_end_at timestamptz,
  p_promote boolean,
  p_deployment_idempotency_key text default null,
  p_drawdown_limit_ratio numeric default 1.20,
  p_brier_tolerance numeric default 0
)
returns table(review_id uuid, review_passed boolean, deployment_event_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_champion_id uuid;
  v_champion signal_atlas.model_artifacts%rowtype;
  v_challenger signal_atlas.model_artifacts%rowtype;
  v_review signal_atlas.promotion_reviews%rowtype;
  v_n integer;
  v_days integer;
  v_champion_trades integer;
  v_challenger_trades integer;
  v_heuristic_ev numeric;
  v_champion_ev numeric;
  v_challenger_ev numeric;
  v_delta numeric;
  v_delta_daily_sd numeric;
  v_delta_lb numeric;
  v_delta_ub numeric;
  v_delta_heuristic numeric;
  v_delta_heuristic_daily_sd numeric;
  v_delta_heuristic_lb numeric;
  v_delta_heuristic_ub numeric;
  v_champion_brier numeric;
  v_challenger_brier numeric;
  v_champion_dd numeric;
  v_challenger_dd numeric;
  v_champion_coverage numeric;
  v_challenger_coverage numeric;
  v_passed boolean;
  v_event_id uuid;
begin
  if p_window_start_at >= p_window_end_at or p_window_end_at > v_now then
    raise exception using errcode = '22023', message = 'review window must be closed and chronological';
  end if;
  if p_drawdown_limit_ratio < 1 or p_brier_tolerance < 0 then
    raise exception using errcode = '22023', message = 'invalid drawdown/Brier limits';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_asset_id::text || '|' || p_timeframe::text, 0));
  v_champion_id := signal_atlas.current_champion_model(p_asset_id, p_timeframe, v_now);
  if v_champion_id is null then
    raise exception using errcode = '23514', message = 'segment has no active champion';
  end if;
  select * into v_champion from signal_atlas.model_artifacts where id = v_champion_id;
  select * into v_challenger from signal_atlas.model_artifacts where id = p_challenger_model_artifact_id;
  if not found or v_challenger.asset_id <> p_asset_id or v_challenger.timeframe <> p_timeframe
     or v_challenger.id = v_champion_id then
    raise exception using errcode = '23514', message = 'challenger does not match segment or is already champion';
  end if;
  if coalesce((v_challenger.training_config->'artifact'->>'decisionPolicyVersion')::integer, 1) < 2 then
    raise exception using errcode = '23514',
      message = 'challenger was not trained for independent decision policy v2';
  end if;

  select * into v_review
  from signal_atlas.promotion_reviews
  where asset_id = p_asset_id and timeframe = p_timeframe
    and champion_model_artifact_id = v_champion_id
    and challenger_model_artifact_id = p_challenger_model_artifact_id
    and window_end_at = p_window_end_at;

  if found and (
    v_review.window_start_at <> p_window_start_at
    or v_review.drawdown_limit_ratio <> p_drawdown_limit_ratio
    or v_review.brier_tolerance <> p_brier_tolerance
    or v_review.comparison_version <> 2
  ) then
    raise exception using errcode = '23505', message = 'review window_end already exists with different immutable criteria';
  end if;

  if not found then
    with paired as (
      select
        d.id,
        d.entry_at,
        o.resolved_at,
        o.entry_price,
        o.close_price,
        d.stake,
        d.payout_ratio,
        d.operation_cost,
        d.tie_policy,
        h.action as heuristic_action,
        h.direction as heuristic_direction,
        c.action as champion_action,
        c.direction as champion_direction,
        c.probability_up as champion_probability_up,
        x.action as challenger_action,
        x.direction as challenger_direction,
        x.probability_up as challenger_probability_up
      from signal_atlas.decision_events d
      join signal_atlas.outcomes o on o.decision_event_id = d.id
      join signal_atlas.policy_shadow_decisions h
        on h.decision_event_id = d.id and h.evaluation_role = 'heuristic'
      join signal_atlas.policy_shadow_decisions c
        on c.decision_event_id = d.id and c.evaluation_role = 'champion'
       and c.model_artifact_id = v_champion_id
      join signal_atlas.policy_shadow_decisions x
        on x.decision_event_id = d.id and x.evaluation_role = 'challenger'
       and x.model_artifact_id = p_challenger_model_artifact_id
      where d.asset_id = p_asset_id
        and d.timeframe = p_timeframe
        and d.mode = 'neutro'
        and d.model_role = 'champion'
        and d.model_artifact_id = v_champion_id
        and d.entry_at >= p_window_start_at and d.entry_at < p_window_end_at
        and o.resolved_at <= p_window_end_at
        and d.decision_at > v_champion.training_cutoff_at
        and d.decision_at > v_challenger.training_cutoff_at
        and c.predicted_at < d.entry_at
        and x.predicted_at < d.entry_at
        and not exists (
          select 1 from signal_atlas.correction_events ce
          where ce.correction_type = 'invalidate'
            and ((ce.target_type = 'decision' and ce.target_id = d.id)
              or (ce.target_type = 'outcome' and ce.target_id = o.id))
        )
    ), scored as (
      select *,
        case when heuristic_action = 'wait' then 0 else signal_atlas.trade_pnl(
          heuristic_direction, entry_price, close_price, stake, payout_ratio, operation_cost, tie_policy
        ) end as heuristic_pnl,
        case when champion_action = 'wait' then 0 else signal_atlas.trade_pnl(
          champion_direction, entry_price, close_price, stake, payout_ratio, operation_cost, tie_policy
        ) end as champion_pnl,
        case when challenger_action = 'wait' then 0 else signal_atlas.trade_pnl(
          challenger_direction, entry_price, close_price, stake, payout_ratio, operation_cost, tie_policy
        ) end as challenger_pnl,
        case when entry_price = close_price then null else pg_catalog.power(
          champion_probability_up - case when close_price > entry_price then 1 else 0 end, 2
        ) end as champion_brier,
        case when entry_price = close_price then null else pg_catalog.power(
          challenger_probability_up - case when close_price > entry_price then 1 else 0 end, 2
        ) end as challenger_brier
      from paired
    ), equity as (
      select *,
        pg_catalog.sum(champion_pnl) over (order by entry_at, id rows unbounded preceding) as champion_equity,
        pg_catalog.sum(challenger_pnl) over (order by entry_at, id rows unbounded preceding) as challenger_equity
      from scored
    ), drawdowns as (
      select *,
        greatest(0, pg_catalog.max(champion_equity) over (order by entry_at, id rows unbounded preceding)) - champion_equity as champion_drawdown,
        greatest(0, pg_catalog.max(challenger_equity) over (order by entry_at, id rows unbounded preceding)) - challenger_equity as challenger_drawdown
      from equity
    ), daily as (
      select
        pg_catalog.date_trunc('day', entry_at) as day,
        pg_catalog.avg(challenger_pnl - champion_pnl) as delta_champion,
        pg_catalog.avg(challenger_pnl - heuristic_pnl) as delta_heuristic
      from drawdowns
      group by pg_catalog.date_trunc('day', entry_at)
    )
    select
      pg_catalog.count(*)::integer,
      pg_catalog.count(distinct pg_catalog.date_trunc('day', entry_at))::integer,
      pg_catalog.count(*) filter (where champion_action <> 'wait')::integer,
      pg_catalog.count(*) filter (where challenger_action <> 'wait')::integer,
      pg_catalog.avg(heuristic_pnl),
      pg_catalog.avg(champion_pnl),
      pg_catalog.avg(challenger_pnl),
      pg_catalog.avg(challenger_pnl - champion_pnl),
      (select pg_catalog.stddev_samp(delta_champion) from daily),
      pg_catalog.avg(challenger_pnl - heuristic_pnl),
      (select pg_catalog.stddev_samp(delta_heuristic) from daily),
      pg_catalog.avg(champion_brier),
      pg_catalog.avg(challenger_brier),
      coalesce(pg_catalog.max(champion_drawdown), 0),
      coalesce(pg_catalog.max(challenger_drawdown), 0)
    into v_n, v_days, v_champion_trades, v_challenger_trades,
         v_heuristic_ev, v_champion_ev, v_challenger_ev,
         v_delta, v_delta_daily_sd, v_delta_heuristic, v_delta_heuristic_daily_sd,
         v_champion_brier, v_challenger_brier, v_champion_dd, v_challenger_dd
    from drawdowns;

    v_champion_coverage := v_champion_trades::numeric / greatest(v_n, 1);
    v_challenger_coverage := v_challenger_trades::numeric / greatest(v_n, 1);
    if v_days >= 2 then
      v_delta_lb := v_delta - 1.96 * v_delta_daily_sd / pg_catalog.sqrt(v_days::numeric);
      v_delta_ub := v_delta + 1.96 * v_delta_daily_sd / pg_catalog.sqrt(v_days::numeric);
      v_delta_heuristic_lb := v_delta_heuristic - 1.96 * v_delta_heuristic_daily_sd / pg_catalog.sqrt(v_days::numeric);
      v_delta_heuristic_ub := v_delta_heuristic + 1.96 * v_delta_heuristic_daily_sd / pg_catalog.sqrt(v_days::numeric);
    end if;

    v_passed := v_n >= 500
      and v_days >= 20
      and v_challenger_trades >= 100
      and v_delta_lb > 0
      and v_delta_heuristic_lb > 0
      and v_challenger_brier <= v_champion_brier + p_brier_tolerance
      and v_challenger_dd <= greatest(v_champion_dd, 1) * p_drawdown_limit_ratio;

    insert into signal_atlas.promotion_reviews(
      asset_id, timeframe, champion_model_artifact_id, challenger_model_artifact_id,
      window_start_at, window_end_at, paired_samples, champion_ev, challenger_ev,
      delta_ev, delta_ev_lb95, delta_ev_ub95, champion_brier, challenger_brier,
      champion_max_drawdown, challenger_max_drawdown, drawdown_limit_ratio,
      brier_tolerance, passed, criteria, comparison_version, unique_opportunities,
      distinct_days, heuristic_ev, delta_ev_vs_heuristic,
      delta_ev_vs_heuristic_lb95, delta_ev_vs_heuristic_ub95,
      champion_coverage, challenger_coverage, champion_trades, challenger_trades
    ) values (
      p_asset_id, p_timeframe, v_champion_id, p_challenger_model_artifact_id,
      p_window_start_at, p_window_end_at, v_n, v_champion_ev, v_challenger_ev,
      v_delta, v_delta_lb, v_delta_ub, v_champion_brier, v_challenger_brier,
      v_champion_dd, v_challenger_dd, p_drawdown_limit_ratio,
      p_brier_tolerance, v_passed,
      pg_catalog.jsonb_build_object(
        'comparison_version', 2,
        'canonical_mode', 'neutro',
        'minimum_unique_opportunities', 500,
        'minimum_distinct_days', 20,
        'minimum_challenger_trades', 100,
        'wait_pnl_per_opportunity', 0,
        'delta_ev_lb95_must_exceed', 0,
        'delta_vs_heuristic_lb95_must_exceed', 0,
        'daily_blocked_standard_error', true,
        'brier_not_worse_tolerance', p_brier_tolerance,
        'drawdown_limit_ratio', p_drawdown_limit_ratio,
        'prospective_after_training_cutoff', true
      ),
      2, v_n, v_days, v_heuristic_ev, v_delta_heuristic,
      v_delta_heuristic_lb, v_delta_heuristic_ub,
      v_champion_coverage, v_challenger_coverage,
      v_champion_trades, v_challenger_trades
    ) returning * into v_review;
  end if;

  if p_promote and v_review.passed then
    if coalesce(pg_catalog.length(pg_catalog.btrim(p_deployment_idempotency_key)), 0) < 12 then
      raise exception using errcode = '22023', message = 'promotion idempotency key must have at least 12 characters';
    end if;
    if signal_atlas.current_champion_model(p_asset_id, p_timeframe, v_now) is distinct from v_review.champion_model_artifact_id then
      raise exception using errcode = '40001', message = 'champion changed after review; run a new paired review';
    end if;
    insert into signal_atlas.model_deployment_events(
      idempotency_key, asset_id, timeframe, action, model_artifact_id,
      previous_model_artifact_id, promotion_review_id, effective_at, reason
    ) values (
      p_deployment_idempotency_key, p_asset_id, p_timeframe, 'promote_champion',
      v_review.challenger_model_artifact_id, v_review.champion_model_artifact_id,
      v_review.id, v_now,
      pg_catalog.format(
        'independent policy v2 promotion: N=%s, days=%s, delta champion LB95=%s, delta heuristic LB95=%s',
        v_review.paired_samples, v_review.distinct_days, v_review.delta_ev_lb95,
        v_review.delta_ev_vs_heuristic_lb95
      )
    ) on conflict (idempotency_key) do nothing
    returning id into v_event_id;
    if v_event_id is null then
      select id into v_event_id from signal_atlas.model_deployment_events
      where idempotency_key = p_deployment_idempotency_key;
    end if;
  end if;

  review_id := v_review.id;
  review_passed := v_review.passed;
  deployment_event_id := v_event_id;
  return next;
end
$$;

create or replace function public.review_and_promote_challengers(
  p_as_of timestamptz,
  p_min_resolved integer,
  p_z_margin numeric,
  p_symbol text default null,
  p_timeframe text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_champion_id uuid;
  v_n integer;
  v_days integer;
  v_start timestamptz;
  v_end timestamptz;
  v_review record;
  v_reviews jsonb := '[]'::jsonb;
begin
  if p_min_resolved < 500 then
    raise exception using errcode = '23514', message = 'independent promotion requires at least 500 unique opportunities';
  end if;
  if p_z_margin is null or pg_catalog.abs(p_z_margin - 1.96) > 0.000001 then
    raise exception using errcode = '23514', message = 'promotion review requires z margin 1.96';
  end if;
  if p_as_of is null or p_as_of > pg_catalog.clock_timestamp() then
    raise exception using errcode = '23514', message = 'review clock must be present and cannot be in the future';
  end if;

  for v_candidate in
    select m.*, a.symbol
    from signal_atlas.model_artifacts m
    join signal_atlas.assets a on a.id = m.asset_id
    where coalesce((m.validation_metrics->>'usable')::boolean, false)
      and coalesce((m.training_config->'artifact'->>'decisionPolicyVersion')::integer, 1) >= 2
      and (p_symbol is null or a.symbol = pg_catalog.upper(pg_catalog.btrim(p_symbol)))
      and (p_timeframe is null or m.timeframe::text = p_timeframe)
    order by m.created_at
  loop
    v_champion_id := signal_atlas.current_champion_model(v_candidate.asset_id, v_candidate.timeframe, p_as_of);
    if v_champion_id is null or v_champion_id = v_candidate.id then continue; end if;

    select
      pg_catalog.count(*)::integer,
      pg_catalog.count(distinct pg_catalog.date_trunc('day', d.entry_at))::integer,
      pg_catalog.min(d.entry_at),
      pg_catalog.max(o.resolved_at)
    into v_n, v_days, v_start, v_end
    from signal_atlas.decision_events d
    join signal_atlas.outcomes o on o.decision_event_id = d.id
    join signal_atlas.policy_shadow_decisions h
      on h.decision_event_id = d.id and h.evaluation_role = 'heuristic'
    join signal_atlas.policy_shadow_decisions c
      on c.decision_event_id = d.id and c.evaluation_role = 'champion'
     and c.model_artifact_id = v_champion_id
    join signal_atlas.policy_shadow_decisions x
      on x.decision_event_id = d.id and x.evaluation_role = 'challenger'
     and x.model_artifact_id = v_candidate.id
    where d.asset_id = v_candidate.asset_id
      and d.timeframe = v_candidate.timeframe
      and d.mode = 'neutro'
      and d.model_artifact_id = v_champion_id
      and d.entry_at < p_as_of
      and o.resolved_at <= p_as_of
      and not exists (
        select 1 from signal_atlas.correction_events ce
        where ce.correction_type = 'invalidate'
          and ((ce.target_type = 'decision' and ce.target_id = d.id)
            or (ce.target_type = 'outcome' and ce.target_id = o.id))
      );

    if v_n < greatest(p_min_resolved, 500) or v_days < 20
       or v_start is null or v_end is null or v_start >= v_end then
      continue;
    end if;

    select * into v_review
    from signal_atlas.review_challenger(
      v_candidate.asset_id, v_candidate.timeframe, v_candidate.id,
      v_start, v_end, true,
      'auto-promote-independent-v2|' || v_candidate.symbol || '|' ||
        v_candidate.timeframe::text || '|' || v_candidate.id::text,
      1.20, 0
    );
    v_reviews := v_reviews || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_review));
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'asOf', p_as_of,
    'comparisonVersion', 2,
    'minimumUniqueOpportunities', greatest(p_min_resolved, 500),
    'minimumDistinctDays', 20,
    'minimumChallengerTrades', 100,
    'criterion', 'challenger independently beats champion and heuristic on EV/opportunity LB95; Brier not worse; drawdown controlled',
    'reviews', v_reviews
  );
end
$$;

revoke all on signal_atlas.policy_shadow_decisions
from public, anon, authenticated, service_role;

revoke execute on function signal_atlas.record_policy_shadow_decisions(uuid,jsonb,timestamptz)
from public, anon, authenticated, service_role;

revoke execute on function public.register_policy_shadow_decisions(uuid,jsonb,timestamptz),
  public.review_and_promote_challengers(timestamptz,integer,numeric,text,text)
from public, anon, authenticated;

grant execute on function public.register_policy_shadow_decisions(uuid,jsonb,timestamptz),
  public.review_and_promote_challengers(timestamptz,integer,numeric,text,text)
to service_role;

comment on table signal_atlas.policy_shadow_decisions is
  'Immutable independent BUY/SELL/WAIT policy arms on one neutral-mode opportunity; never rewrites the visible technical direction.';
comment on function public.register_policy_shadow_decisions(uuid,jsonb,timestamptz) is
  'Service-role-only causal recorder for heuristic, champion and challenger policy arms before entry.';
comment on function signal_atlas.review_challenger(
  uuid,signal_atlas.timeframe_code,uuid,timestamptz,timestamptz,boolean,text,numeric,numeric
) is
  'Comparison v2: unique neutral-mode opportunities, WAIT=0, daily-blocked EV intervals and mandatory advantage over champion plus heuristic.';

commit;
