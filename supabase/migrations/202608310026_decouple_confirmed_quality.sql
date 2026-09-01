-- Quality contract v4: technical grade and statistical confirmation are
-- independent. Applies only to future immutable decision inserts.

begin;

-- Append-only policy versions. Existing decisions retain their original
-- policy_version_id and are never reclassified.
with ranked as (
  select
    p.*,
    pg_catalog.row_number() over (
      partition by p.mode
      order by p.effective_from desc, p.version desc, p.id desc
    ) as rn
  from signal_atlas.policy_versions p
  where p.effective_from <= pg_catalog.clock_timestamp()
), prepared as (
  select
    r.mode,
    r.config || pg_catalog.jsonb_build_object(
      'require_promoted_champion_confirmed', true,
      'min_promotion_paired_samples_confirmed', 500,
      'min_probability_lb_confirmed', 0.55,
      'min_ev_lb_confirmed', 0,
      'quality_contract_version', 4
    ) as config
  from ranked r
  where r.rn = 1
)
insert into signal_atlas.policy_versions(
  policy_key, mode, version, config, config_hash, effective_from, notes
)
select
  'cloud-engine-v3',
  p.mode,
  3,
  p.config,
  pg_catalog.md5(p.config::text),
  pg_catalog.clock_timestamp(),
  'Qualidade v4: confirmação depende de promoção prospectiva real, N pareado, LB da probabilidade e EV conservador; nota técnica permanece separada.'
from prepared p
on conflict (policy_key, mode, version) do nothing;

create index if not exists confirmed_promotion_lookup_idx
  on signal_atlas.model_deployment_events(model_artifact_id, effective_at desc)
  where action = 'promote_champion'::signal_atlas.deployment_action_code
    and promotion_review_id is not null;

create or replace function signal_atlas.canonicalize_decision_economics()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_model signal_atlas.model_artifacts%rowtype;
  v_policy signal_atlas.policy_versions%rowtype;
  v_review signal_atlas.promotion_reviews%rowtype;
  v_tie numeric;
  v_ev_lb numeric;
  v_policy_pass boolean;
  v_confirmed_pass boolean := false;
  v_has_prospective_promotion boolean := false;
  v_confirmed_samples integer := 0;
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

  -- The database proves promotion from its own append-only event ledger.
  -- Offline `usable` and Edge payload text are deliberately ignored.
  select r.* into v_review
  from signal_atlas.model_deployment_events e
  join signal_atlas.promotion_reviews r on r.id = e.promotion_review_id
  where e.asset_id = new.asset_id
    and e.timeframe = new.timeframe
    and e.model_artifact_id = new.model_artifact_id
    and e.action = 'promote_champion'::signal_atlas.deployment_action_code
    and e.promotion_review_id is not null
    and e.effective_at <= new.decision_at
    and r.passed
  order by e.effective_at desc, e.created_at desc, e.id desc
  limit 1;

  if found then
    v_has_prospective_promotion := true;
    v_confirmed_samples := coalesce(v_review.paired_samples, 0);
  end if;

  v_confirmed_pass :=
    v_policy_pass
    and (
      not coalesce((v_policy.config->>'require_promoted_champion_confirmed')::boolean, true)
      or v_has_prospective_promotion
    )
    and v_confirmed_samples >= coalesce(
      (v_policy.config->>'min_promotion_paired_samples_confirmed')::integer,
      500
    )
    and coalesce(new.probability_lb, new.probability) >= coalesce(
      (v_policy.config->>'min_probability_lb_confirmed')::numeric,
      0.55
    )
    and v_ev_lb > coalesce((v_policy.config->>'min_ev_lb_confirmed')::numeric, 0);

  new.quality := case
    when coalesce(new.feature_snapshot->>'status', 'wait') <> 'signal' or not v_policy_pass
      then 'low'::signal_atlas.signal_quality_code
    when v_confirmed_pass
      then 'confirmed'::signal_atlas.signal_quality_code
    else 'technical'::signal_atlas.signal_quality_code
  end;
  new.feature_snapshot := new.feature_snapshot || pg_catalog.jsonb_build_object(
    'policy_pass', v_policy_pass,
    'confirmed_pass', v_confirmed_pass,
    'champion_promoted_prospectively', v_has_prospective_promotion,
    'promotion_review_id', case when v_has_prospective_promotion then v_review.id else null end,
    'promotion_paired_samples', v_confirmed_samples,
    'expected_ev_lb95', v_ev_lb,
    'economic_contract_version', 3,
    'quality_contract_version', 4
  );
  new.config_snapshot := new.config_snapshot || pg_catalog.jsonb_build_object(
    'stake', new.stake,
    'payout_ratio', new.payout_ratio,
    'operation_cost', new.operation_cost,
    'tie_policy', new.tie_policy,
    'tie_probability', v_tie,
    'economic_contract_version', 3,
    'quality_contract_version', 4,
    'probability_semantics', 'conditional_on_non_tie'
  );
  return new;
end
$function$;

comment on function signal_atlas.canonicalize_decision_economics() is
  'Future-only quality v4: LOW fails the base policy, TECHNICAL passes it, CONFIRMED additionally requires a real prospective promotion review and conservative decision economics. Technical grade is never a quality gate.';

-- Canonical browser projection. It exposes one latest frozen backend decision
-- per asset/timeframe/mode for the current champion, with no write path.
create or replace function signal_atlas.cloud_canonical_signal_rows()
returns table(
  id uuid,
  symbol text,
  market text,
  timeframe text,
  mode text,
  direction text,
  expiration text,
  quality text,
  status text,
  score numeric,
  grade text,
  probability numeric,
  probability_lb numeric,
  sample_size integer,
  ev_net numeric,
  ev_lb95 numeric,
  confluence_count integer,
  reference_price numeric,
  decision_at timestamptz,
  entry_at timestamptz,
  expiry_at timestamptz,
  data_age_ms integer,
  source_latency_ms integer,
  used_live_candle boolean,
  source text,
  reasons jsonb,
  champion_promoted_prospectively boolean,
  promotion_review_id uuid,
  promotion_paired_samples integer,
  confirmed_pass boolean,
  quality_contract_version integer
)
language sql
stable
security definer
set search_path = ''
as $function$
with champion_ranked as (
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
  where c.rn = 1
    and c.action <> 'retire_champion'::signal_atlas.deployment_action_code
), ranked as (
  select
    d.*,
    a.symbol,
    a.market,
    pg_catalog.row_number() over (
      partition by d.asset_id, d.timeframe, d.mode
      order by d.decision_at desc, d.id desc
    ) as rn
  from signal_atlas.decision_events d
  join signal_atlas.assets a on a.id = d.asset_id and a.active
  join champions c
    on c.asset_id = d.asset_id
   and c.timeframe = d.timeframe
   and c.model_artifact_id = d.model_artifact_id
  where d.model_role = 'champion'
    and not exists (
      select 1
      from signal_atlas.correction_events x
      where x.target_type = 'decision'
        and x.target_id = d.id
        and x.correction_type = 'invalidate'
    )
)
select
  r.id,
  r.symbol,
  r.market::text,
  r.timeframe::text,
  r.mode::text,
  r.direction::text,
  r.expiration::text,
  r.quality::text,
  coalesce(r.feature_snapshot->>'status', 'wait'),
  r.score,
  coalesce(nullif(r.feature_snapshot->>'grade', ''), 'D'),
  r.probability,
  r.probability_lb,
  r.statistical_sample_size,
  r.expected_ev,
  nullif(r.feature_snapshot->>'expected_ev_lb95', '')::numeric,
  r.confluence_count,
  r.reference_price,
  r.decision_at,
  r.entry_at,
  r.expiry_at,
  r.data_age_ms,
  r.source_latency_ms,
  r.used_live_candle,
  coalesce(r.data_lineage->>'source', 'unknown'),
  case when pg_catalog.jsonb_typeof(r.reasons) = 'array' then r.reasons else '[]'::jsonb end,
  coalesce((r.feature_snapshot->>'champion_promoted_prospectively')::boolean, false),
  nullif(r.feature_snapshot->>'promotion_review_id', '')::uuid,
  coalesce((r.feature_snapshot->>'promotion_paired_samples')::integer, 0),
  coalesce((r.feature_snapshot->>'confirmed_pass')::boolean, false),
  coalesce((r.feature_snapshot->>'quality_contract_version')::integer, 3)
from ranked r
where r.rn = 1
$function$;

revoke all on function signal_atlas.cloud_canonical_signal_rows()
from public, anon, authenticated, service_role;
grant execute on function signal_atlas.cloud_canonical_signal_rows()
to anon, authenticated, service_role;

create or replace view public.cloud_canonical_signals
with (security_invoker = true)
as select * from signal_atlas.cloud_canonical_signal_rows();

revoke all on public.cloud_canonical_signals
from public, anon, authenticated, service_role;
grant select on public.cloud_canonical_signals
to anon, authenticated, service_role;

comment on view public.cloud_canonical_signals is
  'Read-only latest frozen backend signal per asset/timeframe/mode. This is the official signal source for the browser; local analysis remains complementary.';

commit;
