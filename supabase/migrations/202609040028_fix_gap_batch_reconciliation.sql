begin;

-- Fix a batch race in the exact-candle recovery queue. An abandonment can
-- cancel a sibling gap while both gap IDs are already present in the worker's
-- batch. The old row-valued cursor kept the sibling's stale "pending" image
-- and could then try to turn that cancelled row into permanently_missing,
-- violating candle_gaps_terminal_clock_check.
--
-- Iterate over IDs and re-lock/re-read the current row immediately before
-- every transition. A sibling cancelled by an earlier iteration is skipped.
create or replace function signal_atlas.reconcile_candle_gaps_at(
  p_as_of timestamptz,
  p_run_id uuid,
  p_gap_ids uuid[]
)
returns table(gap_id uuid, gap_status text, attempt_count integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_gap_id uuid;
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

  for v_gap_id in
    select distinct requested.id
    from pg_catalog.unnest(coalesce(p_gap_ids, array[]::uuid[])) as requested(id)
    order by requested.id
  loop
    -- Re-read the row after every prior trigger side effect in this batch.
    -- The row lock also serializes this transition with other workers.
    select g.* into v_gap
    from signal_atlas.candle_gaps g
    where g.id = v_gap_id
      and g.status = 'pending'
      and g.lease_token = p_run_id
    for update;

    if not found then
      continue;
    end if;

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
          cancelled_at = null,
          lease_token = null,
          lease_expires_at = null
      where id = v_gap.id
        and status = 'pending'
        and lease_token = p_run_id;
      if not found then continue; end if;
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
          resolved_at = null,
          cancelled_at = null,
          lease_token = null,
          lease_expires_at = null
      where id = v_gap.id
        and status = 'pending'
        and lease_token = p_run_id;
      if not found then continue; end if;

      if v_give_up then
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
$function$;

revoke all on function signal_atlas.reconcile_candle_gaps_at(timestamptz,uuid,uuid[])
from public, anon, authenticated, service_role;

comment on function signal_atlas.reconcile_candle_gaps_at(timestamptz,uuid,uuid[]) is
  'Reconciles exact candles from a leased batch after re-reading each current row, so sibling cancellation cannot reuse stale state.';

commit;
