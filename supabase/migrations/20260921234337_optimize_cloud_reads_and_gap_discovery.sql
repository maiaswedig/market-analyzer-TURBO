-- Read performance only: no decision, outcome or promotion is rewritten.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';
create index if not exists decision_resolution_cover_idx
  on signal_atlas.decision_events(expiry_at, id) include (asset_id, timeframe, entry_at);
create index if not exists decision_canonical_lookup_idx
  on signal_atlas.decision_events(asset_id, timeframe, mode, model_artifact_id, decision_at desc, id desc)
  where model_role = 'champion';
CREATE OR REPLACE FUNCTION signal_atlas.cloud_canonical_signal_rows()
 RETURNS TABLE(id uuid, symbol text, market text, timeframe text, mode text, direction text, expiration text, quality text, status text, score numeric, grade text, probability numeric, probability_lb numeric, sample_size integer, ev_net numeric, ev_lb95 numeric, confluence_count integer, reference_price numeric, decision_at timestamp with time zone, entry_at timestamp with time zone, expiry_at timestamp with time zone, data_age_ms integer, source_latency_ms integer, used_live_candle boolean, source text, reasons jsonb, champion_promoted_prospectively boolean, promotion_review_id uuid, promotion_paired_samples integer, confirmed_pass boolean, quality_contract_version integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  select d.*, a.symbol, a.market, 1 as rn
  from champions c
  join signal_atlas.assets a on a.id = c.asset_id and a.active
  cross join pg_catalog.unnest(pg_catalog.enum_range(null::signal_atlas.mode_code)) modes(mode)
  cross join lateral (
    select d.*
    from signal_atlas.decision_events d
    where d.asset_id = c.asset_id and d.timeframe = c.timeframe
      and d.model_artifact_id = c.model_artifact_id
      and d.mode = modes.mode and d.model_role = 'champion'
      and not exists (
        select 1 from signal_atlas.correction_events x
        where x.target_type = 'decision' and x.target_id = d.id
          and x.correction_type = 'invalidate'
      )
    order by d.decision_at desc, d.id desc
    limit 1
  ) d
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
$function$

;
CREATE OR REPLACE FUNCTION signal_atlas.claim_due_candle_gaps_at(p_as_of timestamp with time zone, p_run_id uuid, p_limit integer DEFAULT 6)
 RETURNS SETOF signal_atlas.candle_gaps
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_as_of is null or p_as_of > pg_catalog.clock_timestamp() then
    raise exception using errcode = '23514',
      message = 'gap clock must be present and cannot be in the future';
  end if;
  if p_run_id is null then
    raise exception using errcode = '22023', message = 'run id is required';
  end if;
  if p_limit < 1 or p_limit > 24 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 24';
  end if;

  -- Discover unresolved decisions once using the narrow covering index.
  -- Keep the entire historical horizon and all terminal/invalidation exclusions.
  with unresolved as materialized (
    select d.id, d.asset_id, d.timeframe, d.entry_at, d.expiry_at
    from signal_atlas.decision_events d
    where d.expiry_at <= p_as_of
      and not exists (select 1 from signal_atlas.outcomes o where o.decision_event_id = d.id)
      and not exists (select 1 from signal_atlas.resolution_abandonments a where a.decision_event_id = d.id)
      and not exists (
        select 1 from signal_atlas.correction_events ce
        where ce.target_type = 'decision' and ce.target_id = d.id and ce.correction_type = 'invalidate'
      )
  ), missing as (
    select d.asset_id, d.timeframe, 'entry'::text as missing_kind, d.entry_at as missing_time
    from unresolved d
    where not exists (
      select 1 from signal_atlas.candles c where c.asset_id = d.asset_id
        and c.timeframe = d.timeframe and c.open_time = d.entry_at and c.is_closed
    )
    union
    select d.asset_id, d.timeframe, 'expiry'::text, d.expiry_at
    from unresolved d
    where not exists (
      select 1 from signal_atlas.candles c where c.asset_id = d.asset_id
        and c.timeframe = d.timeframe and c.close_time = d.expiry_at and c.is_closed
    )
  )
  insert into signal_atlas.candle_gaps(asset_id, timeframe, missing_kind, missing_time)
  select asset_id, timeframe, missing_kind, missing_time from missing
  on conflict (asset_id, timeframe, missing_kind, missing_time) do nothing;

  return query
  with due as (
    select g.id
    from signal_atlas.candle_gaps g
    where g.status = 'pending'
      and g.next_retry_at <= p_as_of
      and (g.lease_token is null or g.lease_expires_at <= p_as_of or g.lease_token = p_run_id)
      and exists (
        select 1
        from signal_atlas.decision_events d
        where d.asset_id = g.asset_id and d.timeframe = g.timeframe
          and d.expiry_at <= p_as_of
          and not exists (
            select 1 from signal_atlas.outcomes o where o.decision_event_id = d.id
          )
          and not exists (
            select 1 from signal_atlas.resolution_abandonments a where a.decision_event_id = d.id
          )
          and (
            (g.missing_kind = 'entry' and d.entry_at = g.missing_time)
            or (g.missing_kind = 'expiry' and d.expiry_at = g.missing_time)
          )
      )
    order by g.next_retry_at, g.first_detected_at, g.id
    limit p_limit
    for update skip locked
  ), claimed as (
    update signal_atlas.candle_gaps g
    set lease_token = p_run_id,
        lease_expires_at = p_as_of + interval '90 seconds'
    from due
    where g.id = due.id
    returning g.*
  )
  select c.* from claimed c
  order by c.next_retry_at, c.first_detected_at, c.id;
end
$function$

;
commit;
