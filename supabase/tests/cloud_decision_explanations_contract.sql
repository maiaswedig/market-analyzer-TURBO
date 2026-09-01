-- Run after migration 025. Read-only contract for the public decision
-- explanation projection.

begin;

do $test$
begin
  if exists (
    select 1
    from public.cloud_decision_explanations e
    join signal_atlas.decision_events d on d.id = e.id
    where d.model_role <> 'champion'
  ) then
    raise exception 'cloud_decision_explanations exposed a non-champion decision';
  end if;

  if exists (
    select 1
    from public.cloud_decision_explanations e
    join signal_atlas.correction_events c
      on c.target_type = 'decision'
     and c.target_id = e.id
     and c.correction_type = 'invalidate'
  ) then
    raise exception 'cloud_decision_explanations exposed an invalidated decision';
  end if;

  if exists (
    select 1 from public.cloud_decision_explanations
    where pg_catalog.jsonb_typeof(reasons) <> 'array'
  ) then
    raise exception 'cloud_decision_explanations returned non-array reasons';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'cloud_decision_explanations'
      and 'security_invoker=true' = any(coalesce(c.reloptions, array[]::text[]))
  ) then
    raise exception 'cloud_decision_explanations must use security_invoker';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.cloud_decision_explanations', 'INSERT')
    or pg_catalog.has_table_privilege('anon', 'public.cloud_decision_explanations', 'UPDATE')
    or pg_catalog.has_table_privilege('anon', 'public.cloud_decision_explanations', 'DELETE')
    or pg_catalog.has_table_privilege('authenticated', 'public.cloud_decision_explanations', 'INSERT')
    or pg_catalog.has_table_privilege('authenticated', 'public.cloud_decision_explanations', 'UPDATE')
    or pg_catalog.has_table_privilege('authenticated', 'public.cloud_decision_explanations', 'DELETE')
  then
    raise exception 'cloud_decision_explanations is writable by a browser role';
  end if;
end
$test$;

set local role anon;
select * from public.cloud_decision_explanations limit 0;
reset role;

set local role authenticated;
select * from public.cloud_decision_explanations limit 0;
reset role;

rollback;
