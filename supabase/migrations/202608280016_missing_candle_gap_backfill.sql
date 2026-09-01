begin;

-- Targeted, causal candle-gap recovery.
-- Migrations 014/015 already belong to the independent shadow laboratory;
-- this feature is intentionally migration 016 so deployed history is never
-- rewritten. Missing prices are never interpolated and a terminally abandoned
-- decision can never receive an outcome later.

create table if not exists signal_atlas.candle_gaps (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  asset_id uuid not null references signal_atlas.assets(id),
  timeframe signal_atlas.timeframe_code not null,
  missing_kind text not null check (missing_kind in ('entry', 'expiry')),
  missing_time timestamptz not null,
  first_detected_at timestamptz not null default pg_catalog.clock_timestamp(),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  next_retry_at timestamptz not null default pg_catalog.clock_timestamp(),
  status text not null default 'pending'
    check (status in ('pending', 'resolved', 'permanently_missing')),
  resolved_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (asset_id, timeframe, missing_kind, missing_time),
  check (
    (status = 'resolved' and resolved_at is not null)
    or (status <> 'resolved' and resolved_at is null)
  ),
  check ((lease_token is null) = (lease_expires_at is null))
);

create table if not exists signal_atlas.candle_gap_attempts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  candle_gap_id uuid not null references signal_atlas.candle_gaps(id),
  run_id uuid not null,
  attempted_at timestamptz not null,
  attempt_number integer not null check (attempt_number >= 1),
  result text not null check (result in ('resolved', 'missing', 'permanently_missing')),
  next_retry_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (candle_gap_id, run_id)
);

create table if not exists signal_atlas.resolution_abandonments (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  decision_event_id uuid not null unique references signal_atlas.decision_events(id),
  candle_gap_id uuid not null references signal_atlas.candle_gaps(id),
  abandoned_at timestamptz not null,
  reason text not null check (reason = 'provider_candle_permanently_missing'),
  attempt_count integer not null check (attempt_count >= 1),
  first_detected_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index if not exists candle_gaps_due_idx
  on signal_atlas.candle_gaps (next_retry_at, first_detected_at, id)
  where status = 'pending';

create index if not exists candle_gaps_asset_idx
  on signal_atlas.candle_gaps (asset_id, timeframe, missing_time);

create index if not exists candle_gap_attempts_gap_idx
  on signal_atlas.candle_gap_attempts (candle_gap_id, attempted_at desc);

create index if not exists resolution_abandonments_gap_idx
  on signal_atlas.resolution_abandonments (candle_gap_id, abandoned_at);

alter table signal_atlas.candle_gaps enable row level security;
alter table signal_atlas.candle_gaps force row level security;
alter table signal_atlas.candle_gap_attempts enable row level security;
alter table signal_atlas.candle_gap_attempts force row level security;
alter table signal_atlas.resolution_abandonments enable row level security;
alter table signal_atlas.resolution_abandonments force row level security;

drop trigger if exists candle_gap_attempts_append_only_guard on signal_atlas.candle_gap_attempts;
create trigger candle_gap_attempts_append_only_guard
before update or delete on signal_atlas.candle_gap_attempts
for each row execute function signal_atlas.reject_update_delete();

drop trigger if exists resolution_abandonments_append_only_guard on signal_atlas.resolution_abandonments;
create trigger resolution_abandonments_append_only_guard
before update or delete on signal_atlas.resolution_abandonments
for each row execute function signal_atlas.reject_update_delete();

create or replace function signal_atlas.reject_abandoned_outcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from signal_atlas.resolution_abandonments a
    where a.decision_event_id = new.decision_event_id
  ) then
    raise exception using errcode = '23514',
      message = 'terminally abandoned decision cannot receive a later outcome';
  end if;
  return new;
end
$$;

drop trigger if exists abandoned_outcome_guard on signal_atlas.outcomes;
create trigger abandoned_outcome_guard
before insert on signal_atlas.outcomes
for each row execute function signal_atlas.reject_abandoned_outcome();

create or replace function signal_atlas.reject_resolved_abandonment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from signal_atlas.outcomes o
    where o.decision_event_id = new.decision_event_id
  ) then
    raise exception using errcode = '23514',
      message = 'resolved decision cannot be terminally abandoned';
  end if;
  return new;
end
$$;

drop trigger if exists resolved_abandonment_guard on signal_atlas.resolution_abandonments;
create trigger resolved_abandonment_guard
before insert on signal_atlas.resolution_abandonments
for each row execute function signal_atlas.reject_resolved_abandonment();

create or replace function signal_atlas.claim_due_candle_gaps_at(
  p_as_of timestamptz,
  p_run_id uuid,
  p_limit integer default 6
)
returns setof signal_atlas.candle_gaps
language plpgsql
security definer
set search_path = ''
as $$
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

  insert into signal_atlas.candle_gaps(asset_id, timeframe, missing_kind, missing_time)
  select distinct d.asset_id, d.timeframe, 'entry', d.entry_at
  from signal_atlas.decision_events d
  where d.expiry_at <= p_as_of
    and not exists (
      select 1 from signal_atlas.outcomes o where o.decision_event_id = d.id
    )
    and not exists (
      select 1 from signal_atlas.resolution_abandonments a where a.decision_event_id = d.id
    )
    and not exists (
      select 1 from signal_atlas.correction_events ce
      where ce.target_type = 'decision' and ce.target_id = d.id
        and ce.correction_type = 'invalidate'
    )
    and not exists (
      select 1 from signal_atlas.candles c
      where c.asset_id = d.asset_id and c.timeframe = d.timeframe
        and c.open_time = d.entry_at and c.is_closed
    )
  on conflict (asset_id, timeframe, missing_kind, missing_time) do nothing;

  insert into signal_atlas.candle_gaps(asset_id, timeframe, missing_kind, missing_time)
  select distinct d.asset_id, d.timeframe, 'expiry', d.expiry_at
  from signal_atlas.decision_events d
  where d.expiry_at <= p_as_of
    and not exists (
      select 1 from signal_atlas.outcomes o where o.decision_event_id = d.id
    )
    and not exists (
      select 1 from signal_atlas.resolution_abandonments a where a.decision_event_id = d.id
    )
    and not exists (
      select 1 from signal_atlas.correction_events ce
      where ce.target_type = 'decision' and ce.target_id = d.id
        and ce.correction_type = 'invalidate'
    )
    and not exists (
      select 1 from signal_atlas.candles c
      where c.asset_id = d.asset_id and c.timeframe = d.timeframe
        and c.close_time = d.expiry_at and c.is_closed
    )
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
$$;

create or replace function signal_atlas.reconcile_candle_gaps_at(
  p_as_of timestamptz,
  p_run_id uuid,
  p_gap_ids uuid[]
)
returns table(gap_id uuid, gap_status text, attempt_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gap signal_atlas.candle_gaps%rowtype;
  v_found boolean;
  v_attempts integer;
  v_backoff_minutes integer;
  v_give_up boolean;
  v_result text;
  v_decision_id uuid;
begin
  if p_as_of is null or p_as_of > pg_catalog.clock_timestamp() then
    raise exception using errcode = '23514',
      message = 'gap clock must be present and cannot be in the future';
  end if;
  if p_run_id is null then
    raise exception using errcode = '22023', message = 'run id is required';
  end if;
  if pg_catalog.cardinality(coalesce(p_gap_ids, array[]::uuid[])) > 24 then
    raise exception using errcode = '22023', message = 'at most 24 gap ids may be reconciled';
  end if;

  for v_gap in
    select g.*
    from signal_atlas.candle_gaps g
    where g.id = any(coalesce(p_gap_ids, array[]::uuid[]))
      and g.status = 'pending'
      and g.lease_token = p_run_id
    order by g.id
    for update skip locked
  loop
    if exists (
      select 1 from signal_atlas.candle_gap_attempts a
      where a.candle_gap_id = v_gap.id and a.run_id = p_run_id
    ) then
      gap_id := v_gap.id;
      gap_status := v_gap.status;
      attempt_count := v_gap.attempts;
      return next;
      continue;
    end if;

    if v_gap.missing_kind = 'entry' then
      select exists (
        select 1 from signal_atlas.candles c
        where c.asset_id = v_gap.asset_id and c.timeframe = v_gap.timeframe
          and c.open_time = v_gap.missing_time and c.is_closed
      ) into v_found;
    else
      select exists (
        select 1 from signal_atlas.candles c
        where c.asset_id = v_gap.asset_id and c.timeframe = v_gap.timeframe
          and c.close_time = v_gap.missing_time and c.is_closed
      ) into v_found;
    end if;

    v_attempts := v_gap.attempts + 1;
    if v_found then
      update signal_atlas.candle_gaps
      set attempts = v_attempts,
          last_attempt_at = p_as_of,
          status = 'resolved',
          resolved_at = p_as_of,
          lease_token = null,
          lease_expires_at = null
      where id = v_gap.id;
      v_result := 'resolved';
    else
      v_backoff_minutes := least(
        360,
        (5 * pg_catalog.power(2, greatest(0, v_attempts - 1)))::integer
      );
      v_give_up := v_attempts >= 8
        or p_as_of - v_gap.first_detected_at >= interval '12 hours';
      v_result := case when v_give_up then 'permanently_missing' else 'missing' end;

      update signal_atlas.candle_gaps
      set attempts = v_attempts,
          last_attempt_at = p_as_of,
          next_retry_at = p_as_of + pg_catalog.make_interval(mins => v_backoff_minutes),
          status = case when v_give_up then 'permanently_missing' else 'pending' end,
          lease_token = null,
          lease_expires_at = null
      where id = v_gap.id;

      if v_give_up then
        -- Lock each affected immutable decision before its final state check.
        -- The normal resolver also claims decision rows with FOR UPDATE, so an
        -- outcome and an abandonment cannot win concurrently.
        for v_decision_id in
          select d.id
          from signal_atlas.decision_events d
          where d.asset_id = v_gap.asset_id and d.timeframe = v_gap.timeframe
            and d.expiry_at <= p_as_of
            and not exists (
              select 1 from signal_atlas.correction_events ce
              where ce.target_type = 'decision' and ce.target_id = d.id
                and ce.correction_type = 'invalidate'
            )
            and (
              (v_gap.missing_kind = 'entry' and d.entry_at = v_gap.missing_time)
              or (v_gap.missing_kind = 'expiry' and d.expiry_at = v_gap.missing_time)
            )
          order by d.id
          for update
        loop
          -- This is a new statement after any lock wait and therefore sees a
          -- concurrently committed resolution under READ COMMITTED.
          if not exists (
            select 1 from signal_atlas.outcomes o
            where o.decision_event_id = v_decision_id
          ) then
            insert into signal_atlas.resolution_abandonments(
              decision_event_id, candle_gap_id, abandoned_at, reason,
              attempt_count, first_detected_at
            ) values (
              v_decision_id, v_gap.id, p_as_of, 'provider_candle_permanently_missing',
              v_attempts, v_gap.first_detected_at
            ) on conflict (decision_event_id) do nothing;
          end if;
        end loop;
      end if;
    end if;

    insert into signal_atlas.candle_gap_attempts(
      candle_gap_id, run_id, attempted_at, attempt_number, result, next_retry_at
    ) values (
      v_gap.id, p_run_id, p_as_of, v_attempts, v_result,
      case when v_result = 'missing'
        then p_as_of + pg_catalog.make_interval(mins => v_backoff_minutes)
        else null end
    ) on conflict (candle_gap_id, run_id) do nothing;

    gap_id := v_gap.id;
    gap_status := case when v_result = 'missing' then 'pending' else v_result end;
    attempt_count := v_attempts;
    return next;
  end loop;
end
$$;

create or replace function public.list_due_candle_gaps(
  p_as_of timestamptz,
  p_run_id uuid,
  p_limit integer default 6
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'ok', true,
    'asOf', p_as_of,
    'runId', p_run_id,
    'due', coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
  )
  from signal_atlas.claim_due_candle_gaps_at(p_as_of, p_run_id, p_limit) x
$$;

create or replace function public.reconcile_candle_gaps(
  p_as_of timestamptz,
  p_run_id uuid,
  p_gap_ids uuid[]
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'ok', true,
    'asOf', p_as_of,
    'runId', p_run_id,
    'results', coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
  )
  from signal_atlas.reconcile_candle_gaps_at(p_as_of, p_run_id, p_gap_ids) x
$$;

-- Exclude terminally abandoned decisions from every future resolution scan.
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
    raise exception using errcode = '23514',
      message = 'resolution clock must be present and cannot be in the future';
  end if;
  if p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'limit must be between 1 and 1000';
  end if;

  for v_row in
    select d.id
    from signal_atlas.decision_events d
    where d.expiry_at <= p_as_of
      and not exists (
        select 1 from signal_atlas.outcomes o where o.decision_event_id = d.id
      )
      and not exists (
        select 1 from signal_atlas.resolution_abandonments a where a.decision_event_id = d.id
      )
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

revoke all on signal_atlas.candle_gaps,
  signal_atlas.candle_gap_attempts,
  signal_atlas.resolution_abandonments
from public, anon, authenticated, service_role;

revoke all on function signal_atlas.reject_abandoned_outcome(),
  signal_atlas.reject_resolved_abandonment(),
  signal_atlas.claim_due_candle_gaps_at(timestamptz,uuid,integer),
  signal_atlas.reconcile_candle_gaps_at(timestamptz,uuid,uuid[])
from public, anon, authenticated, service_role;

revoke all on function public.list_due_candle_gaps(timestamptz,uuid,integer),
  public.reconcile_candle_gaps(timestamptz,uuid,uuid[])
from public, anon, authenticated, service_role;

grant execute on function public.list_due_candle_gaps(timestamptz,uuid,integer),
  public.reconcile_candle_gaps(timestamptz,uuid,uuid[])
to service_role;

comment on table signal_atlas.candle_gaps is
  'Private leased queue of exact candle gaps; never substitutes or interpolates price.';
comment on table signal_atlas.candle_gap_attempts is
  'Append-only audit of each real gap backfill attempt, idempotent per worker run.';
comment on table signal_atlas.resolution_abandonments is
  'Append-only terminal record for decisions that cannot be resolved with exact candles.';
comment on function public.list_due_candle_gaps(timestamptz,uuid,integer) is
  'Service-role-only bounded claim of due exact-candle recovery work.';
comment on function public.reconcile_candle_gaps(timestamptz,uuid,uuid[]) is
  'Service-role-only reconciliation that verifies exact candles inside Postgres.';

commit;
