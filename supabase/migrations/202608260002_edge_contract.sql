-- Compatibility layer between the Signal Atlas Edge workers and the private,
-- append-only validation ledger created by 202608260001_cloud_validation.sql.
-- No secret is stored here.  Browser access is limited to the five cloud_* views.

begin;

create table if not exists signal_atlas.analysis_waits (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  idempotency_key text not null unique,
  asset_id uuid not null references signal_atlas.assets(id),
  timeframe signal_atlas.timeframe_code not null,
  mode signal_atlas.mode_code not null,
  observed_candle_open timestamptz not null,
  planned_entry_at timestamptz not null,
  emitted_at timestamptz not null,
  suggested_direction signal_atlas.direction_code,
  score numeric not null,
  grade text not null,
  reasons jsonb not null default '[]'::jsonb,
  blockers jsonb not null default '[]'::jsonb,
  run_id uuid,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (score between 0 and 100),
  check (grade in ('A+', 'A', 'B', 'C', 'D')),
  check (pg_catalog.jsonb_typeof(reasons) = 'array'),
  check (pg_catalog.jsonb_typeof(blockers) = 'array')
);

create index if not exists analysis_waits_segment_idx
  on signal_atlas.analysis_waits(asset_id, timeframe, mode, emitted_at desc);

alter table signal_atlas.analysis_waits enable row level security;
revoke all on signal_atlas.analysis_waits from public, anon, authenticated, service_role;
grant select, insert on signal_atlas.analysis_waits to service_role;
drop trigger if exists append_only_guard on signal_atlas.analysis_waits;
create trigger append_only_guard before update or delete on signal_atlas.analysis_waits
for each row execute function signal_atlas.reject_update_delete();

create or replace view public.assets_watchlist
with (security_invoker = true)
as
select id, symbol, provider_symbol, market::text as market, source, active, metadata
from signal_atlas.assets;

create or replace view public.candles
with (security_invoker = true)
as
select
  c.id,
  a.symbol,
  c.timeframe::text as timeframe,
  c.open_time,
  c.close_time,
  c.open,
  c.high,
  c.low,
  c.close,
  c.volume,
  c.source,
  c.is_closed,
  c.source_observed_at,
  c.received_at as inserted_at,
  c.source_latency_ms
from signal_atlas.candles c
join signal_atlas.assets a on a.id = c.asset_id;

create or replace view public.model_artifacts
with (security_invoker = true)
as
select
  m.id,
  a.symbol,
  m.timeframe::text as timeframe,
  case
    when c.model_artifact_id = m.id then 'production'
    when coalesce((m.validation_metrics->>'usable')::boolean, false) then 'candidate'
    else 'rejected'
  end as status,
  m.training_config->'artifact' as artifact,
  m.validation_metrics as metrics,
  m.training_cutoff_at,
  m.created_at
from signal_atlas.model_artifacts m
join signal_atlas.assets a on a.id = m.asset_id
left join signal_atlas.current_champions c
  on c.asset_id = m.asset_id and c.timeframe = m.timeframe;

create or replace function public.ingest_candles(
  p_symbol text,
  p_timeframe text,
  p_source text,
  p_closed_candles jsonb,
  p_live_candle jsonb,
  p_run_id uuid,
  p_received_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset signal_atlas.assets%rowtype;
  v_tf signal_atlas.timeframe_code := p_timeframe::signal_atlas.timeframe_code;
  v_row jsonb;
  v_id uuid;
  v_closed integer := 0;
  v_live integer := 0;
  v_hash text;
  v_open_time timestamptz;
  v_is_closed boolean;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_closed_candles, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'p_closed_candles must be an array';
  end if;
  select * into v_asset from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_symbol)) and active;
  if not found then raise exception using errcode = '23503', message = 'active asset not found'; end if;
  if v_asset.source <> p_source then
    raise exception using errcode = '23514', message = 'provider source differs from immutable watchlist';
  end if;
  if p_received_at > pg_catalog.clock_timestamp() + interval '5 seconds' then
    raise exception using errcode = '23514', message = 'received_at cannot be in the future';
  end if;

  for v_row in select value from pg_catalog.jsonb_array_elements(coalesce(p_closed_candles, '[]'::jsonb))
  loop
    v_open_time := (v_row->>'open_time')::timestamptz;
    v_is_closed := coalesce((v_row->>'is_closed')::boolean, true);
    if not v_is_closed then
      raise exception using errcode = '23514', message = 'closed batch contains a live candle';
    end if;
    v_hash := pg_catalog.encode(extensions.digest(
      pg_catalog.concat_ws('|', p_symbol, p_timeframe, v_open_time::text,
        v_row->>'open', v_row->>'high', v_row->>'low', v_row->>'close',
        coalesce(v_row->>'volume', '0'), p_source, 'closed'), 'sha256'), 'hex');
    v_id := signal_atlas.ingest_candle(
      v_asset.id, v_tf, v_open_time,
      (v_row->>'open')::numeric, (v_row->>'high')::numeric,
      (v_row->>'low')::numeric, (v_row->>'close')::numeric,
      coalesce((v_row->>'volume')::numeric, 0), p_source, true,
      p_received_at, 0, v_hash
    );
    v_closed := v_closed + 1;
  end loop;

  if p_live_candle is not null and p_live_candle <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_live_candle) <> 'object' then
      raise exception using errcode = '22023', message = 'p_live_candle must be an object or null';
    end if;
    v_open_time := (p_live_candle->>'open_time')::timestamptz;
    v_hash := pg_catalog.encode(extensions.digest(
      pg_catalog.concat_ws('|', p_symbol, p_timeframe, v_open_time::text,
        p_live_candle->>'open', p_live_candle->>'high', p_live_candle->>'low',
        p_live_candle->>'close', coalesce(p_live_candle->>'volume', '0'), p_source, 'live'),
      'sha256'), 'hex');
    v_id := signal_atlas.ingest_candle(
      v_asset.id, v_tf, v_open_time,
      (p_live_candle->>'open')::numeric, (p_live_candle->>'high')::numeric,
      (p_live_candle->>'low')::numeric, (p_live_candle->>'close')::numeric,
      coalesce((p_live_candle->>'volume')::numeric, 0), p_source, false,
      p_received_at, 0, v_hash
    );
    v_live := 1;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'runId', p_run_id, 'closedAccepted', v_closed,
    'liveAccepted', v_live, 'receivedAt', p_received_at
  );
end
$$;

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
begin
  if pg_catalog.jsonb_typeof(p_artifact) <> 'object'
     or pg_catalog.jsonb_typeof(p_artifact->'artifact') <> 'object' then
    raise exception using errcode = '22023', message = 'model artifact payload is invalid';
  end if;
  select * into v_asset from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_artifact->>'symbol')) and active;
  if not found then raise exception using errcode = '23503', message = 'active asset not found'; end if;
  v_tf := (p_artifact->>'timeframe')::signal_atlas.timeframe_code;
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
    'idempotency_key', p_artifact->>'idempotency_key'
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
      'Primeiro modelo que passou os gates cronológicos offline; trocas futuras exigem shadow prospectivo.'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'modelId', v_model_id, 'sha256', v_sha,
    'usable', v_usable, 'bootstrapDeploymentEventId', v_event_id
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
  v_mode signal_atlas.mode_code := coalesce(p_decision->>'mode', 'neutro')::signal_atlas.mode_code;
  v_direction signal_atlas.direction_code;
  v_emitted timestamptz := (p_decision->>'emitted_at')::timestamptz;
  v_observed timestamptz := (p_decision->>'observed_candle_open')::timestamptz;
  v_entry timestamptz := (p_decision->>'entry_candle_open')::timestamptz;
  v_expiry timestamptz := (p_decision->>'resolve_after')::timestamptz;
  v_model_id uuid;
  v_probability numeric;
  v_probability_lb numeric;
  v_sample integer;
  v_payout numeric;
  v_cost numeric;
  v_ev numeric;
  v_prediction jsonb;
  v_shadows jsonb := '[]'::jsonb;
  v_payload jsonb;
  v_id uuid;
  v_wait_id uuid;
  v_key text := pg_catalog.btrim(p_decision->>'idempotency_key');
  v_reasons jsonb;
  v_blockers jsonb;
  v_quality text;
  v_hash text;
begin
  if pg_catalog.jsonb_typeof(p_decision) <> 'object' then
    raise exception using errcode = '22023', message = 'decision payload must be an object';
  end if;
  select * into v_asset from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_decision->>'symbol')) and active;
  if not found then raise exception using errcode = '23503', message = 'active asset not found'; end if;
  v_reasons := coalesce(p_decision->'reasons', '[]'::jsonb);
  v_blockers := coalesce(p_decision->'blockers', '[]'::jsonb);

  if nullif(p_decision->>'direction', '') is not null then
    v_direction := (p_decision->>'direction')::signal_atlas.direction_code;
  end if;
  if nullif(p_decision->>'champion_model_id', '') is not null then
    v_model_id := (p_decision->>'champion_model_id')::uuid;
  end if;

  -- A neutral reading or a scope that has not yet obtained a valid champion is
  -- an explicit AGUARDAR event.  It is visible operationally but never counted
  -- as a win/loss and never masquerades as a trained prediction.
  if v_direction is null or v_model_id is null then
    insert into signal_atlas.analysis_waits(
      idempotency_key, asset_id, timeframe, mode, observed_candle_open,
      planned_entry_at, emitted_at, suggested_direction, score, grade,
      reasons, blockers, run_id
    ) values (
      v_key || '|' || v_mode::text, v_asset.id,
      (p_decision->>'timeframe')::signal_atlas.timeframe_code, v_mode,
      v_observed, v_entry, v_emitted, v_direction,
      coalesce((p_decision->>'score')::numeric, 50),
      coalesce(p_decision->>'grade', 'D'), v_reasons, v_blockers,
      nullif(p_decision->>'run_id', '')::uuid
    ) on conflict (idempotency_key) do nothing returning id into v_wait_id;
    if v_wait_id is null then
      select id into v_wait_id from signal_atlas.analysis_waits
      where idempotency_key = v_key || '|' || v_mode::text;
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'kind', 'wait', 'id', v_wait_id);
  end if;

  select * into v_model from signal_atlas.model_artifacts where id = v_model_id;
  if not found or v_model.asset_id <> v_asset.id
     or v_model.timeframe::text <> p_decision->>'timeframe' then
    raise exception using errcode = '23514', message = 'champion model does not match decision scope';
  end if;
  select * into v_policy from signal_atlas.policy_versions
  where mode = v_mode and effective_from <= v_emitted
  order by effective_from desc, version desc limit 1;
  if not found then raise exception using errcode = '23503', message = 'active policy version not found'; end if;

  for v_prediction in
    select value from pg_catalog.jsonb_array_elements(coalesce(p_decision->'predictions', '[]'::jsonb))
  loop
    if v_prediction->>'model_id' = v_model_id::text and v_prediction->>'role' = 'champion' then
      v_probability := case when v_direction = 'buy'
        then (v_prediction->>'probability_up')::numeric
        else 1 - (v_prediction->>'probability_up')::numeric end;
    end if;
  end loop;
  if v_probability is null then
    raise exception using errcode = '23514', message = 'champion prediction is missing';
  end if;
  v_sample := coalesce((v_model.validation_metrics->>'sample_size')::integer, 0);
  v_probability_lb := greatest(0, v_probability - 1.5 * pg_catalog.sqrt(
    greatest(0, v_probability * (1 - v_probability)) / greatest(v_sample, 1)
  ));
  v_payout := coalesce((v_policy.config->>'payout_ratio')::numeric, 0.85);
  v_cost := coalesce((v_policy.config->>'operation_cost')::numeric, 0.02);
  v_ev := v_probability * v_payout - (1 - v_probability) - v_cost;

  for v_prediction in
    select value from pg_catalog.jsonb_array_elements(coalesce(p_decision->'predictions', '[]'::jsonb))
  loop
    if v_prediction->>'role' <> 'shadow' then continue; end if;
    select * into v_shadow_model from signal_atlas.model_artifacts
    where id = (v_prediction->>'model_id')::uuid;
    if not found then continue; end if;
    v_probability := case when v_direction = 'buy'
      then (v_prediction->>'probability_up')::numeric
      else 1 - (v_prediction->>'probability_up')::numeric end;
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

  -- Restore champion values after iterating over shadows.
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
    when p_decision->>'status' <> 'signal' then 'low'
    when p_decision->>'grade' in ('A+', 'A') then 'confirmed'
    else 'technical'
  end;
  v_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.concat_ws('|', v_asset.symbol, p_decision->>'timeframe', v_observed::text,
      coalesce((p_decision->'feature_vector')::text, '[]'), p_decision->>'policy_signature'),
    'sha256'), 'hex');
  v_payload := pg_catalog.jsonb_build_object(
    'idempotency_key', v_key || '|' || v_mode::text,
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
    'feature_cutoff_at', v_emitted - interval '1 millisecond',
    'entry_at', v_entry,
    'expiry_at', v_expiry,
    'source_candle_open_time', v_observed,
    'source_received_at', v_emitted - interval '1 millisecond',
    'data_age_ms', greatest(0, (extract(epoch from (v_emitted - v_observed)) * 1000)::integer),
    'source_latency_ms', 0,
    'used_live_candle', coalesce((p_decision->>'used_live_candle')::boolean, false),
    'candle_set_hash', v_hash,
    'feature_snapshot', pg_catalog.jsonb_build_object(
      'schema', p_decision->>'feature_schema_version',
      'vector', coalesce(p_decision->'feature_vector', '[]'::jsonb),
      'grade', p_decision->>'grade', 'status', p_decision->>'status'
    ),
    'data_lineage', pg_catalog.jsonb_build_object(
      'run_id', p_decision->>'run_id', 'source', p_decision->>'source',
      'provider_symbol', p_decision->>'provider_symbol',
      'observed_candle_open', v_observed
    ),
    'reasons', v_reasons || v_blockers,
    'shadow_predictions', v_shadows
  );
  v_id := signal_atlas.register_decision(v_payload);
  return pg_catalog.jsonb_build_object(
    'ok', true, 'kind', case when v_quality = 'low' then 'low-signal' else 'signal' end,
    'id', v_id, 'quality', v_quality, 'probability', v_probability,
    'probabilityLb', v_probability_lb, 'evNet', v_ev
  );
end
$$;

create or replace function public.resolve_due_outcomes(
  p_as_of timestamptz,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if p_as_of > pg_catalog.clock_timestamp() + interval '5 seconds' then
    raise exception using errcode = '23514', message = 'resolution clock cannot be in the future';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
  into v_rows from signal_atlas.resolve_ready_decisions(250) x;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'runId', p_run_id, 'resolved', pg_catalog.jsonb_array_length(v_rows), 'rows', v_rows
  );
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
  v_start timestamptz;
  v_review record;
  v_reviews jsonb := '[]'::jsonb;
begin
  if p_min_resolved < 300 then
    raise exception using errcode = '23514', message = 'prospective promotion requires at least 300 paired outcomes';
  end if;
  if p_as_of > pg_catalog.clock_timestamp() + interval '5 seconds' then
    raise exception using errcode = '23514', message = 'review clock cannot be in the future';
  end if;
  for v_candidate in
    select m.*, a.symbol
    from signal_atlas.model_artifacts m
    join signal_atlas.assets a on a.id = m.asset_id
    where coalesce((m.validation_metrics->>'usable')::boolean, false)
      and (p_symbol is null or a.symbol = pg_catalog.upper(pg_catalog.btrim(p_symbol)))
      and (p_timeframe is null or m.timeframe::text = p_timeframe)
    order by m.created_at
  loop
    v_champion_id := signal_atlas.current_champion_model(v_candidate.asset_id, v_candidate.timeframe, p_as_of);
    if v_champion_id is null or v_champion_id = v_candidate.id then continue; end if;
    select pg_catalog.count(*)::integer, pg_catalog.min(d.entry_at)
    into v_n, v_start
    from signal_atlas.shadow_predictions s
    join signal_atlas.decision_events d on d.id = s.decision_event_id
    join signal_atlas.outcomes o on o.decision_event_id = d.id
    where s.model_artifact_id = v_candidate.id
      and d.model_artifact_id = v_champion_id
      and d.entry_at < p_as_of;
    if v_n < p_min_resolved or v_start is null then continue; end if;
    select * into v_review from signal_atlas.review_challenger(
      v_candidate.asset_id, v_candidate.timeframe, v_candidate.id,
      v_start, p_as_of, true,
      'auto-promote|' || v_candidate.symbol || '|' || v_candidate.timeframe::text || '|' || v_candidate.id::text,
      1.20, 0
    );
    v_reviews := v_reviews || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_review));
  end loop;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'minimumPaired', p_min_resolved,
    'zRequested', p_z_margin, 'criterion', '95% lower bound of paired delta EV > 0; Brier not worse; drawdown <= 1.20x',
    'reviews', v_reviews
  );
end
$$;

create or replace function public.record_scanner_run(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := signal_atlas.record_scanner_run(p_payload);
  return pg_catalog.jsonb_build_object('ok', true, 'runId', v_id);
end
$$;

-- Browser-facing read models.  They intentionally omit model weights, private
-- ledger payloads and service metadata.
create or replace view public.cloud_latest_decisions
with (security_invoker = true)
as
select
  d.id,
  a.symbol,
  a.market::text as market,
  d.timeframe::text as timeframe,
  d.mode::text as mode,
  d.direction::text as direction,
  d.expiration::text as expiration,
  d.quality::text as quality,
  d.score,
  d.probability,
  d.statistical_sample_size as sample_size,
  d.expected_ev as ev_net,
  d.decision_at,
  d.entry_at,
  d.expiry_at,
  d.data_age_ms,
  d.source_latency_ms,
  d.used_live_candle,
  coalesce(d.reasons->>0, 'Registro prospectivo congelado antes da entrada.') as reason,
  o.decision_result as outcome,
  o.resolved_at
from signal_atlas.decision_events d
join signal_atlas.assets a on a.id = d.asset_id
left join signal_atlas.outcomes o on o.decision_event_id = d.id
where d.model_role = 'champion'
  and not exists (
    select 1 from signal_atlas.correction_events c
    where c.target_type = 'decision' and c.target_id = d.id and c.correction_type = 'invalidate'
  );

create or replace view public.cloud_opportunities
with (security_invoker = true)
as
select
  o.id, o.symbol, o.market, o.timeframe::text as timeframe, o.mode::text as mode,
  o.direction::text as direction, o.expiration::text as expiration,
  o.quality::text as quality, o.score, o.probability,
  d.statistical_sample_size as sample_size,
  o.expected_ev as ev_net, d.decision_at, o.entry_at, o.expiry_at,
  o.data_age_ms, o.source_latency_ms, o.used_live_candle,
  coalesce(o.reasons->>0, 'Oportunidade prospectiva aguardando entrada.') as reason,
  o.opportunity_rank as rank
from public.signal_atlas_opportunities o
join signal_atlas.decision_events d on d.id = o.id;

create or replace view public.cloud_segment_metrics
with (security_invoker = true)
as
select
  symbol, timeframe::text as timeframe, direction::text as direction,
  expiration::text as expiration, mode::text as mode,
  resolved, wins, losses, ties, win_rate, brier_score,
  ev_net_per_trade, ev_net_lb95, total_pnl,
  first_entry_at, last_expiry_at
from public.signal_atlas_metrics;

create or replace view public.cloud_paper_summary
with (security_invoker = true)
as
with events as (
  select e.event_at, e.paper_trade_id, e.pnl,
    pg_catalog.sum(e.pnl) over (order by e.event_at, e.paper_trade_id rows unbounded preceding) as equity
  from signal_atlas.paper_trade_events e
  where e.event_type = 'resolved'
), curve as (
  select *, greatest(0, pg_catalog.max(equity) over (
    order by event_at, paper_trade_id rows unbounded preceding
  )) - equity as drawdown
  from events
)
select
  pg_catalog.count(*)::bigint as trades,
  pg_catalog.avg(pnl) as ev_net_per_trade,
  coalesce(pg_catalog.sum(pnl), 0) as total_pnl,
  coalesce(pg_catalog.max(drawdown), 0) as max_drawdown,
  pg_catalog.max(event_at) as updated_at
from curve;

create or replace view public.cloud_system_health
with (security_invoker = true)
as
with latest_run as (
  select * from signal_atlas.scanner_runs order by finished_at desc, id desc limit 1
), counts as (
  select pg_catalog.count(*)::bigint as resolved from signal_atlas.outcomes
), data_age as (
  select pg_catalog.max(received_at) as last_collection_at from signal_atlas.candles
)
select
  coalesce(r.details->>'last_symbol', '—') as processed_asset,
  coalesce(r.details->>'last_timeframe', '') as timeframe,
  coalesce(d.last_collection_at, r.finished_at) as last_collection_at,
  c.resolved as resolved_prospective_signals,
  coalesce(r.status::text, 'initializing') as status,
  r.finished_at as updated_at
from counts c
cross join data_age d
left join latest_run r on true;

revoke all on public.assets_watchlist, public.candles, public.model_artifacts
from public, anon, authenticated, service_role;
grant select on public.assets_watchlist, public.candles, public.model_artifacts to service_role;

revoke all on public.cloud_latest_decisions, public.cloud_opportunities,
  public.cloud_segment_metrics, public.cloud_paper_summary, public.cloud_system_health
from public, anon, authenticated, service_role;
grant select on public.cloud_latest_decisions, public.cloud_opportunities,
  public.cloud_segment_metrics, public.cloud_paper_summary, public.cloud_system_health
to anon, authenticated, service_role;

revoke execute on function public.ingest_candles(text,text,text,jsonb,jsonb,uuid,timestamptz),
  public.create_model_artifact(jsonb), public.register_market_decision(jsonb),
  public.resolve_due_outcomes(timestamptz,uuid),
  public.review_and_promote_challengers(timestamptz,integer,numeric,text,text),
  public.record_scanner_run(jsonb)
from public, anon, authenticated;
grant execute on function public.ingest_candles(text,text,text,jsonb,jsonb,uuid,timestamptz),
  public.create_model_artifact(jsonb), public.register_market_decision(jsonb),
  public.resolve_due_outcomes(timestamptz,uuid),
  public.review_and_promote_challengers(timestamptz,integer,numeric,text,text),
  public.record_scanner_run(jsonb)
to service_role;

comment on view public.cloud_latest_decisions is 'Public read-only prospective decisions; never used to train the browser-local model.';
comment on view public.cloud_segment_metrics is 'Prospective statistics only, segmented by asset/timeframe/direction/expiration/mode.';

commit;
