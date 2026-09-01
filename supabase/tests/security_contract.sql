-- Run after migrations 011, 013 and 024 with psql or the Supabase SQL runner.
-- Verifies the complete browser contract and deny-by-default for every current
-- private table under BOTH public browser roles. Newly added private tables
-- are discovered automatically through pg_class.

begin;

set local role anon;
select * from public.cloud_latest_decisions limit 0;
select * from public.cloud_opportunities limit 0;
select * from public.cloud_segment_metrics limit 0;
select * from public.cloud_quality_segment_metrics limit 0;
select * from public.cloud_paper_summary limit 0;
select * from public.cloud_quality_paper_summary limit 0;
select * from public.cloud_system_health limit 0;
select * from public.cloud_grade_history limit 0;
select * from public.cloud_decision_explanations limit 0;
select * from public.cloud_canonical_signals limit 0;
reset role;

set local role authenticated;
select * from public.cloud_latest_decisions limit 0;
select * from public.cloud_opportunities limit 0;
select * from public.cloud_segment_metrics limit 0;
select * from public.cloud_quality_segment_metrics limit 0;
select * from public.cloud_paper_summary limit 0;
select * from public.cloud_quality_paper_summary limit 0;
select * from public.cloud_system_health limit 0;
select * from public.cloud_grade_history limit 0;
select * from public.cloud_decision_explanations limit 0;
select * from public.cloud_canonical_signals limit 0;
reset role;

do $test$
declare
  v_role name;
  v_table record;
  v_privilege text;
begin
  foreach v_role in array array['anon'::name, 'authenticated'::name]
  loop
    for v_table in
      select n.nspname, c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'signal_atlas'
        and c.relkind in ('r', 'p')
      order by c.relname
    loop
      foreach v_privilege in array array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]
      loop
        if pg_catalog.has_table_privilege(
          v_role,
          pg_catalog.format('%I.%I', v_table.nspname, v_table.relname),
          v_privilege
        ) then
          raise exception 'security regression: role % has % on %.%',
            v_role, v_privilege, v_table.nspname, v_table.relname;
        end if;
      end loop;
    end loop;

    if pg_catalog.has_table_privilege(v_role, 'public.signal_atlas_latest', 'SELECT') then
      raise exception 'security regression: role % can read legacy signal_atlas_latest', v_role;
    end if;
    if pg_catalog.has_function_privilege(v_role, 'public.sa_segment_metrics(text,text)', 'EXECUTE') then
      raise exception 'security regression: role % can execute legacy sa_segment_metrics', v_role;
    end if;
    if pg_catalog.has_function_privilege(
      v_role,
      'public.list_due_candle_gaps(timestamptz,uuid,integer)',
      'EXECUTE'
    ) then
      raise exception 'security regression: role % can claim private candle gaps', v_role;
    end if;
    if pg_catalog.has_function_privilege(
      v_role,
      'public.reconcile_candle_gaps(timestamptz,uuid,uuid[])',
      'EXECUTE'
    ) then
      raise exception 'security regression: role % can reconcile private candle gaps', v_role;
    end if;
    if pg_catalog.has_function_privilege(
      v_role,
      'public.archive_economic_calendar(uuid,timestamptz,jsonb)',
      'EXECUTE'
    ) then
      raise exception 'security regression: role % can write the private calendar archive', v_role;
    end if;
    if pg_catalog.has_function_privilege(
      v_role,
      'public.calendar_replay_snapshots(jsonb,integer)',
      'EXECUTE'
    ) then
      raise exception 'security regression: role % can bypass the bounded calendar Edge transport', v_role;
    end if;
  end loop;
end
$test$;

rollback;
