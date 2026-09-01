-- Security/release hardening for the internal Edge workers and public API.
--
-- Deployment is intentionally two-phase.  This migration pauses the two
-- historical jobs and installs explicit activate/deactivate functions.  The
-- operator must first configure the matching Edge/Vault secrets and deploy
-- all three functions, then call signal_atlas.activate_schedules().

begin;

-- Declare every non-core dependency used by the migrations and scheduler.
-- Vault is a Supabase-managed security extension: require it instead of
-- trying to create or relocate it implicitly.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_extension where extname = 'supabase_vault'
  ) or pg_catalog.to_regclass('vault.decrypted_secrets') is null then
    raise exception using
      errcode = '55000',
      message = 'Supabase Vault must be enabled before Signal Atlas scheduling is configured';
  end if;
end
$$;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
revoke all on schema cron, vault from public, anon, authenticated;
revoke all on all tables in schema cron, vault from public, anon, authenticated;

-- Stop the legacy schedules.  No migration should invoke an endpoint before
-- its function and both independent credentials are present.
do $$
declare
  v_job record;
begin
  for v_job in
    select j.jobid
    from cron.job j
    where j.jobname in ('signal-atlas-market-cycle', 'signal-atlas-train-challenger')
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end
$$;

create or replace function signal_atlas.activate_schedules()
returns table(job_name text, job_id bigint)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_project_url text;
  v_cron_jwt text;
  v_cron_secret text;
  v_jwt_parts text[];
  v_jwt_payload jsonb;
  v_existing record;
  v_market_job_id bigint;
  v_train_job_id bigint;
begin
  select d.decrypted_secret into v_project_url
  from vault.decrypted_secrets d where d.name = 'signal_atlas_project_url';
  select d.decrypted_secret into v_cron_jwt
  from vault.decrypted_secrets d where d.name = 'signal_atlas_cron_jwt';
  select d.decrypted_secret into v_cron_secret
  from vault.decrypted_secrets d where d.name = 'signal_atlas_cron_secret';

  if v_project_url is null
    or v_cron_jwt is null
    or v_cron_secret is null then
    raise exception using
      errcode = '55000',
      message = 'Required Signal Atlas Vault entries are missing';
  end if;
  if v_project_url !~ '^https://[a-z0-9-]+[.]supabase[.]co/?$' then
    raise exception using
      errcode = '22023',
      message = 'signal_atlas_project_url is not a valid hosted Supabase URL';
  end if;
  if pg_catalog.length(v_cron_secret) < 32
    or pg_catalog.length(v_cron_secret) > 512
    or v_cron_secret = v_cron_jwt then
    raise exception using
      errcode = '22023',
      message = 'signal_atlas_cron_secret must be an independent high-entropy secret';
  end if;

  -- The gateway verifies this JWT cryptographically.  Supabase's documented
  -- cron pattern uses a public anon JWT; service_role is accepted for backwards
  -- compatibility, but is neither required nor recommended in Vault.  An
  -- authenticated user-session JWT is always rejected.
  v_jwt_parts := pg_catalog.string_to_array(v_cron_jwt, '.');
  if pg_catalog.array_length(v_jwt_parts, 1) <> 3 then
    raise exception using errcode = '22023', message = 'signal_atlas_cron_jwt is not a JWT';
  end if;
  begin
    v_jwt_payload := pg_catalog.convert_from(
      pg_catalog.decode(
        pg_catalog.translate(v_jwt_parts[2], '-_', '+/') ||
          pg_catalog.repeat('=', (4 - pg_catalog.length(v_jwt_parts[2]) % 4) % 4),
        'base64'
      ),
      'UTF8'
    )::jsonb;
  exception when others then
    raise exception using errcode = '22023', message = 'signal_atlas_cron_jwt has an invalid payload';
  end;
  if coalesce(v_jwt_payload->>'role', '') not in ('anon', 'service_role') then
    raise exception using
      errcode = '42501',
      message = 'signal_atlas_cron_jwt must carry an anon or service_role worker claim';
  end if;

  for v_existing in
    select j.jobid
    from cron.job j
    where j.jobname in ('signal-atlas-market-cycle', 'signal-atlas-train-challenger')
  loop
    perform cron.unschedule(v_existing.jobid);
  end loop;

  v_market_job_id := cron.schedule(
    'signal-atlas-market-cycle',
    '* * * * *',
    $market_job$
      select net.http_post(
        url := pg_catalog.rtrim(
          (select d.decrypted_secret from vault.decrypted_secrets d
           where d.name = 'signal_atlas_project_url'), '/'
        ) || '/functions/v1/market-cycle',
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' ||
            (select d.decrypted_secret from vault.decrypted_secrets d
             where d.name = 'signal_atlas_cron_jwt'),
          'X-Signal-Atlas-Cron-Secret',
            (select d.decrypted_secret from vault.decrypted_secrets d
             where d.name = 'signal_atlas_cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $market_job$
  );

  v_train_job_id := cron.schedule(
    'signal-atlas-train-challenger',
    '7 * * * *',
    $train_job$
      select net.http_post(
        url := pg_catalog.rtrim(
          (select d.decrypted_secret from vault.decrypted_secrets d
           where d.name = 'signal_atlas_project_url'), '/'
        ) || '/functions/v1/train-challenger',
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' ||
            (select d.decrypted_secret from vault.decrypted_secrets d
             where d.name = 'signal_atlas_cron_jwt'),
          'X-Signal-Atlas-Cron-Secret',
            (select d.decrypted_secret from vault.decrypted_secrets d
             where d.name = 'signal_atlas_cron_secret')
        ),
        body := '{"minValidation":300,"maxCandles":3500,"epochs":80}'::jsonb,
        timeout_milliseconds := 120000
      );
    $train_job$
  );

  return query values
    ('signal-atlas-market-cycle'::text, v_market_job_id),
    ('signal-atlas-train-challenger'::text, v_train_job_id);
end
$function$;

create or replace function signal_atlas.deactivate_schedules()
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_job record;
  v_count integer := 0;
begin
  for v_job in
    select j.jobid
    from cron.job j
    where j.jobname in ('signal-atlas-market-cycle', 'signal-atlas-train-challenger')
  loop
    perform cron.unschedule(v_job.jobid);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$function$;

revoke all on function signal_atlas.activate_schedules()
  from public, anon, authenticated, service_role;
revoke all on function signal_atlas.deactivate_schedules()
  from public, anon, authenticated, service_role;
grant execute on function signal_atlas.activate_schedules() to postgres;
grant execute on function signal_atlas.deactivate_schedules() to postgres;

-- SECURITY DEFINER is isolated in the private schema, has no arguments or
-- dynamic SQL, fixes search_path and returns only the explicit browser-safe
-- columns.  The public views remain security_invoker and callers receive no
-- privileges on the underlying ledger tables.
create or replace function signal_atlas.cloud_segment_metrics_rows()
returns table(
  symbol text,
  timeframe text,
  direction text,
  expiration text,
  mode text,
  resolved bigint,
  wins bigint,
  losses bigint,
  ties bigint,
  win_rate numeric,
  brier_score numeric,
  ev_net_per_trade numeric,
  ev_net_lb95 numeric,
  total_pnl numeric,
  first_entry_at timestamptz,
  last_expiry_at timestamptz,
  benchmark_win_rate numeric,
  benchmark_ev_per_trade numeric,
  edge_vs_benchmark numeric,
  minimum_profitable_win_rate numeric,
  sample_status text
)
language sql
security definer
set search_path = ''
as $function$
with resolved as (
  select
    a.symbol,
    d.timeframe,
    d.direction,
    d.expiration,
    d.mode,
    d.probability,
    d.payout_ratio,
    d.operation_cost,
    d.entry_at,
    d.expiry_at,
    e.result,
    e.pnl
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  join signal_atlas.assets a on a.id = d.asset_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
    and not exists (
      select 1 from signal_atlas.correction_events c
      where c.correction_type = 'invalidate'
        and ((c.target_type = 'decision' and c.target_id = d.id)
          or (c.target_type = 'paper_trade' and c.target_id = t.id)
          or (c.target_type = 'outcome' and c.target_id = e.outcome_id))
    )
), metrics as (
  select
    r.symbol,
    r.timeframe,
    r.direction,
    r.expiration,
    r.mode,
    pg_catalog.count(*)::bigint as resolved,
    pg_catalog.count(*) filter (where r.result = 'win')::bigint as wins,
    pg_catalog.count(*) filter (where r.result = 'loss')::bigint as losses,
    pg_catalog.count(*) filter (where r.result = 'tie')::bigint as ties,
    pg_catalog.avg((r.result = 'win')::integer::numeric) as win_rate,
    pg_catalog.avg(pg_catalog.power(r.probability - (r.result = 'win')::integer, 2)) as brier_score,
    pg_catalog.avg(r.pnl) as ev_net_per_trade,
    case when pg_catalog.count(*) >= 2 then
      pg_catalog.avg(r.pnl) - 1.96 * pg_catalog.stddev_samp(r.pnl)
        / pg_catalog.sqrt(pg_catalog.count(*)::numeric)
    end as ev_net_lb95,
    pg_catalog.sum(r.pnl) as total_pnl,
    pg_catalog.min(r.entry_at) as first_entry_at,
    pg_catalog.max(r.expiry_at) as last_expiry_at,
    pg_catalog.avg(0.5 * r.payout_ratio - 0.5 - r.operation_cost)::numeric
      as benchmark_ev_per_trade,
    pg_catalog.avg((1 + r.operation_cost) / nullif(1 + r.payout_ratio, 0))::numeric
      as minimum_profitable_win_rate
  from resolved r
  group by r.symbol, r.timeframe, r.direction, r.expiration, r.mode
)
select
  m.symbol,
  m.timeframe::text as timeframe,
  m.direction::text as direction,
  m.expiration::text as expiration,
  m.mode::text as mode,
  m.resolved,
  m.wins,
  m.losses,
  m.ties,
  m.win_rate,
  m.brier_score,
  m.ev_net_per_trade,
  m.ev_net_lb95,
  m.total_pnl,
  m.first_entry_at,
  m.last_expiry_at,
  0.5::numeric as benchmark_win_rate,
  m.benchmark_ev_per_trade,
  (m.ev_net_per_trade - m.benchmark_ev_per_trade)::numeric as edge_vs_benchmark,
  m.minimum_profitable_win_rate,
  case when m.resolved >= 300 then 'prospective_validated' else 'building_sample' end::text
    as sample_status
from metrics m
$function$;

create or replace view public.cloud_segment_metrics
with (security_invoker = true)
as
select * from signal_atlas.cloud_segment_metrics_rows();

create or replace function signal_atlas.cloud_opportunities_rows()
returns table(
  id uuid,
  symbol text,
  market signal_atlas.market_code,
  timeframe text,
  mode text,
  direction text,
  expiration text,
  quality text,
  score numeric,
  probability numeric,
  sample_size integer,
  ev_net numeric,
  decision_at timestamptz,
  entry_at timestamptz,
  expiry_at timestamptz,
  data_age_ms integer,
  source_latency_ms integer,
  used_live_candle boolean,
  reason text,
  rank bigint,
  grade text,
  resolved bigint,
  historical_win_rate numeric,
  historical_ev_net numeric,
  benchmark_win_rate numeric,
  benchmark_ev_per_trade numeric,
  probability_lb numeric,
  shrunk_win_rate numeric,
  ranking_score numeric,
  sample_status text
)
language sql
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
    and pg_catalog.clock_timestamp() >= d.decision_at
    and pg_catalog.clock_timestamp() < d.entry_at
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
    pg_catalog.avg(e.pnl) as ev_net_per_trade
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
    and not exists (
      select 1 from signal_atlas.correction_events x
      where x.correction_type = 'invalidate'
        and ((x.target_type = 'decision' and x.target_id = d.id)
          or (x.target_type = 'paper_trade' and x.target_id = t.id)
          or (x.target_type = 'outcome' and x.target_id = e.outcome_id))
    )
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
    0.5::numeric as benchmark_win_rate,
    (0.5 * v.payout_ratio - 0.5 - v.operation_cost)::numeric
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
$function$;

create or replace view public.cloud_opportunities
with (security_invoker = true)
as
select * from signal_atlas.cloud_opportunities_rows();

create or replace function signal_atlas.cloud_latest_decisions_rows()
returns table(
  id uuid,
  symbol text,
  market text,
  timeframe text,
  mode text,
  direction text,
  expiration text,
  quality text,
  score numeric,
  probability numeric,
  sample_size integer,
  ev_net numeric,
  decision_at timestamptz,
  entry_at timestamptz,
  expiry_at timestamptz,
  data_age_ms integer,
  source_latency_ms integer,
  used_live_candle boolean,
  reason text,
  outcome text,
  resolved_at timestamptz
)
language sql
security definer
set search_path = ''
as $function$
  select
    d.id,
    a.symbol,
    a.market::text,
    d.timeframe::text,
    d.mode::text,
    d.direction::text,
    d.expiration::text,
    d.quality::text,
    d.score,
    d.probability,
    d.statistical_sample_size,
    d.expected_ev,
    d.decision_at,
    d.entry_at,
    d.expiry_at,
    d.data_age_ms,
    d.source_latency_ms,
    d.used_live_candle,
    coalesce(d.reasons->>0, 'Registro prospectivo congelado antes da entrada.'),
    o.decision_result::text,
    o.resolved_at
  from signal_atlas.decision_events d
  join signal_atlas.assets a on a.id = d.asset_id
  left join signal_atlas.outcomes o on o.decision_event_id = d.id
  where d.model_role = 'champion'
    and not exists (
      select 1 from signal_atlas.correction_events c
      where c.target_type = 'decision'
        and c.target_id = d.id
        and c.correction_type = 'invalidate'
    )
$function$;

create or replace view public.cloud_latest_decisions
with (security_invoker = true)
as
select * from signal_atlas.cloud_latest_decisions_rows();

create or replace function signal_atlas.cloud_paper_summary_rows()
returns table(
  trades bigint,
  ev_net_per_trade numeric,
  total_pnl numeric,
  max_drawdown numeric,
  updated_at timestamptz,
  mode text,
  benchmark_ev_per_trade numeric,
  edge_vs_benchmark numeric
)
language sql
security definer
set search_path = ''
as $function$
  with modes(mode) as (
    values
      ('conservador'::signal_atlas.mode_code),
      ('neutro'::signal_atlas.mode_code),
      ('agressivo'::signal_atlas.mode_code)
  ), events as (
    select
      d.mode,
      e.event_at,
      e.paper_trade_id,
      e.pnl,
      d.payout_ratio,
      d.operation_cost,
      pg_catalog.sum(e.pnl) over (
        partition by d.mode
        order by e.event_at, e.paper_trade_id rows unbounded preceding
      ) as equity
    from signal_atlas.paper_trade_events e
    join signal_atlas.paper_trades t on t.id = e.paper_trade_id
    join signal_atlas.decision_events d on d.id = t.decision_event_id
    where e.event_type = 'resolved'::signal_atlas.paper_event_code
      and not exists (
        select 1 from signal_atlas.correction_events c
        where c.correction_type = 'invalidate'
          and ((c.target_type = 'decision' and c.target_id = d.id)
            or (c.target_type = 'paper_trade' and c.target_id = t.id)
            or (c.target_type = 'outcome' and c.target_id = e.outcome_id))
      )
  ), curve as (
    select
      e.*,
      greatest(
        0::numeric,
        pg_catalog.max(e.equity) over (
          partition by e.mode
          order by e.event_at, e.paper_trade_id rows unbounded preceding
        )
      ) - e.equity as drawdown
    from events e
  )
  select
    pg_catalog.count(c.paper_trade_id)::bigint,
    pg_catalog.avg(c.pnl),
    coalesce(pg_catalog.sum(c.pnl), 0::numeric),
    coalesce(pg_catalog.max(c.drawdown), 0::numeric),
    pg_catalog.max(c.event_at),
    m.mode::text,
    coalesce(pg_catalog.avg(0.5 * c.payout_ratio - 0.5 - c.operation_cost), -0.095)::numeric,
    (
      pg_catalog.avg(c.pnl)
      - coalesce(pg_catalog.avg(0.5 * c.payout_ratio - 0.5 - c.operation_cost), -0.095)
    )::numeric
  from modes m
  left join curve c on c.mode = m.mode
  group by m.mode
$function$;

create or replace view public.cloud_paper_summary
with (security_invoker = true)
as
select * from signal_atlas.cloud_paper_summary_rows();

create or replace function signal_atlas.cloud_system_health_rows()
returns table(
  processed_asset text,
  timeframe text,
  last_collection_at timestamptz,
  resolved_prospective_signals bigint,
  status text,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
as $function$
  with latest_run as (
    select r.*
    from signal_atlas.scanner_runs r
    order by r.finished_at desc, r.id desc
    limit 1
  ), counts as (
    select pg_catalog.count(*)::bigint as resolved
    from signal_atlas.outcomes
  )
  select
    coalesce(r.details->>'last_symbol', '—'),
    coalesce(r.details->>'last_timeframe', ''),
    r.finished_at,
    c.resolved,
    coalesce(r.status::text, 'initializing'),
    r.finished_at
  from counts c
  left join latest_run r on true
$function$;

create or replace view public.cloud_system_health
with (security_invoker = true)
as
select * from signal_atlas.cloud_system_health_rows();

-- Remove the broad legacy read API.  The five cloud_* views are the only
-- browser-facing database objects.  Their private, argument-free projection
-- functions are the only capability granted in signal_atlas; no browser role
-- receives SELECT on a ledger table.
revoke all on public.signal_atlas_latest,
  public.signal_atlas_opportunities,
  public.signal_atlas_metrics,
  public.signal_atlas_paper_summary,
  public.signal_atlas_health
from public, anon, authenticated, service_role;

revoke execute on function public.sa_segment_metrics(text, text)
from public, anon, authenticated;

revoke all on all tables in schema signal_atlas from public, anon, authenticated;
revoke all on all sequences in schema signal_atlas from public, anon, authenticated;
revoke execute on all functions in schema signal_atlas from public, anon, authenticated;

drop policy if exists public_read_assets on signal_atlas.assets;
drop policy if exists public_read_deployments on signal_atlas.model_deployment_events;
drop policy if exists public_read_decisions on signal_atlas.decision_events;
drop policy if exists public_read_shadows on signal_atlas.shadow_predictions;
drop policy if exists public_read_outcomes on signal_atlas.outcomes;
drop policy if exists public_read_paper_trades on signal_atlas.paper_trades;
drop policy if exists public_read_paper_events on signal_atlas.paper_trade_events;
drop policy if exists public_read_corrections on signal_atlas.correction_events;
drop policy if exists public_read_scanner_runs on signal_atlas.scanner_runs;
drop policy if exists public_read_scanner_health on signal_atlas.scanner_health_events;

revoke all on schema signal_atlas from public, anon, authenticated;
grant usage on schema signal_atlas to anon, authenticated, service_role;
grant execute on function signal_atlas.cloud_latest_decisions_rows(),
  signal_atlas.cloud_opportunities_rows(),
  signal_atlas.cloud_segment_metrics_rows(),
  signal_atlas.cloud_paper_summary_rows(),
  signal_atlas.cloud_system_health_rows()
to anon, authenticated, service_role;

do $$
declare
  v_proc record;
begin
  for v_proc in
    select p.oid::pg_catalog.regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'sa\_%' escape '\'
        or p.proname in (
          'ingest_candles', 'create_model_artifact', 'register_market_decision',
          'resolve_due_outcomes', 'review_and_promote_challengers', 'record_scanner_run'
        ))
  loop
    execute pg_catalog.format(
      'revoke execute on function %s from public, anon, authenticated',
      v_proc.signature
    );
  end loop;
end
$$;

-- The service role reaches the ledger only through the narrow, audited worker
-- RPCs.  Revoke every legacy sa_* helper as well, otherwise a compromised
-- worker could bypass the append-only contracts through an older function.
do $$
declare
  v_proc record;
begin
  for v_proc in
    select p.oid::pg_catalog.regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'sa\_%' escape '\'
  loop
    execute pg_catalog.format(
      'revoke execute on function %s from service_role',
      v_proc.signature
    );
  end loop;
end
$$;

revoke all on public.cloud_latest_decisions,
  public.cloud_opportunities,
  public.cloud_segment_metrics,
  public.cloud_paper_summary,
  public.cloud_system_health
from public, anon, authenticated, service_role;
grant select on public.cloud_latest_decisions,
  public.cloud_opportunities,
  public.cloud_segment_metrics,
  public.cloud_paper_summary,
  public.cloud_system_health
to anon, authenticated, service_role;

alter default privileges in schema signal_atlas
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema signal_atlas
  revoke all on sequences from public, anon, authenticated;
alter default privileges in schema signal_atlas
  revoke execute on functions from public, anon, authenticated;

comment on function signal_atlas.activate_schedules() is
  'Explicit post-deploy activation. Requires project URL, a gateway-valid anon/service JWT and an independent cron secret in Vault.';
comment on view public.cloud_segment_metrics is
  'Prospective paper outcomes only; no dependency on the revoked legacy public views.';
comment on view public.cloud_opportunities is
  'Prospective current-champion opportunities ranked against causal paper history; legacy public views are not exposed.';

commit;
