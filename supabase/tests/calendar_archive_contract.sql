-- Run after migrations 020-022. This transaction proves idempotence,
-- append-only observations and the causal as-of boundary without retaining
-- fixture rows.

begin;

do $test$
declare
  v_run_1 uuid := pg_catalog.gen_random_uuid();
  v_run_2 uuid := pg_catalog.gen_random_uuid();
  v_seen_early integer;
  v_seen_late integer;
  v_events integer;
  v_observations integer;
  v_first_actual text;
  v_first_category text;
  v_latest_actual text;
  v_latest_category text;
  v_snapshots integer;
  v_snapshot_links integer;
  v_replay_events integer;
  v_replay_category text;
  v_anchor timestamptz := pg_catalog.date_trunc('hour', pg_catalog.clock_timestamp()) - interval '2 days';
  v_event_at timestamptz;
begin
  v_event_at := v_anchor + interval '90 minutes';
  if signal_atlas.timeframe_seconds('M30'::signal_atlas.timeframe_code) <> 1800 then
    raise exception 'M30 runtime contract failed';
  end if;

  perform public.archive_economic_calendar(
    v_run_1,
    v_anchor,
    pg_catalog.jsonb_build_object(
      'source', 'contract-fixture',
      'events', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'at', extract(epoch from v_event_at) * 1000,
        'currency', 'USD',
        'title', 'CPI m/m',
        'eventKey', 'contract-usd-cpi-20260830',
        'impact', 'high',
        'category', 'inflation',
        'categoryVersion', 1,
        'forecast', '0.3%',
        'previous', '0.2%',
        'actual', null
      ))
    )
  );

  -- Identical content under a second run remains one observation; the archive
  -- retains the earliest causal availability time for that content.
  perform public.archive_economic_calendar(
    v_run_2,
    v_anchor + interval '5 minutes',
    pg_catalog.jsonb_build_object(
      'source', 'contract-fixture',
      'events', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'at', extract(epoch from v_event_at) * 1000,
        'currency', 'USD',
        'title', 'CPI m/m',
        'eventKey', 'contract-usd-cpi-20260830',
        'impact', 'high',
        'category', 'inflation',
        'categoryVersion', 1,
        'forecast', '0.3%',
        'previous', '0.2%',
        'actual', null
      ))
    )
  );

  select count(*) into v_events
  from signal_atlas.economic_calendar_events e
  where e.source = 'contract-fixture';
  select count(*) into v_observations
  from signal_atlas.economic_calendar_observations o
  join signal_atlas.economic_calendar_events e on e.id = o.event_id
  where e.source = 'contract-fixture';
  if v_events <> 1 or v_observations <> 1 then
    raise exception 'calendar idempotence failed: events %, observations %', v_events, v_observations;
  end if;

  -- A later actual value creates a second immutable observation.
  perform public.archive_economic_calendar(
    pg_catalog.gen_random_uuid(),
    v_anchor + interval '95 minutes',
    pg_catalog.jsonb_build_object(
      'source', 'contract-fixture',
      'events', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'at', extract(epoch from v_event_at) * 1000,
        'currency', 'USD',
        'title', 'CPI m/m',
        'eventKey', 'contract-usd-cpi-20260830',
        'impact', 'high',
        'category', 'other_high_impact',
        'categoryVersion', 2,
        'forecast', '0.3%',
        'previous', '0.2%',
        'actual', '0.4%'
      ))
    )
  );

  select count(*) into v_seen_early
  from signal_atlas.calendar_events_as_of(
    v_anchor - interval '1 second', v_anchor - interval '1 hour',
    v_anchor + interval '1 day', array['USD']
  );
  if v_seen_early <> 0 then
    raise exception 'look-ahead: event visible before first fetched_at';
  end if;

  select count(*), max(payload->>'actual'), max(category)
  into v_seen_late, v_first_actual, v_first_category
  from signal_atlas.calendar_events_as_of(
    v_anchor + interval '30 minutes', v_anchor - interval '1 hour',
    v_anchor + interval '1 day', array['USD']
  );
  if v_seen_late <> 1 or v_first_actual is not null or v_first_category <> 'inflation' then
    raise exception 'look-ahead: later actual/category leaked into an earlier as-of read';
  end if;

  select max(payload->>'actual'), max(category) into v_latest_actual, v_latest_category
  from signal_atlas.calendar_events_as_of(
    v_anchor + interval '2 hours', v_anchor - interval '1 hour',
    v_anchor + interval '1 day', array['USD']
  );
  if v_latest_actual <> '0.4%' or v_latest_category <> 'other_high_impact' then
    raise exception 'latest causal observation/category was not returned';
  end if;

  select count(*) into v_snapshots
  from signal_atlas.economic_calendar_snapshots s
  where s.source = 'contract-fixture';
  select count(*) into v_snapshot_links
  from signal_atlas.economic_calendar_fetch_snapshots link
  join signal_atlas.economic_calendar_fetches f on f.id = link.fetch_id
  where f.source = 'contract-fixture';
  if v_snapshots <> 2 or v_snapshot_links <> 3 then
    raise exception 'complete snapshot contract failed: snapshots %, links %',
      v_snapshots, v_snapshot_links;
  end if;

  -- The replay bridge must select the complete snapshot that was latest at the
  -- decision time, not a later observation of the same event.
  select pg_catalog.jsonb_array_length(r.events), r.events->0->>'category'
  into v_replay_events, v_replay_category
  from public.calendar_replay_snapshots(
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'key', 'middle',
      'knownAt', extract(epoch from (v_anchor + interval '30 minutes')) * 1000,
      'from', extract(epoch from (v_anchor - interval '1 hour')) * 1000,
      'to', extract(epoch from (v_anchor + interval '1 day')) * 1000
    )),
    360
  ) r;
  if v_replay_events <> 1 or v_replay_category <> 'inflation' then
    raise exception 'replay leaked a later complete snapshot';
  end if;

  -- A later empty provider snapshot is an explicit removal/cancellation. The
  -- event must disappear from replay even though its immutable observation is
  -- still retained for audit.
  perform public.archive_economic_calendar(
    pg_catalog.gen_random_uuid(),
    v_anchor + interval '3 hours',
    pg_catalog.jsonb_build_object(
      'source', 'contract-fixture',
      'events', pg_catalog.jsonb_build_array()
    )
  );
  select pg_catalog.jsonb_array_length(r.events)
  into v_replay_events
  from public.calendar_replay_snapshots(
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'key', 'after-removal',
      'knownAt', extract(epoch from (v_anchor + interval '3 hours 1 minute')) * 1000,
      'from', extract(epoch from (v_anchor - interval '1 hour')) * 1000,
      'to', extract(epoch from (v_anchor + interval '1 day')) * 1000
    )),
    360
  ) r;
  if v_replay_events <> 0 then
    raise exception 'removed/cancelled event survived the complete-snapshot replay';
  end if;
end
$test$;

rollback;
