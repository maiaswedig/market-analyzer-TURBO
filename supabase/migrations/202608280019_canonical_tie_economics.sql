begin;

-- Canonical economic contract v3.
-- Model directional probabilities are conditional on a non-tie outcome;
-- tie_probability is modelled separately and tie_policy determines its PnL.
create or replace function signal_atlas.expected_trade_ev(
  p_directional_probability numeric,
  p_tie_probability numeric,
  p_stake numeric,
  p_payout_ratio numeric,
  p_operation_cost numeric,
  p_tie_policy signal_atlas.tie_policy_code
)
returns numeric
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $$
declare
  v_win_probability numeric;
  v_loss_probability numeric;
  v_win_pnl numeric;
  v_loss_pnl numeric;
  v_tie_pnl numeric;
begin
  if p_directional_probability < 0 or p_directional_probability > 1
     or p_tie_probability < 0 or p_tie_probability > 1
     or p_stake <= 0
     or p_payout_ratio < 0 or p_payout_ratio > 1
     or p_operation_cost < 0 then
    raise exception using errcode = '22023', message = 'invalid expected value inputs';
  end if;

  v_win_probability := p_directional_probability * (1 - p_tie_probability);
  v_loss_probability := (1 - p_directional_probability) * (1 - p_tie_probability);
  v_win_pnl := p_stake * p_payout_ratio - p_operation_cost;
  v_loss_pnl := -(p_stake + p_operation_cost);
  v_tie_pnl := case p_tie_policy
    when 'win' then v_win_pnl
    when 'refund' then -p_operation_cost
    else v_loss_pnl
  end;

  return v_win_probability * v_win_pnl
    + v_loss_probability * v_loss_pnl
    + p_tie_probability * v_tie_pnl;
end
$$;

-- The database, not the Edge payload, is the final authority for economic
-- fields. This trigger applies only to future inserts and never rewrites the
-- immutable historical ledger.
create or replace function signal_atlas.canonicalize_decision_economics()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_model signal_atlas.model_artifacts%rowtype;
  v_policy signal_atlas.policy_versions%rowtype;
  v_tie numeric;
  v_ev_lb numeric;
  v_policy_pass boolean;
  v_tf_seconds integer;
begin
  select * into v_model
  from signal_atlas.model_artifacts m
  where m.id = new.model_artifact_id;
  if not found then
    raise exception using errcode = '23503', message = 'economic contract model not found';
  end if;

  select * into v_policy
  from signal_atlas.policy_versions p
  where p.id = new.policy_version_id;
  if not found then
    raise exception using errcode = '23503', message = 'economic contract policy not found';
  end if;

  v_tie := coalesce((v_model.training_config->'artifact'->>'tieRate')::numeric, 0);
  if v_tie < 0 or v_tie > 1 then
    raise exception using errcode = '23514', message = 'model tie probability is invalid';
  end if;

  new.tie_probability := v_tie;
  new.tie_policy := coalesce(v_policy.config->>'tie_policy', 'loss')::signal_atlas.tie_policy_code;
  new.payout_ratio := coalesce((v_policy.config->>'payout_ratio')::numeric, new.payout_ratio);
  new.operation_cost := coalesce((v_policy.config->>'operation_cost')::numeric, new.operation_cost);
  new.expected_ev := signal_atlas.expected_trade_ev(
    new.probability, v_tie, new.stake, new.payout_ratio,
    new.operation_cost, new.tie_policy
  );
  v_ev_lb := signal_atlas.expected_trade_ev(
    coalesce(new.probability_lb, new.probability), v_tie, new.stake,
    new.payout_ratio, new.operation_cost, new.tie_policy
  );
  v_tf_seconds := signal_atlas.timeframe_seconds(new.timeframe);
  v_policy_pass :=
    new.score >= coalesce((v_policy.config->>'min_score')::numeric, 0)
    and new.confluence_count >= coalesce((v_policy.config->>'min_confluence')::integer, 0)
    and new.statistical_sample_size >= coalesce((v_policy.config->>'min_statistical_samples')::integer, 0)
    and new.probability >= coalesce((v_policy.config->>'min_probability')::numeric, 0)
    and coalesce(new.probability_lb, new.probability) >= coalesce((v_policy.config->>'min_probability_lb')::numeric, 0)
    and new.data_age_ms <= (
      v_tf_seconds * 1000 * coalesce((v_policy.config->>'max_data_age_timeframe_ratio')::numeric, 1)
    )
    and new.source_latency_ms <= coalesce((v_policy.config->>'max_source_latency_ms')::integer, 120000)
    and (
      not coalesce((v_policy.config->>'require_positive_ev_lb95')::boolean, false)
      or v_ev_lb > 0
    );

  new.quality := case
    when new.feature_snapshot->>'status' <> 'signal' or not v_policy_pass
      then 'low'::signal_atlas.signal_quality_code
    when new.feature_snapshot->>'grade' in ('A+', 'A')
      then 'confirmed'::signal_atlas.signal_quality_code
    else 'technical'::signal_atlas.signal_quality_code
  end;
  new.feature_snapshot := new.feature_snapshot || pg_catalog.jsonb_build_object(
    'policy_pass', v_policy_pass,
    'expected_ev_lb95', v_ev_lb,
    'economic_contract_version', 3
  );
  new.config_snapshot := new.config_snapshot || pg_catalog.jsonb_build_object(
    'stake', new.stake,
    'payout_ratio', new.payout_ratio,
    'operation_cost', new.operation_cost,
    'tie_policy', new.tie_policy,
    'tie_probability', v_tie,
    'economic_contract_version', 3,
    'probability_semantics', 'conditional_on_non_tie'
  );
  return new;
end
$$;

create or replace function signal_atlas.canonicalize_shadow_economics()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_decision signal_atlas.decision_events%rowtype;
  v_model signal_atlas.model_artifacts%rowtype;
  v_tie numeric;
begin
  select * into v_decision
  from signal_atlas.decision_events d
  where d.id = new.decision_event_id;
  if not found then
    raise exception using errcode = '23503', message = 'paired decision not found for shadow economics';
  end if;

  select * into v_model
  from signal_atlas.model_artifacts m
  where m.id = new.model_artifact_id;
  if not found then
    raise exception using errcode = '23503', message = 'shadow model not found for economics';
  end if;

  v_tie := coalesce((v_model.training_config->'artifact'->>'tieRate')::numeric, 0);
  if v_tie < 0 or v_tie > 1 then
    raise exception using errcode = '23514', message = 'shadow tie probability is invalid';
  end if;

  new.expected_ev := signal_atlas.expected_trade_ev(
    new.probability, v_tie, v_decision.stake, v_decision.payout_ratio,
    v_decision.operation_cost, v_decision.tie_policy
  );
  new.config_snapshot := new.config_snapshot || pg_catalog.jsonb_build_object(
    'stake', v_decision.stake,
    'payout_ratio', v_decision.payout_ratio,
    'operation_cost', v_decision.operation_cost,
    'tie_policy', v_decision.tie_policy,
    'tie_probability', v_tie,
    'economic_contract_version', 3,
    'probability_semantics', 'conditional_on_non_tie'
  );
  return new;
end
$$;

create or replace function signal_atlas.canonicalize_policy_shadow_economics()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_decision signal_atlas.decision_events%rowtype;
  v_model signal_atlas.model_artifacts%rowtype;
  v_tie numeric;
  v_direction signal_atlas.direction_code;
  v_directional_probability numeric;
begin
  select * into v_decision
  from signal_atlas.decision_events d
  where d.id = new.decision_event_id;
  if not found then
    raise exception using errcode = '23503', message = 'paired decision not found for policy shadow economics';
  end if;

  if new.evaluation_role = 'heuristic' then
    new.config_snapshot := new.config_snapshot || pg_catalog.jsonb_build_object(
      'economic_contract_version', 3,
      'tie_policy', v_decision.tie_policy,
      'wait_pnl_per_opportunity', 0
    );
    return new;
  end if;

  select * into v_model
  from signal_atlas.model_artifacts m
  where m.id = new.model_artifact_id;
  if not found then
    raise exception using errcode = '23503', message = 'policy shadow model not found for economics';
  end if;
  if new.probability_up is null or new.probability_up < 0 or new.probability_up > 1 then
    raise exception using errcode = '23514', message = 'policy shadow probability is invalid';
  end if;

  v_tie := coalesce((v_model.training_config->'artifact'->>'tieRate')::numeric, 0);
  if v_tie < 0 or v_tie > 1 then
    raise exception using errcode = '23514', message = 'policy shadow tie probability is invalid';
  end if;
  v_direction := case when new.probability_up >= 0.5 then 'buy' else 'sell' end;
  v_directional_probability := case when v_direction = 'buy'
    then new.probability_up else 1 - new.probability_up end;

  new.tie_probability := v_tie;
  new.win_probability := v_directional_probability * (1 - v_tie);
  new.expected_ev := signal_atlas.expected_trade_ev(
    v_directional_probability, v_tie, v_decision.stake,
    v_decision.payout_ratio, v_decision.operation_cost, v_decision.tie_policy
  );
  new.action := case when new.expected_ev > 0
    then v_direction::text::signal_atlas.shadow_policy_action_code
    else 'wait'::signal_atlas.shadow_policy_action_code
  end;
  new.direction := case when new.action = 'wait' then null else v_direction end;
  new.config_snapshot := new.config_snapshot || pg_catalog.jsonb_build_object(
    'comparison_version', 2,
    'economic_contract_version', 3,
    'payout_ratio', v_decision.payout_ratio,
    'operation_cost', v_decision.operation_cost,
    'tie_policy', v_decision.tie_policy,
    'tie_probability', v_tie,
    'probability_semantics', 'conditional_on_non_tie',
    'decision_rule', 'choose higher directional probability; trade only when canonical net EV > 0; otherwise WAIT',
    'wait_pnl_per_opportunity', 0
  );
  return new;
end
$$;

drop trigger if exists canonical_decision_economics_before_insert on signal_atlas.decision_events;
create trigger canonical_decision_economics_before_insert
before insert on signal_atlas.decision_events
for each row execute function signal_atlas.canonicalize_decision_economics();

drop trigger if exists canonical_shadow_economics_before_insert on signal_atlas.shadow_predictions;
create trigger canonical_shadow_economics_before_insert
before insert on signal_atlas.shadow_predictions
for each row execute function signal_atlas.canonicalize_shadow_economics();

drop trigger if exists canonical_policy_shadow_economics_before_insert on signal_atlas.policy_shadow_decisions;
create trigger canonical_policy_shadow_economics_before_insert
before insert on signal_atlas.policy_shadow_decisions
for each row execute function signal_atlas.canonicalize_policy_shadow_economics();

-- Keep the already-audited v2 implementation as an inaccessible internal
-- implementation. The new public wrapper returns the canonical values that
-- were enforced by the insert trigger, including for idempotent retries.
alter function public.register_market_decision(jsonb)
  rename to register_market_decision_legacy_v2;
alter function public.register_market_decision_legacy_v2(jsonb)
  set schema signal_atlas;

revoke execute on function signal_atlas.register_market_decision_legacy_v2(jsonb)
from public, anon, authenticated, service_role;

create or replace function public.register_market_decision(p_decision jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_decision signal_atlas.decision_events%rowtype;
begin
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
$$;

revoke execute on function signal_atlas.expected_trade_ev(
  numeric,numeric,numeric,numeric,numeric,signal_atlas.tie_policy_code
), signal_atlas.canonicalize_decision_economics(),
   signal_atlas.canonicalize_shadow_economics(),
   signal_atlas.canonicalize_policy_shadow_economics(),
   public.register_market_decision(jsonb)
from public, anon, authenticated;

revoke execute on function signal_atlas.expected_trade_ev(
  numeric,numeric,numeric,numeric,numeric,signal_atlas.tie_policy_code
), signal_atlas.canonicalize_decision_economics(),
   signal_atlas.canonicalize_shadow_economics(),
   signal_atlas.canonicalize_policy_shadow_economics()
from service_role;

grant execute on function public.register_market_decision(jsonb) to service_role;

comment on function signal_atlas.expected_trade_ev(
  numeric,numeric,numeric,numeric,numeric,signal_atlas.tie_policy_code
) is 'Canonical EV v3: directional probability is conditional on non-tie; tie PnL follows the immutable policy.';
comment on function public.register_market_decision(jsonb) is
  'Service-role ledger entrypoint. Future inserts are canonicalized by economic contract v3; historical rows are never rewritten.';

commit;
