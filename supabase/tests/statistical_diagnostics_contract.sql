-- Run after migration 031. Verifies causal regime persistence, aggregate-only
-- browser access and the absence of any automatic strategy/model mutation.
begin;

set local role anon;
select * from public.cloud_single_naive_baselines limit 0;
select * from public.cloud_single_grade_calibration limit 0;
select * from public.cloud_grade_a_diagnostics limit 0;
reset role;

set local role authenticated;
select * from public.cloud_single_naive_baselines limit 0;
select * from public.cloud_single_grade_calibration limit 0;
select * from public.cloud_grade_a_diagnostics limit 0;
reset role;

do $test$
declare
  v_wrapper text;
  v_trigger text;
  v_grade text;
  v_baselines text;
  v_options text;
  v_view text;
begin
  select pg_catalog.pg_get_functiondef('public.register_market_decision(jsonb)'::pg_catalog.regprocedure) into v_wrapper;
  select pg_catalog.pg_get_functiondef('signal_atlas.attach_causal_regime_snapshot()'::pg_catalog.regprocedure) into v_trigger;
  select pg_catalog.pg_get_functiondef('signal_atlas.cloud_single_grade_calibration_rows()'::pg_catalog.regprocedure) into v_grade;
  select pg_catalog.pg_get_functiondef('signal_atlas.cloud_single_naive_baselines_rows()'::pg_catalog.regprocedure) into v_baselines;

  if v_wrapper !~* 'set_config[^;]+signal_atlas\.decision_regime' or v_wrapper !~* 'invalid market regime' then
    raise exception 'diagnostics contract: registration wrapper does not validate/pass the regime';
  end if;
  if v_trigger !~* 'feature_snapshot' or v_trigger !~* 'cloud-regime-v1' then
    raise exception 'diagnostics contract: immutable regime snapshot trigger is incomplete';
  end if;
  if v_grade !~* '1\.96' or v_grade !~* 'correction_type = ''invalidate''' then
    raise exception 'diagnostics contract: Wilson interval or invalidation exclusion is missing';
  end if;
  if v_baselines !~* 'always_buy' or v_baselines !~* 'always_sell'
     or v_baselines !~* 'last_closed_candle' or v_baselines !~* 'random_50_expected'
     or v_baselines !~* 'close_time <= d\.feature_cutoff_at' then
    raise exception 'diagnostics contract: one or more causal baselines are missing';
  end if;
  if v_grade ~* 'update\s+signal_atlas\.model_artifacts'
     or v_baselines ~* 'update\s+signal_atlas\.model_artifacts' then
    raise exception 'diagnostics contract: read-only diagnosis mutates a model';
  end if;

  foreach v_view in array array[
    'cloud_single_naive_baselines',
    'cloud_single_grade_calibration',
    'cloud_grade_a_diagnostics'
  ] loop
    select coalesce(c.reloptions::text, '') into v_options
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = v_view;
    if v_options not ilike '%security_invoker=true%' then
      raise exception 'diagnostics contract: public view % is not security_invoker', v_view;
    end if;
  end loop;

  if pg_catalog.has_function_privilege('anon', 'public.register_market_decision(jsonb)', 'execute')
     or pg_catalog.has_function_privilege('authenticated', 'public.register_market_decision(jsonb)', 'execute') then
    raise exception 'diagnostics contract: browser role can register a market decision';
  end if;
end
$test$;

rollback;
