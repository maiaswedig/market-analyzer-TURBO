-- Run after migration 026. Confirms that technical grade never grants
-- statistical confirmation and that the browser projection is read-only.

begin;

do $test$
declare
  v_definition text;
  v_mode signal_atlas.mode_code;
  v_config jsonb;
begin
  v_definition := pg_catalog.pg_get_functiondef(
    'signal_atlas.canonicalize_decision_economics()'::regprocedure
  );

  if v_definition ~* 'feature_snapshot\s*->>\s*''grade''[\s\S]{0,240}confirmed' then
    raise exception 'technical grade still grants confirmed quality';
  end if;
  if v_definition !~* 'model_deployment_events[\s\S]*promotion_reviews[\s\S]*promote_champion' then
    raise exception 'confirmed quality does not prove a real promotion event';
  end if;
  if v_definition ~* 'champion_usable' then
    raise exception 'quality trusts an Edge payload field instead of the model ledger';
  end if;

  foreach v_mode in array array[
    'conservador'::signal_atlas.mode_code,
    'neutro'::signal_atlas.mode_code,
    'agressivo'::signal_atlas.mode_code
  ]
  loop
    select p.config into v_config
    from signal_atlas.policy_versions p
    where p.mode = v_mode
      and p.effective_from <= pg_catalog.clock_timestamp()
    order by p.effective_from desc, p.version desc, p.id desc
    limit 1;

    if coalesce((v_config->>'quality_contract_version')::integer, 0) <> 4
      or not coalesce((v_config->>'require_promoted_champion_confirmed')::boolean, false)
      or coalesce((v_config->>'min_promotion_paired_samples_confirmed')::integer, 0) < 500
      or not (v_config ? 'min_probability_lb_confirmed')
      or not (v_config ? 'min_ev_lb_confirmed')
    then
      raise exception 'mode % is missing immutable confirmation policy fields', v_mode;
    end if;
  end loop;

  if exists (
    select 1
    from public.cloud_canonical_signals c
    join signal_atlas.correction_events x
      on x.target_type = 'decision'
     and x.target_id = c.id
     and x.correction_type = 'invalidate'
  ) then
    raise exception 'canonical browser view exposed an invalidated decision';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'cloud_canonical_signals'
      and 'security_invoker=true' = any(coalesce(c.reloptions, array[]::text[]))
  ) then
    raise exception 'cloud_canonical_signals must use security_invoker';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.cloud_canonical_signals', 'INSERT')
    or pg_catalog.has_table_privilege('anon', 'public.cloud_canonical_signals', 'UPDATE')
    or pg_catalog.has_table_privilege('anon', 'public.cloud_canonical_signals', 'DELETE')
    or pg_catalog.has_table_privilege('authenticated', 'public.cloud_canonical_signals', 'INSERT')
    or pg_catalog.has_table_privilege('authenticated', 'public.cloud_canonical_signals', 'UPDATE')
    or pg_catalog.has_table_privilege('authenticated', 'public.cloud_canonical_signals', 'DELETE')
  then
    raise exception 'canonical browser view is writable by a browser role';
  end if;
end
$test$;

set local role anon;
select * from public.cloud_canonical_signals limit 0;
reset role;

set local role authenticated;
select * from public.cloud_canonical_signals limit 0;
reset role;

rollback;
