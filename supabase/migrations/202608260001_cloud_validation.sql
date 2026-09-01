-- Signal Atlas Cloud validation core for Supabase / PostgreSQL 17.
-- Internal state lives in signal_atlas. Only narrow read views and service-role
-- RPCs are exposed in public. All market decisions are prospective and append-only.

begin;

create schema if not exists signal_atlas;

do $$ begin
  create type signal_atlas.market_code as enum ('crypto', 'forex');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.timeframe_code as enum ('M5', 'M15', 'H1');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.mode_code as enum ('conservador', 'neutro', 'agressivo');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.direction_code as enum ('buy', 'sell');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.expiration_code as enum ('E1', 'E2', 'E3');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.model_role_code as enum ('champion', 'challenger');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.deployment_action_code as enum ('bootstrap_champion', 'promote_champion', 'rollback_champion', 'retire_champion');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.tie_policy_code as enum ('loss', 'refund', 'win');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.signal_quality_code as enum ('confirmed', 'technical', 'low');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.paper_event_code as enum ('scheduled', 'resolved', 'cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.scanner_status_code as enum ('ok', 'partial', 'failed');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.health_status_code as enum ('healthy', 'degraded', 'down');
exception when duplicate_object then null; end $$;
do $$ begin
  create type signal_atlas.correction_target_code as enum ('candle', 'decision', 'shadow_prediction', 'outcome', 'paper_trade', 'model_artifact', 'policy_version', 'deployment_event');
exception when duplicate_object then null; end $$;

create table if not exists signal_atlas.assets (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  symbol text not null unique,
  market signal_atlas.market_code not null,
  source text not null,
  provider_symbol text not null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (symbol = pg_catalog.upper(symbol)),
  check (pg_catalog.length(pg_catalog.btrim(source)) > 0),
  check (pg_catalog.length(pg_catalog.btrim(provider_symbol)) > 0),
  check (pg_catalog.jsonb_typeof(metadata) = 'object')
);

create table if not exists signal_atlas.candles (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  asset_id uuid not null references signal_atlas.assets(id),
  timeframe signal_atlas.timeframe_code not null,
  open_time timestamptz not null,
  close_time timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric not null default 0,
  source text not null,
  is_closed boolean not null,
  source_observed_at timestamptz not null,
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  source_latency_ms integer not null default 0,
  raw_hash text not null,
  unique (asset_id, timeframe, open_time),
  check (open > 0 and high > 0 and low > 0 and close > 0),
  check (high >= greatest(open, close, low)),
  check (low <= least(open, close, high)),
  check (volume >= 0),
  check (close_time > open_time),
  check (source_latency_ms >= 0),
  check (pg_catalog.length(raw_hash) >= 32),
  check (not is_closed or received_at >= close_time)
);

create table if not exists signal_atlas.policy_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  policy_key text not null,
  mode signal_atlas.mode_code not null,
  version integer not null,
  config jsonb not null,
  config_hash text not null,
  effective_from timestamptz not null default pg_catalog.clock_timestamp(),
  notes text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (policy_key, mode, version),
  unique (config_hash),
  check (version > 0),
  check (pg_catalog.jsonb_typeof(config) = 'object'),
  check (pg_catalog.length(config_hash) >= 32)
);

create table if not exists signal_atlas.model_artifacts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  asset_id uuid not null references signal_atlas.assets(id),
  timeframe signal_atlas.timeframe_code not null,
  artifact_uri text not null,
  artifact_sha256 text not null,
  feature_schema_hash text not null,
  training_config jsonb not null,
  validation_metrics jsonb not null,
  train_start_at timestamptz not null,
  train_end_at timestamptz not null,
  training_cutoff_at timestamptz not null,
  holdout_start_at timestamptz not null,
  holdout_end_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (asset_id, timeframe, artifact_sha256),
  check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  check (pg_catalog.length(feature_schema_hash) >= 32),
  check (pg_catalog.jsonb_typeof(training_config) = 'object'),
  check (pg_catalog.jsonb_typeof(validation_metrics) = 'object'),
  check (train_start_at < train_end_at),
  check (train_end_at <= training_cutoff_at),
  check (training_cutoff_at <= holdout_start_at),
  check (holdout_start_at < holdout_end_at),
  check (holdout_end_at <= created_at)
);

create table if not exists signal_atlas.promotion_reviews (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  asset_id uuid not null references signal_atlas.assets(id),
  timeframe signal_atlas.timeframe_code not null,
  champion_model_artifact_id uuid not null references signal_atlas.model_artifacts(id),
  challenger_model_artifact_id uuid not null references signal_atlas.model_artifacts(id),
  window_start_at timestamptz not null,
  window_end_at timestamptz not null,
  paired_samples integer not null,
  champion_ev numeric,
  challenger_ev numeric,
  delta_ev numeric,
  delta_ev_lb95 numeric,
  delta_ev_ub95 numeric,
  champion_brier numeric,
  challenger_brier numeric,
  champion_max_drawdown numeric,
  challenger_max_drawdown numeric,
  drawdown_limit_ratio numeric not null,
  brier_tolerance numeric not null default 0,
  passed boolean not null,
  criteria jsonb not null,
  reviewed_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (asset_id, timeframe, champion_model_artifact_id, challenger_model_artifact_id, window_end_at),
  check (window_start_at < window_end_at),
  check (paired_samples >= 0),
  check (drawdown_limit_ratio >= 1),
  check (brier_tolerance >= 0),
  check (champion_model_artifact_id <> challenger_model_artifact_id),
  check (pg_catalog.jsonb_typeof(criteria) = 'object')
);

create table if not exists signal_atlas.model_deployment_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  idempotency_key text not null unique,
  asset_id uuid not null references signal_atlas.assets(id),
  timeframe signal_atlas.timeframe_code not null,
  action signal_atlas.deployment_action_code not null,
  model_artifact_id uuid references signal_atlas.model_artifacts(id),
  previous_model_artifact_id uuid references signal_atlas.model_artifacts(id),
  promotion_review_id uuid references signal_atlas.promotion_reviews(id),
  effective_at timestamptz not null,
  reason text not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  -- `created_at` is evaluated by PostgreSQL a few microseconds after the
  -- application freezes `effective_at`.  Allow only that harmless clock
  -- skew; genuinely backdated deployment events remain invalid.
  check (effective_at >= created_at - interval '1 second'),
  check (
    (action = 'retire_champion' and model_artifact_id is null)
    or (action <> 'retire_champion' and model_artifact_id is not null)
  ),
  check ((action = 'promote_champion' and promotion_review_id is not null) or action <> 'promote_champion')
);

create unique index if not exists model_deployment_one_event_per_review
  on signal_atlas.model_deployment_events(promotion_review_id)
  where promotion_review_id is not null;

create table if not exists signal_atlas.decision_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  idempotency_key text not null unique,
  asset_id uuid not null references signal_atlas.assets(id),
  timeframe signal_atlas.timeframe_code not null,
  mode signal_atlas.mode_code not null,
  model_role signal_atlas.model_role_code not null default 'champion',
  model_artifact_id uuid not null references signal_atlas.model_artifacts(id),
  policy_version_id uuid not null references signal_atlas.policy_versions(id),
  direction signal_atlas.direction_code not null,
  expiration signal_atlas.expiration_code not null,
  quality signal_atlas.signal_quality_code not null,
  score numeric not null,
  probability numeric not null,
  probability_lb numeric,
  expected_ev numeric,
  confluence_count integer not null,
  statistical_sample_size integer not null,
  reference_price numeric not null,
  stake numeric not null,
  payout_ratio numeric not null,
  operation_cost numeric not null,
  tie_policy signal_atlas.tie_policy_code not null,
  tie_probability numeric not null default 0,
  decision_at timestamptz not null,
  feature_cutoff_at timestamptz not null,
  entry_at timestamptz not null,
  expiry_at timestamptz not null,
  source_candle_open_time timestamptz not null,
  source_received_at timestamptz not null,
  data_age_ms integer not null,
  source_latency_ms integer not null,
  used_live_candle boolean not null,
  candle_set_hash text not null,
  model_hash_snapshot text not null,
  policy_hash_snapshot text not null,
  config_snapshot jsonb not null,
  feature_snapshot jsonb not null,
  data_lineage jsonb not null,
  reasons jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint decision_events_unique_entry_role unique (asset_id, timeframe, mode, entry_at, model_role),
  check (score between 0 and 100),
  check (probability between 0 and 1),
  check (probability_lb is null or probability_lb between 0 and 1),
  check (confluence_count >= 0),
  check (statistical_sample_size >= 0),
  check (reference_price > 0 and stake > 0),
  check (payout_ratio between 0 and 1),
  check (operation_cost >= 0),
  check (tie_probability between 0 and 1),
  check (feature_cutoff_at <= decision_at),
  check (source_received_at <= decision_at),
  check (source_candle_open_time < entry_at),
  check (decision_at < entry_at and entry_at < expiry_at),
  check (data_age_ms >= 0 and source_latency_ms >= 0),
  check (pg_catalog.length(candle_set_hash) >= 32),
  check (pg_catalog.length(model_hash_snapshot) >= 32),
  check (pg_catalog.length(policy_hash_snapshot) >= 32),
  check (pg_catalog.jsonb_typeof(config_snapshot) = 'object'),
  check (pg_catalog.jsonb_typeof(feature_snapshot) = 'object'),
  check (pg_catalog.jsonb_typeof(data_lineage) = 'object'),
  check (pg_catalog.jsonb_typeof(reasons) = 'array')
);

create table if not exists signal_atlas.shadow_predictions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  decision_event_id uuid not null references signal_atlas.decision_events(id),
  model_artifact_id uuid not null references signal_atlas.model_artifacts(id),
  policy_version_id uuid not null references signal_atlas.policy_versions(id),
  direction signal_atlas.direction_code not null,
  score numeric not null,
  probability numeric not null,
  probability_lb numeric,
  expected_ev numeric,
  statistical_sample_size integer not null,
  predicted_at timestamptz not null,
  feature_cutoff_at timestamptz not null,
  candle_set_hash text not null,
  model_hash_snapshot text not null,
  policy_hash_snapshot text not null,
  config_snapshot jsonb not null,
  reasons jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (decision_event_id, model_artifact_id),
  check (score between 0 and 100),
  check (probability between 0 and 1),
  check (probability_lb is null or probability_lb between 0 and 1),
  check (statistical_sample_size >= 0),
  check (feature_cutoff_at <= predicted_at),
  check (pg_catalog.length(candle_set_hash) >= 32),
  check (pg_catalog.length(model_hash_snapshot) >= 32),
  check (pg_catalog.length(policy_hash_snapshot) >= 32),
  check (pg_catalog.jsonb_typeof(config_snapshot) = 'object'),
  check (pg_catalog.jsonb_typeof(reasons) = 'array')
);

create table if not exists signal_atlas.outcomes (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  decision_event_id uuid not null unique references signal_atlas.decision_events(id),
  entry_candle_id uuid not null references signal_atlas.candles(id),
  expiry_candle_id uuid not null references signal_atlas.candles(id),
  entry_at timestamptz not null,
  expiry_at timestamptz not null,
  entry_price numeric not null,
  close_price numeric not null,
  market_move text not null check (market_move in ('up', 'down', 'tie')),
  decision_result text not null check (decision_result in ('win', 'loss', 'tie')),
  resolved_at timestamptz not null,
  resolution_hash text not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (entry_at < expiry_at),
  check (entry_price > 0 and close_price > 0),
  check (resolved_at >= expiry_at),
  check (pg_catalog.length(resolution_hash) >= 32)
);

create table if not exists signal_atlas.paper_trades (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  decision_event_id uuid not null unique references signal_atlas.decision_events(id),
  scheduled_entry_at timestamptz not null,
  scheduled_expiry_at timestamptz not null,
  stake numeric not null,
  payout_ratio numeric not null,
  operation_cost numeric not null,
  tie_policy signal_atlas.tie_policy_code not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (scheduled_entry_at < scheduled_expiry_at),
  check (stake > 0),
  check (payout_ratio between 0 and 1),
  check (operation_cost >= 0)
);

create table if not exists signal_atlas.paper_trade_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  paper_trade_id uuid not null references signal_atlas.paper_trades(id),
  event_type signal_atlas.paper_event_code not null,
  event_at timestamptz not null,
  outcome_id uuid references signal_atlas.outcomes(id),
  entry_price numeric,
  close_price numeric,
  result text check (result is null or result in ('win', 'loss', 'tie')),
  pnl numeric,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (paper_trade_id, event_type),
  check (pg_catalog.jsonb_typeof(details) = 'object'),
  check ((event_type = 'resolved' and outcome_id is not null and pnl is not null) or event_type <> 'resolved')
);

create table if not exists signal_atlas.correction_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  idempotency_key text not null unique,
  target_type signal_atlas.correction_target_code not null,
  target_id uuid not null,
  correction_type text not null check (correction_type in ('invalidate', 'annotate', 'supersede')),
  reason text not null,
  replacement_payload jsonb,
  actor_id uuid,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (pg_catalog.length(pg_catalog.btrim(reason)) >= 8),
  check (replacement_payload is null or pg_catalog.jsonb_typeof(replacement_payload) = 'object')
);

create table if not exists signal_atlas.scanner_runs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  idempotency_key text not null unique,
  worker_id text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status signal_atlas.scanner_status_code not null,
  assets_requested integer not null,
  decisions_created integer not null,
  shadows_created integer not null,
  waits integer not null,
  errors integer not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (started_at <= finished_at),
  check (assets_requested >= 0 and decisions_created >= 0 and shadows_created >= 0 and waits >= 0 and errors >= 0),
  check (pg_catalog.jsonb_typeof(details) = 'object')
);

create table if not exists signal_atlas.scanner_health_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  scanner_run_id uuid references signal_atlas.scanner_runs(id),
  component text not null,
  status signal_atlas.health_status_code not null,
  observed_at timestamptz not null,
  latency_ms integer,
  last_data_at timestamptz,
  message text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (latency_ms is null or latency_ms >= 0),
  check (pg_catalog.length(pg_catalog.btrim(component)) > 0),
  check (pg_catalog.jsonb_typeof(details) = 'object')
);

create index if not exists candles_exact_resolution_idx on signal_atlas.candles(asset_id, timeframe, open_time) where is_closed;
create index if not exists candles_received_idx on signal_atlas.candles(asset_id, timeframe, received_at desc);
create index if not exists deployment_latest_idx on signal_atlas.model_deployment_events(asset_id, timeframe, effective_at desc, created_at desc);
create index if not exists decision_latest_idx on signal_atlas.decision_events(asset_id, timeframe, mode, model_role, decision_at desc);
create index if not exists decision_entry_idx on signal_atlas.decision_events(entry_at, expiry_at);
create index if not exists shadow_model_pairs_idx on signal_atlas.shadow_predictions(model_artifact_id, decision_event_id);
create index if not exists outcome_resolved_idx on signal_atlas.outcomes(resolved_at desc);
create index if not exists paper_event_curve_idx on signal_atlas.paper_trade_events(event_type, event_at, paper_trade_id);
create index if not exists correction_target_idx on signal_atlas.correction_events(target_type, target_id, created_at desc);
create index if not exists promotion_candidate_idx on signal_atlas.promotion_reviews(asset_id, timeframe, challenger_model_artifact_id, reviewed_at desc);
create index if not exists scanner_runs_finished_idx on signal_atlas.scanner_runs(finished_at desc);
create index if not exists scanner_health_latest_idx on signal_atlas.scanner_health_events(component, observed_at desc);

create or replace function signal_atlas.timeframe_seconds(p_timeframe signal_atlas.timeframe_code)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select case p_timeframe
    when 'M5'::signal_atlas.timeframe_code then 300
    when 'M15'::signal_atlas.timeframe_code then 900
    when 'H1'::signal_atlas.timeframe_code then 3600
  end
$$;

create or replace function signal_atlas.expiration_candles(p_expiration signal_atlas.expiration_code)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select case p_expiration
    when 'E1'::signal_atlas.expiration_code then 1
    when 'E2'::signal_atlas.expiration_code then 2
    when 'E3'::signal_atlas.expiration_code then 3
  end
$$;

create or replace function signal_atlas.trade_result(
  p_direction signal_atlas.direction_code,
  p_entry_price numeric,
  p_close_price numeric
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when p_close_price = p_entry_price then 'tie'
    when p_direction = 'buy'::signal_atlas.direction_code and p_close_price > p_entry_price then 'win'
    when p_direction = 'sell'::signal_atlas.direction_code and p_close_price < p_entry_price then 'win'
    else 'loss'
  end
$$;

create or replace function signal_atlas.trade_pnl(
  p_direction signal_atlas.direction_code,
  p_entry_price numeric,
  p_close_price numeric,
  p_stake numeric,
  p_payout_ratio numeric,
  p_operation_cost numeric,
  p_tie_policy signal_atlas.tie_policy_code
)
returns numeric
language sql
immutable
strict
set search_path = ''
as $$
  select case signal_atlas.trade_result(p_direction, p_entry_price, p_close_price)
    when 'win' then p_stake * p_payout_ratio - p_operation_cost
    when 'loss' then -p_stake - p_operation_cost
    else case p_tie_policy
      when 'win'::signal_atlas.tie_policy_code then p_stake * p_payout_ratio - p_operation_cost
      when 'refund'::signal_atlas.tie_policy_code then -p_operation_cost
      else -p_stake - p_operation_cost
    end
  end
$$;

create or replace function signal_atlas.reject_update_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = pg_catalog.format('%I.%I is append-only; write a correction event instead', tg_table_schema, tg_table_name);
end
$$;

create or replace function signal_atlas.protect_candle_history()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'candles cannot be deleted; write a correction event';
  end if;
  if old.is_closed then
    raise exception using errcode = '55000', message = 'a closed candle is immutable';
  end if;
  if new.asset_id <> old.asset_id or new.timeframe <> old.timeframe or new.open_time <> old.open_time or new.close_time <> old.close_time then
    raise exception using errcode = '23514', message = 'candle identity cannot change';
  end if;
  if old.is_closed and not new.is_closed then
    raise exception using errcode = '23514', message = 'a closed candle cannot be reopened';
  end if;
  return new;
end
$$;

create or replace function signal_atlas.current_champion_model(
  p_asset_id uuid,
  p_timeframe signal_atlas.timeframe_code,
  p_as_of timestamptz default pg_catalog.clock_timestamp()
)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when e.action = 'retire_champion'::signal_atlas.deployment_action_code then null::uuid
    else e.model_artifact_id
  end
  from signal_atlas.model_deployment_events e
  where e.asset_id = p_asset_id
    and e.timeframe = p_timeframe
    and e.effective_at <= p_as_of
  order by e.effective_at desc, e.created_at desc, e.id desc
  limit 1
$$;

create or replace function signal_atlas.validate_deployment_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_model signal_atlas.model_artifacts%rowtype;
  v_current uuid;
begin
  v_current := signal_atlas.current_champion_model(new.asset_id, new.timeframe, new.effective_at);
  if new.model_artifact_id is not null then
    select * into v_model from signal_atlas.model_artifacts where id = new.model_artifact_id;
    if not found or v_model.asset_id <> new.asset_id or v_model.timeframe <> new.timeframe then
      raise exception using errcode = '23514', message = 'deployment model does not match asset/timeframe';
    end if;
  end if;
  if new.effective_at < new.created_at - interval '1 second' then
    raise exception using errcode = '23514', message = 'deployment events cannot be backdated';
  end if;
  if new.action = 'bootstrap_champion' and v_current is not null then
    raise exception using errcode = '23514', message = 'bootstrap is allowed only without an active champion';
  end if;
  if new.action in ('promote_champion', 'rollback_champion', 'retire_champion') and v_current is distinct from new.previous_model_artifact_id then
    raise exception using errcode = '40001', message = 'previous champion snapshot is stale';
  end if;
  if new.action = 'promote_champion' then
    if not exists (
      select 1 from signal_atlas.promotion_reviews r
      where r.id = new.promotion_review_id
        and r.asset_id = new.asset_id
        and r.timeframe = new.timeframe
        and r.champion_model_artifact_id = new.previous_model_artifact_id
        and r.challenger_model_artifact_id = new.model_artifact_id
        and r.passed
    ) then
      raise exception using errcode = '23514', message = 'promotion requires a passing paired review';
    end if;
  end if;
  return new;
end
$$;

create or replace function signal_atlas.validate_decision_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_seconds integer;
  v_expiry timestamptz;
  v_model signal_atlas.model_artifacts%rowtype;
  v_policy signal_atlas.policy_versions%rowtype;
  v_champion uuid;
begin
  v_seconds := signal_atlas.timeframe_seconds(new.timeframe);
  v_expiry := new.entry_at + pg_catalog.make_interval(secs => v_seconds * signal_atlas.expiration_candles(new.expiration));
  if new.expiry_at <> v_expiry then
    raise exception using errcode = '23514', message = 'expiry_at must be exactly entry_at plus E1/E2/E3 timeframe candles';
  end if;
  if new.decision_at > pg_catalog.clock_timestamp() then
    raise exception using errcode = '23514', message = 'decision_at cannot be in the future';
  end if;
  if pg_catalog.mod(pg_catalog.floor(extract(epoch from new.entry_at))::bigint, v_seconds) <> 0 then
    raise exception using errcode = '23514', message = 'entry_at is not aligned to the timeframe boundary';
  end if;
  select * into v_model from signal_atlas.model_artifacts where id = new.model_artifact_id;
  if not found or v_model.asset_id <> new.asset_id or v_model.timeframe <> new.timeframe then
    raise exception using errcode = '23514', message = 'decision model does not match asset/timeframe';
  end if;
  if v_model.artifact_sha256 <> new.model_hash_snapshot
     or v_model.training_cutoff_at > new.feature_cutoff_at
     or v_model.created_at > new.decision_at then
    raise exception using errcode = '23514', message = 'model hash/cutoff is not causal for this decision';
  end if;
  select * into v_policy from signal_atlas.policy_versions where id = new.policy_version_id;
  if not found or v_policy.mode <> new.mode or v_policy.config_hash <> new.policy_hash_snapshot
     or v_policy.created_at > new.decision_at or v_policy.effective_from > new.decision_at then
    raise exception using errcode = '23514', message = 'policy snapshot does not match the immutable policy version';
  end if;
  if new.model_role = 'champion' then
    v_champion := signal_atlas.current_champion_model(new.asset_id, new.timeframe, new.decision_at);
    if v_champion is distinct from new.model_artifact_id then
      raise exception using errcode = '23514', message = 'decision model is not the champion at decision_at';
    end if;
  end if;
  return new;
end
$$;

create or replace function signal_atlas.validate_shadow_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_decision signal_atlas.decision_events%rowtype;
  v_model signal_atlas.model_artifacts%rowtype;
begin
  select * into v_decision from signal_atlas.decision_events where id = new.decision_event_id;
  select * into v_model from signal_atlas.model_artifacts where id = new.model_artifact_id;
  if not found then
    raise exception using errcode = '23503', message = 'challenger model artifact does not exist';
  end if;
  if v_model.asset_id <> v_decision.asset_id or v_model.timeframe <> v_decision.timeframe then
    raise exception using errcode = '23514', message = 'challenger model does not match the paired decision segment';
  end if;
  if new.model_artifact_id = v_decision.model_artifact_id then
    raise exception using errcode = '23514', message = 'shadow prediction must use a different model';
  end if;
  if new.policy_version_id <> v_decision.policy_version_id
     or new.feature_cutoff_at <> v_decision.feature_cutoff_at
     or new.candle_set_hash <> v_decision.candle_set_hash then
    raise exception using errcode = '23514', message = 'shadow and champion must be evaluated on the same policy and feature snapshot';
  end if;
  if new.predicted_at >= v_decision.entry_at
     or v_model.training_cutoff_at > new.feature_cutoff_at
     or v_model.created_at > new.predicted_at then
    raise exception using errcode = '23514', message = 'shadow prediction is not prospective';
  end if;
  if new.model_hash_snapshot <> v_model.artifact_sha256 then
    raise exception using errcode = '23514', message = 'challenger hash snapshot mismatch';
  end if;
  return new;
end
$$;

create or replace function signal_atlas.validate_outcome_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_decision signal_atlas.decision_events%rowtype;
  v_entry signal_atlas.candles%rowtype;
  v_exit signal_atlas.candles%rowtype;
  v_seconds integer;
begin
  select * into v_decision from signal_atlas.decision_events where id = new.decision_event_id;
  select * into v_entry from signal_atlas.candles where id = new.entry_candle_id;
  select * into v_exit from signal_atlas.candles where id = new.expiry_candle_id;
  v_seconds := signal_atlas.timeframe_seconds(v_decision.timeframe);
  if not v_entry.is_closed or v_entry.asset_id <> v_decision.asset_id or v_entry.timeframe <> v_decision.timeframe
     or v_entry.open_time <> v_decision.entry_at or v_entry.close_time <> v_decision.entry_at + pg_catalog.make_interval(secs => v_seconds) then
    raise exception using errcode = '23514', message = 'entry candle is not the exact closed candle requested by entry_at';
  end if;
  if not v_exit.is_closed or v_exit.asset_id <> v_decision.asset_id or v_exit.timeframe <> v_decision.timeframe
     or v_exit.close_time <> v_decision.expiry_at
     or v_exit.open_time <> v_decision.expiry_at - pg_catalog.make_interval(secs => v_seconds) then
    raise exception using errcode = '23514', message = 'expiry candle is not the exact closed candle requested by expiry_at';
  end if;
  if new.entry_at <> v_decision.entry_at or new.expiry_at <> v_decision.expiry_at
     or new.entry_price <> v_entry.open or new.close_price <> v_exit.close then
    raise exception using errcode = '23514', message = 'outcome prices/timestamps do not match immutable candles';
  end if;
  if new.decision_result <> signal_atlas.trade_result(v_decision.direction, v_entry.open, v_exit.close) then
    raise exception using errcode = '23514', message = 'decision_result does not match exact market prices';
  end if;
  return new;
end
$$;

drop trigger if exists candles_history_guard on signal_atlas.candles;
create trigger candles_history_guard before update or delete on signal_atlas.candles
for each row execute function signal_atlas.protect_candle_history();

drop trigger if exists deployment_insert_guard on signal_atlas.model_deployment_events;
create trigger deployment_insert_guard before insert on signal_atlas.model_deployment_events
for each row execute function signal_atlas.validate_deployment_insert();

drop trigger if exists decision_insert_guard on signal_atlas.decision_events;
create trigger decision_insert_guard before insert on signal_atlas.decision_events
for each row execute function signal_atlas.validate_decision_insert();

drop trigger if exists shadow_insert_guard on signal_atlas.shadow_predictions;
create trigger shadow_insert_guard before insert on signal_atlas.shadow_predictions
for each row execute function signal_atlas.validate_shadow_insert();

drop trigger if exists outcome_insert_guard on signal_atlas.outcomes;
create trigger outcome_insert_guard before insert on signal_atlas.outcomes
for each row execute function signal_atlas.validate_outcome_insert();

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'policy_versions', 'model_artifacts', 'promotion_reviews', 'model_deployment_events',
    'decision_events', 'shadow_predictions', 'outcomes', 'paper_trades',
    'paper_trade_events', 'correction_events', 'scanner_runs', 'scanner_health_events'
  ] loop
    execute pg_catalog.format('drop trigger if exists append_only_guard on signal_atlas.%I', v_table);
    execute pg_catalog.format(
      'create trigger append_only_guard before update or delete on signal_atlas.%I for each row execute function signal_atlas.reject_update_delete()',
      v_table
    );
  end loop;
end
$$;

create or replace function signal_atlas.ingest_candle(
  p_asset_id uuid,
  p_timeframe signal_atlas.timeframe_code,
  p_open_time timestamptz,
  p_open numeric,
  p_high numeric,
  p_low numeric,
  p_close numeric,
  p_volume numeric,
  p_source text,
  p_is_closed boolean,
  p_source_observed_at timestamptz,
  p_source_latency_ms integer,
  p_raw_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seconds integer;
  v_close_time timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_existing signal_atlas.candles%rowtype;
  v_id uuid;
begin
  v_seconds := signal_atlas.timeframe_seconds(p_timeframe);
  v_close_time := p_open_time + pg_catalog.make_interval(secs => v_seconds);
  if pg_catalog.mod(pg_catalog.floor(extract(epoch from p_open_time))::bigint, v_seconds) <> 0 then
    raise exception using errcode = '23514', message = 'candle open_time is not aligned to timeframe';
  end if;
  if p_open_time > v_now or p_source_observed_at > v_now then
    raise exception using errcode = '23514', message = 'future candle/source timestamp rejected';
  end if;
  if p_is_closed and v_now < v_close_time then
    raise exception using errcode = '23514', message = 'candle cannot be closed before close_time';
  end if;
  if p_source_latency_ms < 0 or pg_catalog.length(p_raw_hash) < 32 then
    raise exception using errcode = '23514', message = 'invalid source latency or raw hash';
  end if;

  select * into v_existing
  from signal_atlas.candles
  where asset_id = p_asset_id and timeframe = p_timeframe and open_time = p_open_time
  for update;

  if found then
    if v_existing.is_closed then
      if v_existing.open is distinct from p_open
         or v_existing.high is distinct from p_high
         or v_existing.low is distinct from p_low
         or v_existing.close is distinct from p_close
         or v_existing.volume is distinct from coalesce(p_volume, 0)
         or v_existing.raw_hash is distinct from p_raw_hash then
        raise exception using errcode = '55000', message = 'closed candle payload differs; record a correction event';
      end if;
      return v_existing.id;
    end if;

    update signal_atlas.candles
    set open = p_open,
        high = p_high,
        low = p_low,
        close = p_close,
        volume = coalesce(p_volume, 0),
        source = p_source,
        is_closed = p_is_closed,
        source_observed_at = p_source_observed_at,
        received_at = v_now,
        source_latency_ms = p_source_latency_ms,
        raw_hash = p_raw_hash
    where id = v_existing.id
    returning id into v_id;
    return v_id;
  end if;

  insert into signal_atlas.candles (
    asset_id, timeframe, open_time, close_time, open, high, low, close, volume,
    source, is_closed, source_observed_at, received_at, source_latency_ms, raw_hash
  ) values (
    p_asset_id, p_timeframe, p_open_time, v_close_time, p_open, p_high, p_low, p_close,
    coalesce(p_volume, 0), p_source, p_is_closed, p_source_observed_at,
    v_now, p_source_latency_ms, p_raw_hash
  ) returning id into v_id;
  return v_id;
end
$$;

create or replace function signal_atlas.register_policy_version(
  p_policy_key text,
  p_mode signal_atlas.mode_code,
  p_version integer,
  p_config jsonb,
  p_effective_from timestamptz,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_id uuid;
  v_existing signal_atlas.policy_versions%rowtype;
begin
  if p_version <= 0 or pg_catalog.jsonb_typeof(p_config) <> 'object' then
    raise exception using errcode = '23514', message = 'invalid immutable policy payload';
  end if;
  v_hash := pg_catalog.md5(p_config::text);
  insert into signal_atlas.policy_versions(policy_key, mode, version, config, config_hash, effective_from, notes)
  values (p_policy_key, p_mode, p_version, p_config, v_hash, p_effective_from, p_notes)
  on conflict (policy_key, mode, version) do nothing
  returning id into v_id;
  if v_id is not null then return v_id; end if;
  select * into v_existing from signal_atlas.policy_versions
  where policy_key = p_policy_key and mode = p_mode and version = p_version;
  if v_existing.config_hash <> v_hash then
    raise exception using errcode = '23505', message = 'policy version already exists with different immutable config';
  end if;
  return v_existing.id;
end
$$;

create or replace function signal_atlas.register_model_artifact(
  p_asset_id uuid,
  p_timeframe signal_atlas.timeframe_code,
  p_artifact_uri text,
  p_artifact_sha256 text,
  p_feature_schema_hash text,
  p_training_config jsonb,
  p_validation_metrics jsonb,
  p_train_start_at timestamptz,
  p_train_end_at timestamptz,
  p_training_cutoff_at timestamptz,
  p_holdout_start_at timestamptz,
  p_holdout_end_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing signal_atlas.model_artifacts%rowtype;
begin
  if p_artifact_sha256 !~ '^[0-9a-f]{64}$'
     or pg_catalog.length(p_feature_schema_hash) < 32
     or pg_catalog.jsonb_typeof(p_training_config) <> 'object'
     or pg_catalog.jsonb_typeof(p_validation_metrics) <> 'object' then
    raise exception using errcode = '23514', message = 'invalid immutable model artifact payload';
  end if;
  insert into signal_atlas.model_artifacts(
    asset_id, timeframe, artifact_uri, artifact_sha256, feature_schema_hash,
    training_config, validation_metrics, train_start_at, train_end_at,
    training_cutoff_at, holdout_start_at, holdout_end_at
  ) values (
    p_asset_id, p_timeframe, p_artifact_uri, p_artifact_sha256, p_feature_schema_hash,
    p_training_config, p_validation_metrics, p_train_start_at, p_train_end_at,
    p_training_cutoff_at, p_holdout_start_at, p_holdout_end_at
  )
  on conflict (asset_id, timeframe, artifact_sha256) do nothing
  returning id into v_id;
  if v_id is not null then return v_id; end if;
  select * into v_existing from signal_atlas.model_artifacts
  where asset_id = p_asset_id and timeframe = p_timeframe and artifact_sha256 = p_artifact_sha256;
  if v_existing.feature_schema_hash <> p_feature_schema_hash
     or v_existing.training_config <> p_training_config
     or v_existing.validation_metrics <> p_validation_metrics then
    raise exception using errcode = '23505', message = 'model hash already exists with different immutable metadata';
  end if;
  return v_existing.id;
end
$$;

create or replace function signal_atlas.bootstrap_champion(
  p_asset_id uuid,
  p_timeframe signal_atlas.timeframe_code,
  p_model_artifact_id uuid,
  p_idempotency_key text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_current uuid;
  v_model signal_atlas.model_artifacts%rowtype;
  v_event_id uuid;
  v_samples integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_asset_id::text || '|' || p_timeframe::text, 0));
  select id into v_existing from signal_atlas.model_deployment_events where idempotency_key = p_idempotency_key;
  if found then return v_existing; end if;
  select * into v_model from signal_atlas.model_artifacts where id = p_model_artifact_id;
  if not found or v_model.asset_id <> p_asset_id or v_model.timeframe <> p_timeframe then
    raise exception using errcode = '23514', message = 'bootstrap model does not match segment';
  end if;
  if coalesce(v_model.validation_metrics->>'sample_size', '') !~ '^[0-9]+$' then
    raise exception using errcode = '23514', message = 'model validation sample_size is missing';
  end if;
  v_samples := (v_model.validation_metrics->>'sample_size')::integer;
  if v_samples < 300 then
    raise exception using errcode = '23514', message = 'bootstrap champion requires at least 300 chronological holdout samples';
  end if;
  v_current := signal_atlas.current_champion_model(p_asset_id, p_timeframe, v_now);
  if v_current is not null then
    raise exception using errcode = '23514', message = 'segment already has a champion; use paired promotion';
  end if;
  insert into signal_atlas.model_deployment_events(
    idempotency_key, asset_id, timeframe, action, model_artifact_id,
    previous_model_artifact_id, effective_at, reason
  ) values (
    p_idempotency_key, p_asset_id, p_timeframe, 'bootstrap_champion', p_model_artifact_id,
    null, v_now, p_reason
  ) returning id into v_event_id;
  return v_event_id;
end
$$;

create or replace function signal_atlas.register_decision(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_key text;
  v_asset signal_atlas.assets%rowtype;
  v_timeframe signal_atlas.timeframe_code;
  v_mode signal_atlas.mode_code;
  v_role signal_atlas.model_role_code;
  v_direction signal_atlas.direction_code;
  v_expiration signal_atlas.expiration_code;
  v_quality signal_atlas.signal_quality_code;
  v_entry_at timestamptz;
  v_expiry_at timestamptz;
  v_feature_cutoff timestamptz;
  v_source_received timestamptz;
  v_model signal_atlas.model_artifacts%rowtype;
  v_policy signal_atlas.policy_versions%rowtype;
  v_decision_id uuid;
  v_existing signal_atlas.decision_events%rowtype;
  v_paper_id uuid;
  v_shadow jsonb;
  v_shadow_model signal_atlas.model_artifacts%rowtype;
  v_reasons jsonb;
  v_feature_snapshot jsonb;
  v_data_lineage jsonb;
  v_shadows jsonb;
  v_stake numeric;
  v_payout numeric;
  v_cost numeric;
  v_tie_policy signal_atlas.tie_policy_code;
  v_tie_probability numeric;
  v_candle_hash text;
begin
  if pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'decision payload must be a JSON object';
  end if;
  v_key := pg_catalog.btrim(p_payload->>'idempotency_key');
  if coalesce(pg_catalog.length(v_key), 0) < 12 then
    raise exception using errcode = '22023', message = 'idempotency_key must have at least 12 characters';
  end if;
  v_timeframe := (p_payload->>'timeframe')::signal_atlas.timeframe_code;
  v_mode := (p_payload->>'mode')::signal_atlas.mode_code;
  v_role := coalesce(p_payload->>'model_role', 'champion')::signal_atlas.model_role_code;
  v_direction := (p_payload->>'direction')::signal_atlas.direction_code;
  v_expiration := (p_payload->>'expiration')::signal_atlas.expiration_code;
  v_quality := coalesce(p_payload->>'quality', 'technical')::signal_atlas.signal_quality_code;
  v_entry_at := (p_payload->>'entry_at')::timestamptz;
  v_expiry_at := (p_payload->>'expiry_at')::timestamptz;
  v_feature_cutoff := (p_payload->>'feature_cutoff_at')::timestamptz;
  v_source_received := (p_payload->>'source_received_at')::timestamptz;

  select * into v_asset from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_payload->>'symbol')) and active;
  if not found then raise exception using errcode = '23503', message = 'active asset not found'; end if;

  select * into v_existing from signal_atlas.decision_events where idempotency_key = v_key;
  if found then
    if v_existing.asset_id <> v_asset.id or v_existing.timeframe <> v_timeframe
       or v_existing.mode <> v_mode or v_existing.entry_at <> v_entry_at then
      raise exception using errcode = '23505', message = 'idempotency key was reused with a different decision';
    end if;
    return v_existing.id;
  end if;

  if v_feature_cutoff > v_now or v_source_received > v_now or v_now >= v_entry_at then
    raise exception using errcode = '23514', message = 'decision is not prospective at server time';
  end if;
  select * into v_model from signal_atlas.model_artifacts where id = (p_payload->>'model_artifact_id')::uuid;
  if not found then raise exception using errcode = '23503', message = 'model artifact not found'; end if;
  select * into v_policy from signal_atlas.policy_versions where id = (p_payload->>'policy_version_id')::uuid;
  if not found then raise exception using errcode = '23503', message = 'policy version not found'; end if;

  v_stake := (p_payload->>'stake')::numeric;
  v_payout := (p_payload->>'payout_ratio')::numeric;
  v_cost := coalesce((p_payload->>'operation_cost')::numeric, 0);
  v_tie_policy := coalesce(p_payload->>'tie_policy', 'loss')::signal_atlas.tie_policy_code;
  v_tie_probability := coalesce((p_payload->>'tie_probability')::numeric, 0);
  v_candle_hash := pg_catalog.btrim(p_payload->>'candle_set_hash');
  v_reasons := coalesce(p_payload->'reasons', '[]'::jsonb);
  v_feature_snapshot := coalesce(p_payload->'feature_snapshot', '{}'::jsonb);
  v_data_lineage := coalesce(p_payload->'data_lineage', '{}'::jsonb);
  v_shadows := coalesce(p_payload->'shadow_predictions', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(v_reasons) <> 'array'
     or pg_catalog.jsonb_typeof(v_feature_snapshot) <> 'object'
     or pg_catalog.jsonb_typeof(v_data_lineage) <> 'object'
     or pg_catalog.jsonb_typeof(v_shadows) <> 'array' then
    raise exception using errcode = '22023', message = 'reasons/shadows must be arrays and feature/data snapshots must be objects';
  end if;

  insert into signal_atlas.decision_events(
    idempotency_key, asset_id, timeframe, mode, model_role, model_artifact_id,
    policy_version_id, direction, expiration, quality, score, probability,
    probability_lb, expected_ev, confluence_count, statistical_sample_size,
    reference_price, stake, payout_ratio, operation_cost, tie_policy, tie_probability,
    decision_at, feature_cutoff_at, entry_at, expiry_at, source_candle_open_time,
    source_received_at, data_age_ms, source_latency_ms, used_live_candle,
    candle_set_hash, model_hash_snapshot, policy_hash_snapshot, config_snapshot,
    feature_snapshot, data_lineage, reasons
  ) values (
    v_key, v_asset.id, v_timeframe, v_mode, v_role, v_model.id,
    v_policy.id, v_direction, v_expiration, v_quality,
    (p_payload->>'score')::numeric, (p_payload->>'probability')::numeric,
    (p_payload->>'probability_lb')::numeric, (p_payload->>'expected_ev')::numeric,
    (p_payload->>'confluence_count')::integer, (p_payload->>'statistical_sample_size')::integer,
    (p_payload->>'reference_price')::numeric, v_stake, v_payout, v_cost, v_tie_policy, v_tie_probability,
    v_now, v_feature_cutoff, v_entry_at, v_expiry_at,
    (p_payload->>'source_candle_open_time')::timestamptz, v_source_received,
    (p_payload->>'data_age_ms')::integer, (p_payload->>'source_latency_ms')::integer,
    coalesce((p_payload->>'used_live_candle')::boolean, false),
    v_candle_hash, v_model.artifact_sha256, v_policy.config_hash,
    v_policy.config || pg_catalog.jsonb_build_object(
      'stake', v_stake, 'payout_ratio', v_payout, 'operation_cost', v_cost,
      'tie_policy', v_tie_policy, 'tie_probability', v_tie_probability
    ),
    v_feature_snapshot, v_data_lineage, v_reasons
  )
  on conflict on constraint decision_events_unique_entry_role do nothing
  returning id into v_decision_id;

  if v_decision_id is null then
    select * into v_existing from signal_atlas.decision_events
    where asset_id = v_asset.id and timeframe = v_timeframe and mode = v_mode
      and entry_at = v_entry_at and model_role = v_role;
    if v_existing.model_artifact_id <> v_model.id or v_existing.policy_version_id <> v_policy.id
       or v_existing.direction <> v_direction or v_existing.candle_set_hash <> v_candle_hash then
      raise exception using errcode = '23505', message = 'entry window already has a different frozen decision';
    end if;
    v_decision_id := v_existing.id;
  end if;

  insert into signal_atlas.paper_trades(
    decision_event_id, scheduled_entry_at, scheduled_expiry_at,
    stake, payout_ratio, operation_cost, tie_policy
  ) values (
    v_decision_id, v_entry_at, v_expiry_at, v_stake, v_payout, v_cost, v_tie_policy
  ) on conflict (decision_event_id) do nothing
  returning id into v_paper_id;
  if v_paper_id is null then
    select id into v_paper_id from signal_atlas.paper_trades where decision_event_id = v_decision_id;
  end if;
  insert into signal_atlas.paper_trade_events(paper_trade_id, event_type, event_at, details)
  values (v_paper_id, 'scheduled', v_now, pg_catalog.jsonb_build_object('decision_event_id', v_decision_id))
  on conflict (paper_trade_id, event_type) do nothing;

  for v_shadow in select value from pg_catalog.jsonb_array_elements(v_shadows)
  loop
    select * into v_shadow_model from signal_atlas.model_artifacts
    where id = (v_shadow->>'model_artifact_id')::uuid;
    if not found then raise exception using errcode = '23503', message = 'shadow model artifact not found'; end if;
    insert into signal_atlas.shadow_predictions(
      decision_event_id, model_artifact_id, policy_version_id, direction, score,
      probability, probability_lb, expected_ev, statistical_sample_size,
      predicted_at, feature_cutoff_at, candle_set_hash, model_hash_snapshot,
      policy_hash_snapshot, config_snapshot, reasons
    ) values (
      v_decision_id, v_shadow_model.id, v_policy.id,
      (v_shadow->>'direction')::signal_atlas.direction_code,
      (v_shadow->>'score')::numeric, (v_shadow->>'probability')::numeric,
      (v_shadow->>'probability_lb')::numeric, (v_shadow->>'expected_ev')::numeric,
      (v_shadow->>'statistical_sample_size')::integer,
      v_now, v_feature_cutoff, v_candle_hash, v_shadow_model.artifact_sha256,
      v_policy.config_hash, v_policy.config,
      coalesce(v_shadow->'reasons', '[]'::jsonb)
    ) on conflict (decision_event_id, model_artifact_id) do nothing;
  end loop;

  return v_decision_id;
end
$$;

create or replace function signal_atlas.resolve_decision(p_decision_event_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_decision signal_atlas.decision_events%rowtype;
  v_entry signal_atlas.candles%rowtype;
  v_exit signal_atlas.candles%rowtype;
  v_seconds integer;
  v_outcome_id uuid;
  v_existing signal_atlas.outcomes%rowtype;
  v_market_move text;
  v_result text;
  v_hash text;
  v_paper signal_atlas.paper_trades%rowtype;
  v_pnl numeric;
begin
  select * into v_decision from signal_atlas.decision_events
  where id = p_decision_event_id for share;
  if not found then raise exception using errcode = '23503', message = 'decision not found'; end if;
  select * into v_existing from signal_atlas.outcomes where decision_event_id = p_decision_event_id;
  if found then return v_existing.id; end if;
  if v_now < v_decision.expiry_at then
    raise exception using errcode = '55000', message = 'decision has not reached exact expiry_at';
  end if;
  v_seconds := signal_atlas.timeframe_seconds(v_decision.timeframe);
  select * into v_entry from signal_atlas.candles
  where asset_id = v_decision.asset_id and timeframe = v_decision.timeframe
    and open_time = v_decision.entry_at and close_time = v_decision.entry_at + pg_catalog.make_interval(secs => v_seconds)
    and is_closed;
  if not found then raise exception using errcode = '02000', message = 'exact closed entry candle is not available'; end if;
  select * into v_exit from signal_atlas.candles
  where asset_id = v_decision.asset_id and timeframe = v_decision.timeframe
    and open_time = v_decision.expiry_at - pg_catalog.make_interval(secs => v_seconds)
    and close_time = v_decision.expiry_at and is_closed;
  if not found then raise exception using errcode = '02000', message = 'exact closed expiry candle is not available'; end if;

  v_market_move := case when v_exit.close > v_entry.open then 'up' when v_exit.close < v_entry.open then 'down' else 'tie' end;
  v_result := signal_atlas.trade_result(v_decision.direction, v_entry.open, v_exit.close);
  v_hash := pg_catalog.md5(
    v_decision.id::text || '|' || v_entry.id::text || '|' || v_exit.id::text || '|'
    || v_entry.open::text || '|' || v_exit.close::text || '|' || v_decision.expiry_at::text
  );
  insert into signal_atlas.outcomes(
    decision_event_id, entry_candle_id, expiry_candle_id, entry_at, expiry_at,
    entry_price, close_price, market_move, decision_result, resolved_at, resolution_hash
  ) values (
    v_decision.id, v_entry.id, v_exit.id, v_decision.entry_at, v_decision.expiry_at,
    v_entry.open, v_exit.close, v_market_move, v_result, v_now, v_hash
  ) on conflict (decision_event_id) do nothing
  returning id into v_outcome_id;
  if v_outcome_id is null then
    select id into v_outcome_id from signal_atlas.outcomes where decision_event_id = v_decision.id;
  end if;

  select * into v_paper from signal_atlas.paper_trades where decision_event_id = v_decision.id;
  if not found then raise exception using errcode = '23514', message = 'paper trade invariant violated'; end if;
  v_pnl := signal_atlas.trade_pnl(
    v_decision.direction, v_entry.open, v_exit.close, v_paper.stake,
    v_paper.payout_ratio, v_paper.operation_cost, v_paper.tie_policy
  );
  insert into signal_atlas.paper_trade_events(
    paper_trade_id, event_type, event_at, outcome_id, entry_price, close_price, result, pnl, details
  ) values (
    v_paper.id, 'resolved', v_now, v_outcome_id, v_entry.open, v_exit.close, v_result, v_pnl,
    pg_catalog.jsonb_build_object('entry_candle_id', v_entry.id, 'expiry_candle_id', v_exit.id)
  ) on conflict (paper_trade_id, event_type) do nothing;
  return v_outcome_id;
end
$$;

create or replace function signal_atlas.resolve_ready_decisions(p_limit integer default 100)
returns table(decision_event_id uuid, outcome_id uuid, resolution_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 1000';
  end if;
  for v_row in
    select d.id
    from signal_atlas.decision_events d
    where d.expiry_at <= pg_catalog.clock_timestamp()
      and not exists (select 1 from signal_atlas.outcomes o where o.decision_event_id = d.id)
      and exists (
        select 1 from signal_atlas.candles c
        where c.asset_id = d.asset_id and c.timeframe = d.timeframe
          and c.open_time = d.entry_at and c.is_closed
      )
      and exists (
        select 1 from signal_atlas.candles c
        where c.asset_id = d.asset_id and c.timeframe = d.timeframe
          and c.close_time = d.expiry_at and c.is_closed
      )
    order by d.expiry_at, d.id
    limit p_limit
    for update skip locked
  loop
    decision_event_id := v_row.id;
    outcome_id := signal_atlas.resolve_decision(v_row.id);
    resolution_status := 'resolved';
    return next;
  end loop;
end
$$;

create or replace view signal_atlas.prediction_outcomes
with (security_invoker = true)
as
select
  d.id as prediction_id,
  d.id as decision_event_id,
  'champion'::signal_atlas.model_role_code as model_role,
  d.asset_id,
  d.timeframe,
  d.mode,
  d.expiration,
  d.quality,
  d.model_artifact_id,
  d.policy_version_id,
  d.direction,
  d.probability,
  d.probability_lb,
  d.decision_at as predicted_at,
  d.entry_at,
  d.expiry_at,
  o.entry_price,
  o.close_price,
  signal_atlas.trade_result(d.direction, o.entry_price, o.close_price) as result,
  signal_atlas.trade_pnl(
    d.direction, o.entry_price, o.close_price, d.stake, d.payout_ratio,
    d.operation_cost, d.tie_policy
  ) as pnl,
  d.model_hash_snapshot,
  d.policy_hash_snapshot
from signal_atlas.decision_events d
join signal_atlas.outcomes o on o.decision_event_id = d.id
where not exists (
  select 1 from signal_atlas.correction_events c
  where c.correction_type = 'invalidate'
    and ((c.target_type = 'decision' and c.target_id = d.id)
      or (c.target_type = 'outcome' and c.target_id = o.id))
)
union all
select
  s.id as prediction_id,
  d.id as decision_event_id,
  'challenger'::signal_atlas.model_role_code as model_role,
  d.asset_id,
  d.timeframe,
  d.mode,
  d.expiration,
  d.quality,
  s.model_artifact_id,
  s.policy_version_id,
  s.direction,
  s.probability,
  s.probability_lb,
  s.predicted_at,
  d.entry_at,
  d.expiry_at,
  o.entry_price,
  o.close_price,
  signal_atlas.trade_result(s.direction, o.entry_price, o.close_price) as result,
  signal_atlas.trade_pnl(
    s.direction, o.entry_price, o.close_price, d.stake, d.payout_ratio,
    d.operation_cost, d.tie_policy
  ) as pnl,
  s.model_hash_snapshot,
  s.policy_hash_snapshot
from signal_atlas.shadow_predictions s
join signal_atlas.decision_events d on d.id = s.decision_event_id
join signal_atlas.outcomes o on o.decision_event_id = d.id
where not exists (
  select 1 from signal_atlas.correction_events c
  where c.correction_type = 'invalidate'
    and ((c.target_type = 'decision' and c.target_id = d.id)
      or (c.target_type = 'shadow_prediction' and c.target_id = s.id)
      or (c.target_type = 'outcome' and c.target_id = o.id))
);

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
  v_champion_ev numeric;
  v_challenger_ev numeric;
  v_delta numeric;
  v_delta_sd numeric;
  v_delta_lb numeric;
  v_delta_ub numeric;
  v_champion_brier numeric;
  v_challenger_brier numeric;
  v_champion_dd numeric;
  v_challenger_dd numeric;
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
  ) then
    raise exception using errcode = '23505', message = 'review window_end already exists with different immutable criteria';
  end if;

  if not found then
    with paired as (
      select
        d.id,
        d.entry_at,
        signal_atlas.trade_pnl(
          d.direction, o.entry_price, o.close_price, d.stake, d.payout_ratio,
          d.operation_cost, d.tie_policy
        ) as champion_pnl,
        signal_atlas.trade_pnl(
          s.direction, o.entry_price, o.close_price, d.stake, d.payout_ratio,
          d.operation_cost, d.tie_policy
        ) as challenger_pnl,
        pg_catalog.power(
          d.probability - case when signal_atlas.trade_result(d.direction, o.entry_price, o.close_price) = 'win' then 1 else 0 end,
          2
        ) as champion_brier,
        pg_catalog.power(
          s.probability - case when signal_atlas.trade_result(s.direction, o.entry_price, o.close_price) = 'win' then 1 else 0 end,
          2
        ) as challenger_brier
      from signal_atlas.decision_events d
      join signal_atlas.shadow_predictions s
        on s.decision_event_id = d.id and s.model_artifact_id = p_challenger_model_artifact_id
      join signal_atlas.outcomes o on o.decision_event_id = d.id
      where d.asset_id = p_asset_id
        and d.timeframe = p_timeframe
        and d.model_role = 'champion'
        and d.model_artifact_id = v_champion_id
        and d.entry_at >= p_window_start_at and d.entry_at < p_window_end_at
        and d.decision_at > v_champion.training_cutoff_at
        and d.decision_at > v_challenger.training_cutoff_at
        and s.predicted_at < d.entry_at
        and not exists (
          select 1 from signal_atlas.correction_events c
          where c.correction_type = 'invalidate'
            and ((c.target_type = 'decision' and c.target_id = d.id)
              or (c.target_type = 'shadow_prediction' and c.target_id = s.id)
              or (c.target_type = 'outcome' and c.target_id = o.id))
        )
    ), equity as (
      select *,
        pg_catalog.sum(champion_pnl) over (order by entry_at, id rows unbounded preceding) as champion_equity,
        pg_catalog.sum(challenger_pnl) over (order by entry_at, id rows unbounded preceding) as challenger_equity
      from paired
    ), drawdowns as (
      select *,
        greatest(0, pg_catalog.max(champion_equity) over (order by entry_at, id rows unbounded preceding)) - champion_equity as champion_drawdown,
        greatest(0, pg_catalog.max(challenger_equity) over (order by entry_at, id rows unbounded preceding)) - challenger_equity as challenger_drawdown
      from equity
    )
    select
      pg_catalog.count(*)::integer,
      pg_catalog.avg(champion_pnl),
      pg_catalog.avg(challenger_pnl),
      pg_catalog.avg(challenger_pnl - champion_pnl),
      pg_catalog.stddev_samp(challenger_pnl - champion_pnl),
      pg_catalog.avg(champion_brier),
      pg_catalog.avg(challenger_brier),
      coalesce(pg_catalog.max(champion_drawdown), 0),
      coalesce(pg_catalog.max(challenger_drawdown), 0)
    into v_n, v_champion_ev, v_challenger_ev, v_delta, v_delta_sd,
         v_champion_brier, v_challenger_brier, v_champion_dd, v_challenger_dd
    from drawdowns;

    if v_n >= 2 then
      v_delta_lb := v_delta - 1.96 * v_delta_sd / pg_catalog.sqrt(v_n::numeric);
      v_delta_ub := v_delta + 1.96 * v_delta_sd / pg_catalog.sqrt(v_n::numeric);
    end if;
    v_passed := v_n >= 300
      and v_delta_lb > 0
      and v_challenger_brier <= v_champion_brier + p_brier_tolerance
      and v_challenger_dd <= v_champion_dd * p_drawdown_limit_ratio;

    insert into signal_atlas.promotion_reviews(
      asset_id, timeframe, champion_model_artifact_id, challenger_model_artifact_id,
      window_start_at, window_end_at, paired_samples, champion_ev, challenger_ev,
      delta_ev, delta_ev_lb95, delta_ev_ub95, champion_brier, challenger_brier,
      champion_max_drawdown, challenger_max_drawdown, drawdown_limit_ratio,
      brier_tolerance, passed, criteria
    ) values (
      p_asset_id, p_timeframe, v_champion_id, p_challenger_model_artifact_id,
      p_window_start_at, p_window_end_at, v_n, v_champion_ev, v_challenger_ev,
      v_delta, v_delta_lb, v_delta_ub, v_champion_brier, v_challenger_brier,
      v_champion_dd, v_challenger_dd, p_drawdown_limit_ratio,
      p_brier_tolerance, v_passed,
      pg_catalog.jsonb_build_object(
        'minimum_paired_samples', 300,
        'delta_ev_lb95_must_exceed', 0,
        'brier_not_worse_tolerance', p_brier_tolerance,
        'drawdown_limit_ratio', p_drawdown_limit_ratio,
        'prospective_after_training_cutoff', true
      )
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
      pg_catalog.format('paired promotion: N=%s, delta EV LB95=%s', v_review.paired_samples, v_review.delta_ev_lb95)
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

create or replace function signal_atlas.record_scanner_run(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := pg_catalog.btrim(p_payload->>'idempotency_key');
  v_run_id uuid;
  v_started timestamptz := (p_payload->>'started_at')::timestamptz;
  v_finished timestamptz := (p_payload->>'finished_at')::timestamptz;
  v_health jsonb := coalesce(p_payload->'health', '[]'::jsonb);
  v_item jsonb;
begin
  if coalesce(pg_catalog.length(v_key), 0) < 12 or pg_catalog.jsonb_typeof(v_health) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid scanner idempotency key or health payload';
  end if;
  if v_started > v_finished or v_finished > pg_catalog.clock_timestamp() then
    raise exception using errcode = '23514', message = 'scanner run timestamps are not chronological';
  end if;
  select id into v_run_id from signal_atlas.scanner_runs where idempotency_key = v_key;
  if found then return v_run_id; end if;
  insert into signal_atlas.scanner_runs(
    idempotency_key, worker_id, started_at, finished_at, status,
    assets_requested, decisions_created, shadows_created, waits, errors, details
  ) values (
    v_key, p_payload->>'worker_id', v_started, v_finished,
    (p_payload->>'status')::signal_atlas.scanner_status_code,
    coalesce((p_payload->>'assets_requested')::integer, 0),
    coalesce((p_payload->>'decisions_created')::integer, 0),
    coalesce((p_payload->>'shadows_created')::integer, 0),
    coalesce((p_payload->>'waits')::integer, 0),
    coalesce((p_payload->>'errors')::integer, 0),
    coalesce(p_payload->'details', '{}'::jsonb)
  ) returning id into v_run_id;
  for v_item in select value from pg_catalog.jsonb_array_elements(v_health)
  loop
    insert into signal_atlas.scanner_health_events(
      scanner_run_id, component, status, observed_at, latency_ms,
      last_data_at, message, details
    ) values (
      v_run_id, v_item->>'component',
      (v_item->>'status')::signal_atlas.health_status_code,
      coalesce((v_item->>'observed_at')::timestamptz, v_finished),
      (v_item->>'latency_ms')::integer,
      (v_item->>'last_data_at')::timestamptz,
      v_item->>'message', coalesce(v_item->'details', '{}'::jsonb)
    );
  end loop;
  return v_run_id;
end
$$;

create or replace function signal_atlas.record_correction(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := pg_catalog.btrim(p_payload->>'idempotency_key');
  v_target_type signal_atlas.correction_target_code := (p_payload->>'target_type')::signal_atlas.correction_target_code;
  v_target_id uuid := (p_payload->>'target_id')::uuid;
  v_correction_type text := p_payload->>'correction_type';
  v_exists boolean := false;
  v_id uuid;
begin
  if coalesce(pg_catalog.length(v_key), 0) < 12 then
    raise exception using errcode = '22023', message = 'correction idempotency key must have at least 12 characters';
  end if;
  v_exists := case v_target_type
    when 'candle' then exists(select 1 from signal_atlas.candles where id = v_target_id)
    when 'decision' then exists(select 1 from signal_atlas.decision_events where id = v_target_id)
    when 'shadow_prediction' then exists(select 1 from signal_atlas.shadow_predictions where id = v_target_id)
    when 'outcome' then exists(select 1 from signal_atlas.outcomes where id = v_target_id)
    when 'paper_trade' then exists(select 1 from signal_atlas.paper_trades where id = v_target_id)
    when 'model_artifact' then exists(select 1 from signal_atlas.model_artifacts where id = v_target_id)
    when 'policy_version' then exists(select 1 from signal_atlas.policy_versions where id = v_target_id)
    when 'deployment_event' then exists(select 1 from signal_atlas.model_deployment_events where id = v_target_id)
  end;
  if not v_exists then raise exception using errcode = '23503', message = 'correction target not found'; end if;
  if v_correction_type = 'supersede' and p_payload->'replacement_payload' is null then
    raise exception using errcode = '22023', message = 'supersede correction requires replacement_payload';
  end if;
  insert into signal_atlas.correction_events(
    idempotency_key, target_type, target_id, correction_type, reason,
    replacement_payload, actor_id
  ) values (
    v_key, v_target_type, v_target_id, v_correction_type, p_payload->>'reason',
    p_payload->'replacement_payload', (select auth.uid())
  ) on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from signal_atlas.correction_events where idempotency_key = v_key;
  end if;
  return v_id;
end
$$;

create or replace view signal_atlas.current_champions
with (security_invoker = true)
as
with ranked as (
  select e.*,
    pg_catalog.row_number() over (
      partition by e.asset_id, e.timeframe
      order by e.effective_at desc, e.created_at desc, e.id desc
    ) as rn
  from signal_atlas.model_deployment_events e
  where e.effective_at <= pg_catalog.clock_timestamp()
)
select asset_id, timeframe, model_artifact_id, id as deployment_event_id, effective_at
from ranked
where rn = 1 and action <> 'retire_champion';

create or replace view public.signal_atlas_latest
with (security_invoker = true)
as
with ranked as (
  select d.*,
    pg_catalog.row_number() over (
      partition by d.asset_id, d.timeframe, d.mode, d.model_role
      order by d.decision_at desc, d.id desc
    ) as rn
  from signal_atlas.decision_events d
)
select
  d.id,
  a.symbol,
  a.market,
  d.timeframe,
  d.mode,
  d.model_role,
  d.direction,
  d.expiration,
  d.quality,
  d.score,
  d.probability,
  d.probability_lb,
  d.expected_ev,
  d.entry_at,
  d.expiry_at,
  d.data_age_ms,
  d.source_latency_ms,
  d.used_live_candle,
  d.model_artifact_id,
  d.policy_version_id,
  d.model_hash_snapshot,
  d.policy_hash_snapshot,
  d.reasons,
  case
    when exists (
      select 1 from signal_atlas.correction_events c
      where c.target_type = 'decision' and c.target_id = d.id and c.correction_type = 'invalidate'
    ) then 'invalidated'
    when pg_catalog.clock_timestamp() < d.entry_at then 'awaiting_entry'
    when pg_catalog.clock_timestamp() < d.expiry_at then 'in_progress'
    when o.id is null then 'awaiting_resolution'
    else 'resolved'
  end as lifecycle_status,
  o.decision_result,
  o.entry_price,
  o.close_price,
  o.resolved_at
from ranked d
join signal_atlas.assets a on a.id = d.asset_id
left join signal_atlas.outcomes o on o.decision_event_id = d.id
where d.rn = 1;

create or replace view public.signal_atlas_opportunities
with (security_invoker = true)
as
with valid as (
  select d.*, a.symbol, a.market,
    pg_catalog.row_number() over (
      partition by d.asset_id, d.timeframe, d.mode
      order by d.probability desc, d.score desc, d.decision_at desc, d.id desc
    ) as segment_rank
  from signal_atlas.decision_events d
  join signal_atlas.assets a on a.id = d.asset_id and a.active
  join signal_atlas.current_champions c
    on c.asset_id = d.asset_id and c.timeframe = d.timeframe
   and c.model_artifact_id = d.model_artifact_id
  where d.model_role = 'champion'
    and pg_catalog.clock_timestamp() >= d.decision_at
    and pg_catalog.clock_timestamp() < d.entry_at
    and not exists (
      select 1 from signal_atlas.correction_events x
      where x.target_type = 'decision' and x.target_id = d.id and x.correction_type = 'invalidate'
    )
)
select
  id, symbol, market, timeframe, mode, direction, expiration, quality,
  score, probability, probability_lb, expected_ev, entry_at, expiry_at,
  data_age_ms, source_latency_ms, used_live_candle, model_artifact_id,
  policy_version_id, model_hash_snapshot, policy_hash_snapshot, reasons,
  pg_catalog.row_number() over (order by probability desc, score desc, entry_at, id) as opportunity_rank
from valid
where segment_rank = 1;

create or replace view public.signal_atlas_metrics
with (security_invoker = true)
as
select
  a.symbol,
  p.timeframe,
  p.direction,
  p.expiration,
  p.mode,
  p.model_role,
  p.model_artifact_id,
  p.policy_version_id,
  p.model_hash_snapshot,
  p.policy_hash_snapshot,
  pg_catalog.count(*)::bigint as resolved,
  pg_catalog.count(*) filter (where p.result = 'win')::bigint as wins,
  pg_catalog.count(*) filter (where p.result = 'loss')::bigint as losses,
  pg_catalog.count(*) filter (where p.result = 'tie')::bigint as ties,
  pg_catalog.avg((p.result = 'win')::integer::numeric) as win_rate,
  pg_catalog.avg(pg_catalog.power(p.probability - (p.result = 'win')::integer, 2)) as brier_score,
  pg_catalog.avg(p.pnl) as ev_net_per_trade,
  case when pg_catalog.count(*) >= 2 then
    pg_catalog.avg(p.pnl) - 1.96 * pg_catalog.stddev_samp(p.pnl) / pg_catalog.sqrt(pg_catalog.count(*)::numeric)
  end as ev_net_lb95,
  pg_catalog.sum(p.pnl) as total_pnl,
  pg_catalog.min(p.entry_at) as first_entry_at,
  pg_catalog.max(p.expiry_at) as last_expiry_at
from signal_atlas.prediction_outcomes p
join signal_atlas.assets a on a.id = p.asset_id
group by
  a.symbol, p.timeframe, p.direction, p.expiration, p.mode, p.model_role,
  p.model_artifact_id, p.policy_version_id, p.model_hash_snapshot, p.policy_hash_snapshot;

create or replace view public.signal_atlas_paper_summary
with (security_invoker = true)
as
with resolved as (
  select
    a.symbol, d.timeframe, d.mode, d.expiration, d.model_artifact_id,
    d.policy_version_id, d.entry_at, d.id as decision_event_id,
    e.result, e.pnl
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  join signal_atlas.assets a on a.id = d.asset_id
  where e.event_type = 'resolved'
    and not exists (
      select 1 from signal_atlas.correction_events c
      where c.correction_type = 'invalidate'
        and ((c.target_type = 'decision' and c.target_id = d.id)
          or (c.target_type = 'paper_trade' and c.target_id = t.id)
          or (c.target_type = 'outcome' and c.target_id = e.outcome_id))
    )
), curve as (
  select *,
    pg_catalog.sum(pnl) over (
      partition by symbol, timeframe, mode, expiration, model_artifact_id, policy_version_id
      order by entry_at, decision_event_id rows unbounded preceding
    ) as equity
  from resolved
), drawdowns as (
  select *,
    greatest(0, pg_catalog.max(equity) over (
      partition by symbol, timeframe, mode, expiration, model_artifact_id, policy_version_id
      order by entry_at, decision_event_id rows unbounded preceding
    )) - equity as drawdown
  from curve
)
select
  symbol, timeframe, mode, expiration, model_artifact_id, policy_version_id,
  pg_catalog.count(*)::bigint as trades,
  pg_catalog.count(*) filter (where result = 'win')::bigint as wins,
  pg_catalog.count(*) filter (where result = 'loss')::bigint as losses,
  pg_catalog.count(*) filter (where result = 'tie')::bigint as ties,
  pg_catalog.sum(pnl) as final_equity,
  pg_catalog.avg(pnl) as ev_net_per_trade,
  coalesce(pg_catalog.max(drawdown), 0) as max_drawdown,
  pg_catalog.min(entry_at) as first_entry_at,
  pg_catalog.max(entry_at) as last_entry_at
from drawdowns
group by symbol, timeframe, mode, expiration, model_artifact_id, policy_version_id;

create or replace view public.signal_atlas_health
with (security_invoker = true)
as
with latest_component as (
  select h.*,
    pg_catalog.row_number() over (partition by h.component order by h.observed_at desc, h.id desc) as rn
  from signal_atlas.scanner_health_events h
), latest_run as (
  select r.* from signal_atlas.scanner_runs r order by r.finished_at desc, r.id desc limit 1
)
select
  'scanner-run'::text as component,
  case r.status when 'ok' then 'healthy' when 'partial' then 'degraded' else 'down' end::text as status,
  r.finished_at as observed_at,
  (extract(epoch from (r.finished_at - r.started_at)) * 1000)::bigint as latency_ms,
  null::timestamptz as last_data_at,
  pg_catalog.format('%s decisions, %s shadows, %s waits, %s errors', r.decisions_created, r.shadows_created, r.waits, r.errors) as message,
  r.id as scanner_run_id,
  r.details
from latest_run r
union all
select
  h.component,
  h.status::text,
  h.observed_at,
  h.latency_ms::bigint,
  h.last_data_at,
  h.message,
  h.scanner_run_id,
  h.details
from latest_component h
where h.rn = 1;

create or replace function public.sa_ingest_candle(
  p_symbol text,
  p_timeframe text,
  p_open_time timestamptz,
  p_open numeric,
  p_high numeric,
  p_low numeric,
  p_close numeric,
  p_volume numeric,
  p_source text,
  p_is_closed boolean,
  p_source_observed_at timestamptz,
  p_source_latency_ms integer,
  p_raw_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset_id uuid;
begin
  select id into v_asset_id from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_symbol)) and active;
  if not found then raise exception using errcode = '23503', message = 'active asset not found'; end if;
  return signal_atlas.ingest_candle(
    v_asset_id, p_timeframe::signal_atlas.timeframe_code, p_open_time,
    p_open, p_high, p_low, p_close, p_volume, p_source, p_is_closed,
    p_source_observed_at, p_source_latency_ms, p_raw_hash
  );
end
$$;

create or replace function public.sa_register_policy_version(
  p_policy_key text,
  p_mode text,
  p_version integer,
  p_config jsonb,
  p_effective_from timestamptz,
  p_notes text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select signal_atlas.register_policy_version(
    p_policy_key, p_mode::signal_atlas.mode_code, p_version,
    p_config, p_effective_from, p_notes
  )
$$;

create or replace function public.sa_register_model_artifact(
  p_symbol text,
  p_timeframe text,
  p_artifact_uri text,
  p_artifact_sha256 text,
  p_feature_schema_hash text,
  p_training_config jsonb,
  p_validation_metrics jsonb,
  p_train_start_at timestamptz,
  p_train_end_at timestamptz,
  p_training_cutoff_at timestamptz,
  p_holdout_start_at timestamptz,
  p_holdout_end_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset_id uuid;
begin
  select id into v_asset_id from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_symbol));
  if not found then raise exception using errcode = '23503', message = 'asset not found'; end if;
  return signal_atlas.register_model_artifact(
    v_asset_id, p_timeframe::signal_atlas.timeframe_code, p_artifact_uri,
    p_artifact_sha256, p_feature_schema_hash, p_training_config,
    p_validation_metrics, p_train_start_at, p_train_end_at,
    p_training_cutoff_at, p_holdout_start_at, p_holdout_end_at
  );
end
$$;

create or replace function public.sa_bootstrap_champion(
  p_symbol text,
  p_timeframe text,
  p_model_artifact_id uuid,
  p_idempotency_key text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset_id uuid;
begin
  select id into v_asset_id from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_symbol));
  if not found then raise exception using errcode = '23503', message = 'asset not found'; end if;
  return signal_atlas.bootstrap_champion(
    v_asset_id, p_timeframe::signal_atlas.timeframe_code,
    p_model_artifact_id, p_idempotency_key, p_reason
  );
end
$$;

create or replace function public.sa_register_decision(p_payload jsonb)
returns uuid
language sql
security definer
set search_path = ''
as $$ select signal_atlas.register_decision(p_payload) $$;

create or replace function public.sa_resolve_decision(p_decision_event_id uuid)
returns uuid
language sql
security definer
set search_path = ''
as $$ select signal_atlas.resolve_decision(p_decision_event_id) $$;

create or replace function public.sa_resolve_ready_decisions(p_limit integer default 100)
returns table(decision_event_id uuid, outcome_id uuid, resolution_status text)
language sql
security definer
set search_path = ''
as $$ select * from signal_atlas.resolve_ready_decisions(p_limit) $$;

create or replace function public.sa_review_challenger(
  p_symbol text,
  p_timeframe text,
  p_challenger_model_artifact_id uuid,
  p_window_start_at timestamptz,
  p_window_end_at timestamptz,
  p_drawdown_limit_ratio numeric default 1.20,
  p_brier_tolerance numeric default 0
)
returns table(review_id uuid, review_passed boolean, deployment_event_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset_id uuid;
begin
  select id into v_asset_id from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_symbol));
  if not found then raise exception using errcode = '23503', message = 'asset not found'; end if;
  return query select * from signal_atlas.review_challenger(
    v_asset_id, p_timeframe::signal_atlas.timeframe_code,
    p_challenger_model_artifact_id, p_window_start_at, p_window_end_at,
    false, null, p_drawdown_limit_ratio, p_brier_tolerance
  );
end
$$;

create or replace function public.sa_promote_challenger(
  p_symbol text,
  p_timeframe text,
  p_challenger_model_artifact_id uuid,
  p_window_start_at timestamptz,
  p_window_end_at timestamptz,
  p_deployment_idempotency_key text,
  p_drawdown_limit_ratio numeric default 1.20,
  p_brier_tolerance numeric default 0
)
returns table(review_id uuid, review_passed boolean, deployment_event_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset_id uuid;
begin
  select id into v_asset_id from signal_atlas.assets
  where symbol = pg_catalog.upper(pg_catalog.btrim(p_symbol));
  if not found then raise exception using errcode = '23503', message = 'asset not found'; end if;
  return query select * from signal_atlas.review_challenger(
    v_asset_id, p_timeframe::signal_atlas.timeframe_code,
    p_challenger_model_artifact_id, p_window_start_at, p_window_end_at,
    true, p_deployment_idempotency_key, p_drawdown_limit_ratio, p_brier_tolerance
  );
end
$$;

create or replace function public.sa_record_scanner_run(p_payload jsonb)
returns uuid
language sql
security definer
set search_path = ''
as $$ select signal_atlas.record_scanner_run(p_payload) $$;

create or replace function public.sa_record_correction(p_payload jsonb)
returns uuid
language sql
security definer
set search_path = ''
as $$ select signal_atlas.record_correction(p_payload) $$;

create or replace function public.sa_segment_metrics(
  p_symbol text default null,
  p_timeframe text default null
)
returns setof public.signal_atlas_metrics
language sql
stable
security invoker
set search_path = ''
as $$
  select m.* from public.signal_atlas_metrics m
  where (p_symbol is null or m.symbol = pg_catalog.upper(pg_catalog.btrim(p_symbol)))
    and (p_timeframe is null or m.timeframe::text = p_timeframe)
$$;

alter table signal_atlas.assets enable row level security;
alter table signal_atlas.candles enable row level security;
alter table signal_atlas.policy_versions enable row level security;
alter table signal_atlas.model_artifacts enable row level security;
alter table signal_atlas.promotion_reviews enable row level security;
alter table signal_atlas.model_deployment_events enable row level security;
alter table signal_atlas.decision_events enable row level security;
alter table signal_atlas.shadow_predictions enable row level security;
alter table signal_atlas.outcomes enable row level security;
alter table signal_atlas.paper_trades enable row level security;
alter table signal_atlas.paper_trade_events enable row level security;
alter table signal_atlas.correction_events enable row level security;
alter table signal_atlas.scanner_runs enable row level security;
alter table signal_atlas.scanner_health_events enable row level security;

drop policy if exists public_read_assets on signal_atlas.assets;
create policy public_read_assets on signal_atlas.assets for select to anon, authenticated using (true);
drop policy if exists public_read_deployments on signal_atlas.model_deployment_events;
create policy public_read_deployments on signal_atlas.model_deployment_events for select to anon, authenticated using (true);
drop policy if exists public_read_decisions on signal_atlas.decision_events;
create policy public_read_decisions on signal_atlas.decision_events for select to anon, authenticated using (true);
drop policy if exists public_read_shadows on signal_atlas.shadow_predictions;
create policy public_read_shadows on signal_atlas.shadow_predictions for select to anon, authenticated using (true);
drop policy if exists public_read_outcomes on signal_atlas.outcomes;
create policy public_read_outcomes on signal_atlas.outcomes for select to anon, authenticated using (true);
drop policy if exists public_read_paper_trades on signal_atlas.paper_trades;
create policy public_read_paper_trades on signal_atlas.paper_trades for select to anon, authenticated using (true);
drop policy if exists public_read_paper_events on signal_atlas.paper_trade_events;
create policy public_read_paper_events on signal_atlas.paper_trade_events for select to anon, authenticated using (true);
drop policy if exists public_read_corrections on signal_atlas.correction_events;
create policy public_read_corrections on signal_atlas.correction_events for select to anon, authenticated using (true);
drop policy if exists public_read_scanner_runs on signal_atlas.scanner_runs;
create policy public_read_scanner_runs on signal_atlas.scanner_runs for select to anon, authenticated using (true);
drop policy if exists public_read_scanner_health on signal_atlas.scanner_health_events;
create policy public_read_scanner_health on signal_atlas.scanner_health_events for select to anon, authenticated using (true);

revoke all on schema signal_atlas from public, anon, authenticated, service_role;
grant usage on schema signal_atlas to anon, authenticated, service_role;
revoke all on all tables in schema signal_atlas from public, anon, authenticated, service_role;
revoke all on all sequences in schema signal_atlas from public, anon, authenticated, service_role;
revoke execute on all functions in schema signal_atlas from public, anon, authenticated, service_role;

grant select on signal_atlas.assets,
  signal_atlas.model_deployment_events,
  signal_atlas.decision_events,
  signal_atlas.shadow_predictions,
  signal_atlas.outcomes,
  signal_atlas.paper_trades,
  signal_atlas.paper_trade_events,
  signal_atlas.correction_events,
  signal_atlas.scanner_runs,
  signal_atlas.scanner_health_events,
  signal_atlas.current_champions,
  signal_atlas.prediction_outcomes
to anon, authenticated, service_role;

grant execute on function signal_atlas.trade_result(signal_atlas.direction_code, numeric, numeric)
to anon, authenticated, service_role;
grant execute on function signal_atlas.trade_pnl(signal_atlas.direction_code, numeric, numeric, numeric, numeric, numeric, signal_atlas.tie_policy_code)
to anon, authenticated, service_role;

revoke all on public.signal_atlas_latest,
  public.signal_atlas_opportunities,
  public.signal_atlas_metrics,
  public.signal_atlas_paper_summary,
  public.signal_atlas_health
from public, anon, authenticated, service_role;
grant select on public.signal_atlas_latest,
  public.signal_atlas_opportunities,
  public.signal_atlas_metrics,
  public.signal_atlas_paper_summary,
  public.signal_atlas_health
to anon, authenticated, service_role;

do $$
declare
  v_proc record;
begin
  for v_proc in
    select p.oid::pg_catalog.regprocedure as signature, p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'sa\_%' escape '\'
  loop
    execute pg_catalog.format('revoke execute on function %s from public, anon, authenticated, service_role', v_proc.signature);
    if v_proc.proname = 'sa_segment_metrics' then
      execute pg_catalog.format('grant execute on function %s to anon, authenticated, service_role', v_proc.signature);
    else
      execute pg_catalog.format('grant execute on function %s to service_role', v_proc.signature);
    end if;
  end loop;
end
$$;

insert into signal_atlas.assets(symbol, market, source, provider_symbol, metadata)
values
  ('BTCUSDT', 'crypto', 'binance', 'BTCUSDT', '{"label":"Bitcoin / USDT"}'::jsonb),
  ('ETHUSDT', 'crypto', 'binance', 'ETHUSDT', '{"label":"Ethereum / USDT"}'::jsonb),
  ('BNBUSDT', 'crypto', 'binance', 'BNBUSDT', '{"label":"BNB / USDT"}'::jsonb),
  ('SOLUSDT', 'crypto', 'binance', 'SOLUSDT', '{"label":"Solana / USDT"}'::jsonb),
  ('EURUSD=X', 'forex', 'yahoo', 'EURUSD=X', '{"label":"EUR / USD"}'::jsonb),
  ('GBPUSD=X', 'forex', 'yahoo', 'GBPUSD=X', '{"label":"GBP / USD"}'::jsonb),
  ('USDJPY=X', 'forex', 'yahoo', 'USDJPY=X', '{"label":"USD / JPY"}'::jsonb),
  ('AUDUSD=X', 'forex', 'yahoo', 'AUDUSD=X', '{"label":"AUD / USD"}'::jsonb)
on conflict (symbol) do nothing;

with policy_seed(policy_key, mode, version, effective_from, notes, config) as (
  values
    (
      'global-v1', 'conservador'::signal_atlas.mode_code, 1,
      '2026-08-26 00:00:00+00'::timestamptz,
      'Seed conservador: exige maior evidência e EV conservador positivo.',
      '{
        "min_score":72,
        "min_probability":0.60,
        "min_probability_lb":0.52,
        "min_confluence":4,
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
      'global-v1', 'neutro'::signal_atlas.mode_code, 1,
      '2026-08-26 00:00:00+00'::timestamptz,
      'Seed neutro: equilíbrio entre cobertura e evidência prospectiva.',
      '{
        "min_score":62,
        "min_probability":0.55,
        "min_probability_lb":0.50,
        "min_confluence":3,
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
      'global-v1', 'agressivo'::signal_atlas.mode_code, 1,
      '2026-08-26 00:00:00+00'::timestamptz,
      'Seed agressivo: maior cobertura, sem dispensar validação estatística.',
      '{
        "min_score":54,
        "min_probability":0.51,
        "min_probability_lb":0.48,
        "min_confluence":2,
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
  policy_key, mode, version, config, pg_catalog.md5(config::text), effective_from, notes
from policy_seed
on conflict (policy_key, mode, version) do nothing;

comment on schema signal_atlas is 'Private append-only Signal Atlas validation ledger. Do not expose this schema through the Data API.';
comment on table signal_atlas.decision_events is 'Prospective predictions frozen before entry_at; corrections are separate events.';
comment on table signal_atlas.model_deployment_events is 'Event-sourced champion history; current champion is always derived, never updated in place.';
comment on view public.signal_atlas_opportunities is 'Only current champion decisions whose entry window is still in the future.';

commit;
