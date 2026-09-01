-- Make outcome resolution honor the caller's frozen clock and make automatic
-- challenger reviews repeatable.  The worker may retry a cycle; retries with
-- no newly resolved pair must point to the same immutable review row.

begin;

create or replace function signal_atlas.resolve_ready_decisions_at(
  p_as_of timestamptz,
  p_limit integer default 100
)
returns table(decision_event_id uuid, outcome_id uuid, resolution_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  if p_as_of is null or p_as_of > pg_catalog.clock_timestamp() then
    raise exception using errcode = '23514', message = 'resolution clock must be present and cannot be in the future';
  end if;
  if p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 1000';
  end if;

  for v_row in
    select d.id
    from signal_atlas.decision_events d
    where d.expiry_at <= p_as_of
      and not exists (
        select 1 from signal_atlas.outcomes o
        where o.decision_event_id = d.id
      )
      and exists (
        select 1 from signal_atlas.candles c
        where c.asset_id = d.asset_id
          and c.timeframe = d.timeframe
          and c.open_time = d.entry_at
          and c.is_closed
      )
      and exists (
        select 1 from signal_atlas.candles c
        where c.asset_id = d.asset_id
          and c.timeframe = d.timeframe
          and c.close_time = d.expiry_at
          and c.is_closed
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
  if p_run_id is null then
    raise exception using errcode = '22023', message = 'run id is required';
  end if;
  if p_as_of is null or p_as_of > pg_catalog.clock_timestamp() then
    raise exception using errcode = '23514', message = 'resolution clock must be present and cannot be in the future';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
  into v_rows
  from signal_atlas.resolve_ready_decisions_at(p_as_of, 250) x;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'asOf', p_as_of,
    'runId', p_run_id,
    'resolved', pg_catalog.jsonb_array_length(v_rows),
    'rows', v_rows
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
  v_end timestamptz;
  v_review record;
  v_reviews jsonb := '[]'::jsonb;
begin
  if p_min_resolved < 300 then
    raise exception using errcode = '23514', message = 'prospective promotion requires at least 300 paired outcomes';
  end if;
  -- review_challenger stores LB95/UB95 and therefore uses the two-sided 95%
  -- normal critical value.  Reject a misleading caller-supplied value instead
  -- of silently ignoring it.
  if p_z_margin is null or pg_catalog.abs(p_z_margin - 1.96) > 0.000001 then
    raise exception using errcode = '23514', message = 'promotion review requires z margin 1.96 for its documented 95% interval';
  end if;
  if p_as_of is null or p_as_of > pg_catalog.clock_timestamp() then
    raise exception using errcode = '23514', message = 'review clock must be present and cannot be in the future';
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
    v_champion_id := signal_atlas.current_champion_model(
      v_candidate.asset_id,
      v_candidate.timeframe,
      p_as_of
    );
    if v_champion_id is null or v_champion_id = v_candidate.id then
      continue;
    end if;

    select
      pg_catalog.count(*)::integer,
      pg_catalog.min(d.entry_at),
      pg_catalog.max(o.resolved_at)
    into v_n, v_start, v_end
    from signal_atlas.shadow_predictions s
    join signal_atlas.decision_events d on d.id = s.decision_event_id
    join signal_atlas.outcomes o on o.decision_event_id = d.id
    where s.model_artifact_id = v_candidate.id
      and d.model_artifact_id = v_champion_id
      and d.entry_at < p_as_of
      and o.resolved_at <= p_as_of
      and not exists (
        select 1 from signal_atlas.correction_events c
        where c.correction_type = 'invalidate'
          and (
            (c.target_type = 'decision' and c.target_id = d.id)
            or (c.target_type = 'shadow_prediction' and c.target_id = s.id)
            or (c.target_type = 'outcome' and c.target_id = o.id)
          )
      );

    if v_n < p_min_resolved or v_start is null or v_end is null or v_start >= v_end then
      continue;
    end if;

    select * into v_review
    from signal_atlas.review_challenger(
      v_candidate.asset_id,
      v_candidate.timeframe,
      v_candidate.id,
      v_start,
      v_end,
      true,
      'auto-promote|' || v_candidate.symbol || '|' || v_candidate.timeframe::text || '|' || v_candidate.id::text,
      1.20,
      0
    );
    v_reviews := v_reviews || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_review));
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'asOf', p_as_of,
    'minimumPaired', p_min_resolved,
    'zRequested', p_z_margin,
    'criterion', '95% lower bound of paired delta EV > 0; Brier not worse; drawdown <= 1.20x',
    'reviews', v_reviews
  );
end
$$;

revoke all on function signal_atlas.resolve_ready_decisions_at(timestamptz,integer)
from public, anon, authenticated;
grant execute on function signal_atlas.resolve_ready_decisions_at(timestamptz,integer)
to service_role;

revoke execute on function public.resolve_due_outcomes(timestamptz,uuid),
  public.review_and_promote_challengers(timestamptz,integer,numeric,text,text)
from public, anon, authenticated;
grant execute on function public.resolve_due_outcomes(timestamptz,uuid),
  public.review_and_promote_challengers(timestamptz,integer,numeric,text,text)
to service_role;

comment on function signal_atlas.resolve_ready_decisions_at(timestamptz,integer) is
  'Resolves only exact, closed outcomes due at the immutable caller-supplied clock.';
comment on function public.review_and_promote_challengers(timestamptz,integer,numeric,text,text) is
  'Reviews prospective paired shadows at a deterministic last-resolved boundary; retries without new outcomes are idempotent.';

commit;
