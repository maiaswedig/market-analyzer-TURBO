-- Close the remaining causal/idempotency gaps before the public release.
-- This migration does not delete historical rows.  When an old wait and an
-- old paper decision share the same logical slot, the earliest event wins and
-- the later decision receives an append-only invalidation correction.

begin;

create unique index if not exists model_artifacts_idempotency_key_idx
  on signal_atlas.model_artifacts ((training_config->>'idempotency_key'))
  where nullif(pg_catalog.btrim(training_config->>'idempotency_key'), '') is not null;

create table if not exists signal_atlas.decision_slots (
  slot_key text primary key,
  event_kind text not null check (event_kind in ('wait', 'signal')),
  wait_event_id uuid unique references signal_atlas.analysis_waits(id),
  decision_event_id uuid unique references signal_atlas.decision_events(id),
  frozen_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (
    (event_kind = 'wait' and wait_event_id is not null and decision_event_id is null)
    or (event_kind = 'signal' and decision_event_id is not null and wait_event_id is null)
  )
);

with candidates as (
  select w.idempotency_key as slot_key, 'wait'::text as event_kind,
    w.id as wait_event_id, null::uuid as decision_event_id,
    w.created_at as frozen_at, 0 as tie_priority
  from signal_atlas.analysis_waits w
  union all
  select d.idempotency_key, 'signal'::text,
    null::uuid, d.id, d.created_at, 1
  from signal_atlas.decision_events d
), ranked as (
  select c.*,
    pg_catalog.row_number() over (
      partition by c.slot_key
      order by c.frozen_at, c.tie_priority, coalesce(c.wait_event_id, c.decision_event_id)
    ) as rn
  from candidates c
)
insert into signal_atlas.decision_slots(
  slot_key, event_kind, wait_event_id, decision_event_id, frozen_at
)
select slot_key, event_kind, wait_event_id, decision_event_id, frozen_at
from ranked
where rn = 1
on conflict (slot_key) do nothing;

insert into signal_atlas.correction_events(
  idempotency_key, target_type, target_id, correction_type, reason,
  replacement_payload, actor_id
)
select
  'slot-first-event|' || d.id::text,
  'decision'::signal_atlas.correction_target_code,
  d.id,
  'invalidate',
  'Decisão posterior a um AGUARDAR já congelado no mesmo slot causal.',
  pg_catalog.jsonb_build_object(
    'slot_key', s.slot_key,
    'first_event_kind', s.event_kind,
    'first_wait_event_id', s.wait_event_id
  ),
  null
from signal_atlas.decision_events d
join signal_atlas.decision_slots s
  on s.slot_key = d.idempotency_key and s.event_kind = 'wait'
where not exists (
  select 1 from signal_atlas.correction_events c
  where c.target_type = 'decision'
    and c.target_id = d.id
    and c.correction_type = 'invalidate'
)
on conflict (idempotency_key) do nothing;

alter table signal_atlas.decision_slots enable row level security;
revoke all on signal_atlas.decision_slots from public, anon, authenticated, service_role;
grant select on signal_atlas.decision_slots to service_role;
drop trigger if exists append_only_guard on signal_atlas.decision_slots;
create trigger append_only_guard before update or delete on signal_atlas.decision_slots
for each row execute function signal_atlas.reject_update_delete();

-- Version 2 is the exact policy consumed by the worker.  Threshold failures
-- only downgrade quality; they do not hide an existing technical direction.
with policy_seed(mode, notes, config) as (
  values
    (
      'conservador'::signal_atlas.mode_code,
      'Cloud engine v2 conservador: qualidade estrita sem ocultar direção técnica.',
      '{
        "engine_policy_version":1,
        "feature_schema_version":"signal-atlas-cloud-core-v1",
        "min_score":72,
        "min_probability":0.60,
        "min_probability_lb":0.52,
        "min_confluence":4,
        "min_live_progress":0.75,
        "min_statistical_samples":300,
        "max_data_age_timeframe_ratio":0.50,
        "max_source_latency_ms":2500,
        "require_positive_ev_lb95":true,
        "payout_ratio":0.85,
        "operation_cost":0.02,
        "tie_policy":"loss",
        "news_guard":"strict",
        "entry":"next_candle_open",
        "allowed_expirations":["E1","E2","E3"]
      }'::jsonb
    ),
    (
      'neutro'::signal_atlas.mode_code,
      'Cloud engine v2 neutro: equilíbrio entre cobertura e evidência.',
      '{
        "engine_policy_version":1,
        "feature_schema_version":"signal-atlas-cloud-core-v1",
        "min_score":62,
        "min_probability":0.55,
        "min_probability_lb":0.50,
        "min_confluence":3,
        "min_live_progress":0.65,
        "min_statistical_samples":300,
        "max_data_age_timeframe_ratio":0.75,
        "max_source_latency_ms":4000,
        "require_positive_ev_lb95":true,
        "payout_ratio":0.85,
        "operation_cost":0.02,
        "tie_policy":"loss",
        "news_guard":"warn",
        "entry":"next_candle_open",
        "allowed_expirations":["E1","E2","E3"]
      }'::jsonb
    ),
    (
      'agressivo'::signal_atlas.mode_code,
      'Cloud engine v2 agressivo: maior cobertura com avisos preservados.',
      '{
        "engine_policy_version":1,
        "feature_schema_version":"signal-atlas-cloud-core-v1",
        "min_score":54,
        "min_probability":0.51,
        "min_probability_lb":0.48,
        "min_confluence":2,
        "min_live_progress":0.50,
        "min_statistical_samples":300,
        "max_data_age_timeframe_ratio":1.00,
        "max_source_latency_ms":6000,
        "require_positive_ev_lb95":false,
        "payout_ratio":0.85,
        "operation_cost":0.02,
        "tie_policy":"loss",
        "news_guard":"warn",
        "entry":"next_candle_open",
        "allowed_expirations":["E1","E2","E3"]
      }'::jsonb
    )
)
insert into signal_atlas.policy_versions(
  policy_key, mode, version, config, config_hash, effective_from, notes
)
select
  'cloud-engine-v2', mode, 2, config, pg_catalog.md5(config::text),
  pg_catalog.clock_timestamp(), notes
from policy_seed
on conflict (policy_key, mode, version) do nothing;

create or replace view public.worker_policy_settings
with (security_invoker = true)
as
select distinct on (p.mode)
  p.id,
  p.policy_key,
  p.mode::text as mode,
  p.version,
  p.config,
  p.config_hash,
  p.effective_from
from signal_atlas.policy_versions p
where p.effective_from <= pg_catalog.clock_timestamp()
order by p.mode, p.effective_from desc, p.version desc, p.id desc;

revoke all on public.worker_policy_settings from public, anon, authenticated, service_role;
grant select on public.worker_policy_settings to service_role;

create or replace function public.create_model_artifact(p_artifact jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset signal_atlas.assets%rowtype;
  v_tf signal_atlas.timeframe_code;
  v_artifact jsonb;
  v_sha text;
  v_feature_hash text;
  v_metrics jsonb;
  v_training jsonb;
  v_model_id uuid;
  v_event_id uuid;
  v_usable boolean;
  v_key text := pg_catalog.btrim(p_artifact->>'idempotency_key');
  v_existing signal_atlas.model_artifacts%rowtype;
begin
  if pg_catalog.jsonb_typeof(p_artifact) <> 'object'
     or pg_catalog.jsonb_typeof(p_artifact->'artifact') <> 'object' then
    raise exception using errcode = '22023', message = 'model artifact payload is invalid';
  end if;
  if coalesce(pg_catalog.length(v_key), 0) < 16 then
    raise exception using errcode = '22023', message = 'model artifact idempotency key is required';
  end if;

  select * into v_asset from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_artifact->>'symbol')) and active;
  if not found then
    raise exception using errcode = '23503', message = 'active asset not found';
  end if;
  v_tf := (p_artifact->>'timeframe')::signal_atlas.timeframe_code;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('model|' || v_key, 0));
  select * into v_existing
  from signal_atlas.model_artifacts m
  where m.training_config->>'idempotency_key' = v_key;
  if found then
    if v_existing.asset_id <> v_asset.id
       or v_existing.timeframe <> v_tf
       or v_existing.training_cutoff_at <> (p_artifact->>'train_to')::timestamptz then
      raise exception using errcode = '23505', message = 'model idempotency key already belongs to a different immutable scope';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'existing', true,
      'modelId', v_existing.id,
      'sha256', v_existing.artifact_sha256,
      'usable', coalesce((v_existing.validation_metrics->>'usable')::boolean, false),
      'bootstrapDeploymentEventId', null
    );
  end if;

  v_artifact := p_artifact->'artifact';
  v_usable := coalesce((p_artifact->>'usable')::boolean, false);
  v_sha := pg_catalog.encode(extensions.digest(v_artifact::text, 'sha256'), 'hex');
  v_feature_hash := pg_catalog.encode(extensions.digest(
    coalesce(p_artifact->>'feature_schema_version', 'unknown'), 'sha256'), 'hex');
  v_metrics := coalesce(p_artifact->'metrics', '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'sample_size', coalesce((p_artifact->>'validation_sample_size')::integer, 0),
    'training_sample_size', coalesce((p_artifact->>'sample_size')::integer, 0),
    'usable', v_usable,
    'gates', coalesce(p_artifact->'gates', '[]'::jsonb)
  );
  v_training := pg_catalog.jsonb_build_object(
    'artifact', v_artifact,
    'algorithm', p_artifact->>'algorithm',
    'engine_policy_version', p_artifact->>'engine_policy_version',
    'validation_policy_version', p_artifact->>'validation_policy_version',
    'policy_signature', p_artifact->>'policy_signature',
    'idempotency_key', v_key
  );
  v_model_id := signal_atlas.register_model_artifact(
    v_asset.id, v_tf, 'inline://' || v_sha, v_sha, v_feature_hash,
    v_training, v_metrics,
    (p_artifact->>'train_from')::timestamptz,
    (p_artifact->>'train_to')::timestamptz,
    (p_artifact->>'train_to')::timestamptz,
    (p_artifact->>'validation_from')::timestamptz,
    (p_artifact->>'validation_to')::timestamptz
  );

  if v_usable and signal_atlas.current_champion_model(v_asset.id, v_tf) is null then
    v_event_id := signal_atlas.bootstrap_champion(
      v_asset.id, v_tf, v_model_id,
      'bootstrap|' || v_asset.symbol || '|' || v_tf::text || '|' || v_sha,
      'Primeiro modelo aprovado offline; trocas futuras exigem shadow prospectivo.'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'existing', false,
    'modelId', v_model_id,
    'sha256', v_sha,
    'usable', v_usable,
    'bootstrapDeploymentEventId', v_event_id
  );
end
$$;

create or replace function public.register_market_decision(p_decision jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset signal_atlas.assets%rowtype;
  v_model signal_atlas.model_artifacts%rowtype;
  v_shadow_model signal_atlas.model_artifacts%rowtype;
  v_policy signal_atlas.policy_versions%rowtype;
  v_slot signal_atlas.decision_slots%rowtype;
  v_existing_decision signal_atlas.decision_events%rowtype;
  v_mode signal_atlas.mode_code := coalesce(p_decision->>'mode', 'neutro')::signal_atlas.mode_code;
  v_direction signal_atlas.direction_code;
  v_emitted timestamptz := (p_decision->>'emitted_at')::timestamptz;
  v_observed timestamptz := (p_decision->>'observed_candle_open')::timestamptz;
  v_entry timestamptz := (p_decision->>'entry_candle_open')::timestamptz;
  v_expiry timestamptz := (p_decision->>'resolve_after')::timestamptz;
  v_source_received timestamptz;
  v_model_id uuid;
  v_probability numeric;
  v_probability_lb numeric;
  v_sample integer;
  v_payout numeric;
  v_cost numeric;
  v_ev numeric;
  v_ev_lb numeric;
  v_prediction jsonb;
  v_shadows jsonb := '[]'::jsonb;
  v_payload jsonb;
  v_id uuid;
  v_wait_id uuid;
  v_key text := pg_catalog.btrim(p_decision->>'idempotency_key');
  v_slot_key text;
  v_reasons jsonb;
  v_blockers jsonb;
  v_quality text;
  v_hash text;
  v_data_age integer;
  v_source_latency integer;
  v_tf_seconds integer;
  v_policy_pass boolean;
  v_used_live boolean := coalesce((p_decision->>'used_live_candle')::boolean, false);
begin
  if pg_catalog.jsonb_typeof(p_decision) <> 'object' then
    raise exception using errcode = '22023', message = 'decision payload must be an object';
  end if;
  if coalesce(pg_catalog.length(v_key), 0) < 16 then
    raise exception using errcode = '22023', message = 'decision idempotency key is required';
  end if;

  select * into v_asset from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_decision->>'symbol')) and active;
  if not found then raise exception using errcode = '23503', message = 'active asset not found'; end if;
  v_slot_key := v_key || '|' || v_mode::text;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('decision|' || v_slot_key, 0));

  select * into v_slot from signal_atlas.decision_slots where slot_key = v_slot_key;
  if found then
    if v_slot.event_kind = 'wait' then
      return pg_catalog.jsonb_build_object('ok', true, 'kind', 'wait', 'id', v_slot.wait_event_id, 'existing', true);
    end if;
    select * into v_existing_decision from signal_atlas.decision_events
    where id = v_slot.decision_event_id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'kind', case when v_existing_decision.quality = 'low' then 'low-signal' else 'signal' end,
      'id', v_existing_decision.id,
      'quality', v_existing_decision.quality,
      'probability', v_existing_decision.probability,
      'probabilityLb', v_existing_decision.probability_lb,
      'evNet', v_existing_decision.expected_ev,
      'existing', true
    );
  end if;

  v_reasons := coalesce(p_decision->'reasons', '[]'::jsonb);
  v_blockers := coalesce(p_decision->'blockers', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(v_reasons) <> 'array' or pg_catalog.jsonb_typeof(v_blockers) <> 'array' then
    raise exception using errcode = '22023', message = 'reasons and blockers must be arrays';
  end if;
  if nullif(p_decision->>'direction', '') is not null then
    v_direction := (p_decision->>'direction')::signal_atlas.direction_code;
  end if;
  if nullif(p_decision->>'champion_model_id', '') is not null then
    v_model_id := (p_decision->>'champion_model_id')::uuid;
  end if;

  -- Genuine absence of direction/model/live state is the only hard wait.
  -- All ordinary technical filters continue as a visible low-signal.
  if v_direction is null or v_model_id is null or not v_used_live then
    insert into signal_atlas.analysis_waits(
      idempotency_key, asset_id, timeframe, mode, observed_candle_open,
      planned_entry_at, emitted_at, suggested_direction, score, grade,
      reasons, blockers, run_id
    ) values (
      v_slot_key, v_asset.id,
      (p_decision->>'timeframe')::signal_atlas.timeframe_code, v_mode,
      v_observed, v_entry, v_emitted, v_direction,
      coalesce((p_decision->>'score')::numeric, 50),
      coalesce(p_decision->>'grade', 'D'), v_reasons, v_blockers,
      nullif(p_decision->>'run_id', '')::uuid
    ) returning id into v_wait_id;
    insert into signal_atlas.decision_slots(
      slot_key, event_kind, wait_event_id, decision_event_id, frozen_at
    ) values (v_slot_key, 'wait', v_wait_id, null, v_emitted);
    return pg_catalog.jsonb_build_object('ok', true, 'kind', 'wait', 'id', v_wait_id, 'existing', false);
  end if;

  select * into v_model from signal_atlas.model_artifacts where id = v_model_id;
  if not found or v_model.asset_id <> v_asset.id
     or v_model.timeframe::text <> p_decision->>'timeframe' then
    raise exception using errcode = '23514', message = 'champion model does not match decision scope';
  end if;
  if signal_atlas.current_champion_model(v_asset.id, v_model.timeframe, v_emitted) is distinct from v_model.id then
    raise exception using errcode = '23514', message = 'decision model is not the active champion at emitted_at';
  end if;

  select * into v_policy from signal_atlas.policy_versions
  where mode = v_mode and effective_from <= v_emitted
  order by effective_from desc, version desc, id desc limit 1;
  if not found then raise exception using errcode = '23503', message = 'active policy version not found'; end if;
  if nullif(p_decision->>'policy_version_id', '')::uuid is distinct from v_policy.id
     or p_decision->>'policy_signature' is distinct from v_policy.config_hash
     or coalesce((p_decision->>'engine_policy_version')::integer, -1)
        <> coalesce((v_policy.config->>'engine_policy_version')::integer, -2)
     or p_decision->>'feature_schema_version'
        is distinct from v_policy.config->>'feature_schema_version' then
    raise exception using errcode = '23514', message = 'decision policy snapshot does not match the active immutable policy';
  end if;

  v_source_received := (p_decision->>'source_received_at')::timestamptz;
  v_source_latency := coalesce((p_decision->>'source_latency_ms')::integer, -1);
  if v_source_received is null or v_source_received > v_emitted
     or v_source_latency < 0 or v_source_latency > 120000 then
    raise exception using errcode = '23514', message = 'invalid source receipt/latency snapshot';
  end if;
  v_data_age := greatest(0, (extract(epoch from (v_emitted - v_source_received)) * 1000)::integer);
  if nullif(p_decision->>'data_age_ms', '') is not null
     and pg_catalog.abs((p_decision->>'data_age_ms')::integer - v_data_age) > 2000 then
    raise exception using errcode = '23514', message = 'data age differs from the immutable receipt clock';
  end if;

  for v_prediction in
    select value from pg_catalog.jsonb_array_elements(coalesce(p_decision->'predictions', '[]'::jsonb))
  loop
    if v_prediction->>'model_id' = v_model_id::text and v_prediction->>'role' = 'champion' then
      v_probability := case when v_direction = 'buy'
        then (v_prediction->>'probability_up')::numeric
        else 1 - (v_prediction->>'probability_up')::numeric end;
    end if;
  end loop;
  if v_probability is null or v_probability < 0 or v_probability > 1 then
    raise exception using errcode = '23514', message = 'champion prediction is missing or invalid';
  end if;
  v_sample := coalesce((v_model.validation_metrics->>'sample_size')::integer, 0);
  v_probability_lb := greatest(0, v_probability - 1.5 * pg_catalog.sqrt(
    greatest(0, v_probability * (1 - v_probability)) / greatest(v_sample, 1)
  ));
  v_payout := coalesce((v_policy.config->>'payout_ratio')::numeric, 0.85);
  v_cost := coalesce((v_policy.config->>'operation_cost')::numeric, 0.02);
  v_ev := v_probability * v_payout - (1 - v_probability) - v_cost;
  v_ev_lb := v_probability_lb * v_payout - (1 - v_probability_lb) - v_cost;
  v_tf_seconds := signal_atlas.timeframe_seconds(v_model.timeframe);
  v_policy_pass :=
    coalesce((p_decision->>'score')::numeric, 50) >= coalesce((v_policy.config->>'min_score')::numeric, 0)
    and coalesce((p_decision->>'confluence_count')::integer, 0) >= coalesce((v_policy.config->>'min_confluence')::integer, 0)
    and v_sample >= coalesce((v_policy.config->>'min_statistical_samples')::integer, 0)
    and v_probability >= coalesce((v_policy.config->>'min_probability')::numeric, 0)
    and v_probability_lb >= coalesce((v_policy.config->>'min_probability_lb')::numeric, 0)
    and v_data_age <= (v_tf_seconds * 1000 * coalesce((v_policy.config->>'max_data_age_timeframe_ratio')::numeric, 1))
    and v_source_latency <= coalesce((v_policy.config->>'max_source_latency_ms')::integer, 120000)
    and (
      not coalesce((v_policy.config->>'require_positive_ev_lb95')::boolean, false)
      or v_ev_lb > 0
    );

  for v_prediction in
    select value from pg_catalog.jsonb_array_elements(coalesce(p_decision->'predictions', '[]'::jsonb))
  loop
    if v_prediction->>'role' <> 'shadow' then continue; end if;
    select * into v_shadow_model from signal_atlas.model_artifacts
    where id = (v_prediction->>'model_id')::uuid;
    if not found or v_shadow_model.asset_id <> v_asset.id
       or v_shadow_model.timeframe <> v_model.timeframe
       or v_shadow_model.created_at > v_emitted then
      continue;
    end if;
    v_probability := case when v_direction = 'buy'
      then (v_prediction->>'probability_up')::numeric
      else 1 - (v_prediction->>'probability_up')::numeric end;
    if v_probability < 0 or v_probability > 1 then continue; end if;
    v_sample := coalesce((v_shadow_model.validation_metrics->>'sample_size')::integer, 0);
    v_shadows := v_shadows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'model_artifact_id', v_shadow_model.id,
      'direction', v_direction,
      'score', least(100, greatest(0, 50 + pg_catalog.abs(v_probability - 0.5) * 100)),
      'probability', v_probability,
      'probability_lb', greatest(0, v_probability - 1.5 * pg_catalog.sqrt(
        greatest(0, v_probability * (1 - v_probability)) / greatest(v_sample, 1))),
      'expected_ev', v_probability * v_payout - (1 - v_probability) - v_cost,
      'statistical_sample_size', v_sample,
      'reasons', pg_catalog.jsonb_build_array('Previsão shadow prospectiva no mesmo snapshot do champion')
    ));
  end loop;

  -- Restore immutable champion statistics after iterating over shadows.
  v_sample := coalesce((v_model.validation_metrics->>'sample_size')::integer, 0);
  for v_prediction in
    select value from pg_catalog.jsonb_array_elements(coalesce(p_decision->'predictions', '[]'::jsonb))
  loop
    if v_prediction->>'model_id' = v_model_id::text and v_prediction->>'role' = 'champion' then
      v_probability := case when v_direction = 'buy'
        then (v_prediction->>'probability_up')::numeric
        else 1 - (v_prediction->>'probability_up')::numeric end;
    end if;
  end loop;
  v_probability_lb := greatest(0, v_probability - 1.5 * pg_catalog.sqrt(
    greatest(0, v_probability * (1 - v_probability)) / greatest(v_sample, 1)));
  v_ev := v_probability * v_payout - (1 - v_probability) - v_cost;
  v_quality := case
    when p_decision->>'status' <> 'signal' or not v_policy_pass then 'low'
    when p_decision->>'grade' in ('A+', 'A') then 'confirmed'
    else 'technical'
  end;
  v_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.concat_ws('|', v_asset.symbol, p_decision->>'timeframe', v_observed::text,
      coalesce((p_decision->'feature_vector')::text, '[]'), v_policy.config_hash),
    'sha256'), 'hex');
  v_payload := pg_catalog.jsonb_build_object(
    'idempotency_key', v_slot_key,
    'symbol', v_asset.symbol,
    'timeframe', p_decision->>'timeframe',
    'mode', v_mode,
    'model_role', 'champion',
    'model_artifact_id', v_model.id,
    'policy_version_id', v_policy.id,
    'direction', v_direction,
    'expiration', coalesce(p_decision->>'expiration', 'E1'),
    'quality', v_quality,
    'score', coalesce((p_decision->>'score')::numeric, 50),
    'probability', v_probability,
    'probability_lb', v_probability_lb,
    'expected_ev', v_ev,
    'confluence_count', coalesce((p_decision->>'confluence_count')::integer, 0),
    'statistical_sample_size', v_sample,
    'reference_price', (p_decision->>'reference_price')::numeric,
    'stake', 1,
    'payout_ratio', v_payout,
    'operation_cost', v_cost,
    'tie_policy', coalesce(v_policy.config->>'tie_policy', 'loss'),
    'tie_probability', coalesce((v_model.training_config->'artifact'->>'tieRate')::numeric, 0),
    'feature_cutoff_at', v_source_received,
    'entry_at', v_entry,
    'expiry_at', v_expiry,
    'source_candle_open_time', v_observed,
    'source_received_at', v_source_received,
    'data_age_ms', v_data_age,
    'source_latency_ms', v_source_latency,
    'used_live_candle', v_used_live,
    'candle_set_hash', v_hash,
    'feature_snapshot', pg_catalog.jsonb_build_object(
      'schema', p_decision->>'feature_schema_version',
      'vector', coalesce(p_decision->'feature_vector', '[]'::jsonb),
      'grade', p_decision->>'grade',
      'status', p_decision->>'status',
      'policy_pass', v_policy_pass
    ),
    'data_lineage', pg_catalog.jsonb_build_object(
      'run_id', p_decision->>'run_id',
      'source', p_decision->>'source',
      'provider_symbol', p_decision->>'provider_symbol',
      'observed_candle_open', v_observed,
      'source_received_at', v_source_received,
      'source_latency_ms', v_source_latency
    ),
    'reasons', v_reasons || v_blockers,
    'shadow_predictions', v_shadows
  );
  v_id := signal_atlas.register_decision(v_payload);
  insert into signal_atlas.decision_slots(
    slot_key, event_kind, wait_event_id, decision_event_id, frozen_at
  ) values (v_slot_key, 'signal', null, v_id, v_emitted);
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'kind', case when v_quality = 'low' then 'low-signal' else 'signal' end,
    'id', v_id,
    'quality', v_quality,
    'probability', v_probability,
    'probabilityLb', v_probability_lb,
    'evNet', v_ev,
    'existing', false
  );
end
$$;

-- Only the narrow SECURITY DEFINER RPCs may mutate the append-only ledger.
revoke insert, update, delete on signal_atlas.analysis_waits from service_role;
revoke execute on function signal_atlas.register_decision(jsonb) from public, anon, authenticated, service_role;
revoke execute on function signal_atlas.register_model_artifact(
  uuid,signal_atlas.timeframe_code,text,text,text,jsonb,jsonb,
  timestamptz,timestamptz,timestamptz,timestamptz,timestamptz
) from public, anon, authenticated, service_role;

revoke execute on function public.create_model_artifact(jsonb),
  public.register_market_decision(jsonb)
from public, anon, authenticated;
grant execute on function public.create_model_artifact(jsonb),
  public.register_market_decision(jsonb)
to service_role;

comment on table signal_atlas.decision_slots is
  'Global first-event ledger: exactly one immutable wait or paper decision per asset/timeframe/candle/mode slot.';
comment on view public.worker_policy_settings is
  'Service-role-only active immutable engine policy consumed by market-cycle.';
comment on function public.register_market_decision(jsonb) is
  'Freezes the first causal event and downgrades failed filters to low quality instead of hiding a technical direction.';

commit;
