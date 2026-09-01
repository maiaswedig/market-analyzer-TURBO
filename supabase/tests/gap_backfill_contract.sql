-- Run after migrations 016-018. This exercises the real queue functions but rolls
-- every mutation back, including the deliberately forced terminal attempt.

begin;

do $test$
declare
  v_run uuid := pg_catalog.gen_random_uuid();
  v_as_of timestamptz := pg_catalog.clock_timestamp() - interval '1 second';
  v_ids uuid[];
  v_gap_id uuid;
  v_abandoned_decision uuid;
  v_resolved_decision uuid;
  v_guarded boolean := false;
begin
  select coalesce(pg_catalog.array_agg(x.id), array[]::uuid[])
    into v_ids
  from signal_atlas.claim_due_candle_gaps_at(v_as_of, v_run, 6) x;

  if pg_catalog.cardinality(v_ids) > 6 then
    raise exception 'gap contract: bounded claim returned more than six rows';
  end if;

  perform 1
  from signal_atlas.reconcile_candle_gaps_at(v_as_of, v_run, v_ids);

  if exists (
    select 1 from signal_atlas.candle_gaps g
    where g.id = any(v_ids)
      and (
        g.attempts <> 1
        or g.status <> 'pending'
        or g.next_retry_at <> v_as_of + interval '5 minutes'
        or g.lease_token is not null
        or g.lease_expires_at is not null
      )
  ) then
    raise exception 'gap contract: first retry is not exactly five minutes or lease leaked';
  end if;

  -- A live database may currently have no missing candle. In that healthy
  -- state the bounded/no-privilege checks still pass and the terminal branch
  -- has no row to exercise.
  v_gap_id := v_ids[1];
  if v_gap_id is not null then
    v_run := pg_catalog.gen_random_uuid();
    update signal_atlas.candle_gaps
    set attempts = 7,
        first_detected_at = v_as_of - interval '13 hours',
        next_retry_at = v_as_of,
        lease_token = v_run,
        lease_expires_at = v_as_of + interval '90 seconds'
    where id = v_gap_id;

    perform 1
    from signal_atlas.reconcile_candle_gaps_at(v_as_of, v_run, array[v_gap_id]);

    if not exists (
      select 1 from signal_atlas.candle_gaps g
      where g.id = v_gap_id and g.status = 'permanently_missing' and g.attempts = 8
    ) then
      raise exception 'gap contract: terminal retry did not close the gap';
    end if;

    select a.decision_event_id into v_abandoned_decision
    from signal_atlas.resolution_abandonments a
    where a.candle_gap_id = v_gap_id
    limit 1;
    if v_abandoned_decision is null then
      raise exception 'gap contract: terminal gap did not append an abandonment';
    end if;

    if exists (
      select 1
      from signal_atlas.candle_gaps g
      where g.status = 'pending'
        and not exists (
          select 1
          from signal_atlas.decision_events d
          where d.asset_id = g.asset_id and d.timeframe = g.timeframe
            and d.expiry_at <= v_as_of
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
            and (
              (g.missing_kind = 'entry' and d.entry_at = g.missing_time)
              or (g.missing_kind = 'expiry' and d.expiry_at = g.missing_time)
            )
        )
    ) then
      raise exception 'gap contract: pending queue residue remained after terminal abandonment';
    end if;

    begin
      insert into signal_atlas.outcomes(decision_event_id)
      values (v_abandoned_decision);
    exception when check_violation then
      v_guarded := true;
    end;
    if not v_guarded then
      raise exception 'gap contract: abandoned decision accepted an outcome';
    end if;

    select o.decision_event_id into v_resolved_decision
    from signal_atlas.outcomes o
    limit 1;
    if v_resolved_decision is not null then
      v_guarded := false;
      begin
        insert into signal_atlas.resolution_abandonments(
          decision_event_id, candle_gap_id, abandoned_at, reason,
          attempt_count, first_detected_at
        ) values (
          v_resolved_decision, v_gap_id, v_as_of,
          'provider_candle_permanently_missing', 8, v_as_of - interval '13 hours'
        );
      exception when check_violation then
        v_guarded := true;
      end;
      if not v_guarded then
        raise exception 'gap contract: resolved decision accepted an abandonment';
      end if;
    end if;
  end if;
end
$test$;

rollback;
