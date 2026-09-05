-- Run after migration 029. Static/live contract checks only; no ledger history
-- is rewritten and the transaction leaves no state behind.
begin;

do $test$
declare
  v_definition text;
  v_trigger_count integer;
  v_security_invoker text;
begin
  select pg_catalog.pg_get_functiondef(
    'signal_atlas.freeze_strategy_shadow_arms()'::pg_catalog.regprocedure
  ) into v_definition;

  if v_definition !~* 'new\.decision_at[^;]+new\.entry_at' then
    raise exception 'strategy lab contract: pre-entry freeze guard is missing';
  end if;
  if v_definition !~* 'technical_current'
     or v_definition !~* 'technical_inverse'
     or v_definition !~* 'grade_a_or_a_plus' then
    raise exception 'strategy lab contract: one or more prospective controls are missing';
  end if;
  if v_definition !~* 'always_buy'
     or v_definition !~* 'always_sell'
     or v_definition !~* 'last_closed_candle'
     or v_definition !~* 'close_time <= new\.feature_cutoff_at' then
    raise exception 'strategy lab contract: simple causal baselines are missing';
  end if;

  select pg_catalog.count(*) into v_trigger_count
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'signal_atlas'
    and c.relname = 'decision_events'
    and t.tgname = 'freeze_strategy_shadow_arms_after_decision'
    and not t.tgisinternal;
  if v_trigger_count <> 1 then
    raise exception 'strategy lab contract: decision trigger is missing or duplicated';
  end if;

  select coalesce(c.reloptions::text, '') into v_security_invoker
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'cloud_strategy_lab';
  if v_security_invoker not ilike '%security_invoker=true%' then
    raise exception 'strategy lab contract: public view is not security_invoker';
  end if;

  if pg_catalog.has_table_privilege('anon', 'signal_atlas.strategy_shadow_arms', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'signal_atlas.strategy_shadow_arms', 'select')
     or pg_catalog.has_table_privilege('anon', 'signal_atlas.strategy_shadow_arms', 'insert') then
    raise exception 'strategy lab contract: private shadow ledger is exposed';
  end if;

  select pg_catalog.pg_get_functiondef(
    'signal_atlas.strategy_lab_summary_rows()'::pg_catalog.regprocedure
  ) into v_definition;
  if v_definition !~* 'case[^;]+action = ''wait''[^;]+0[^;]+coverage_benchmark_ev'
     or v_definition !~* 'pnl - s\.coverage_benchmark_ev' then
    raise exception 'strategy lab contract: random comparison does not match arm coverage';
  end if;
  if v_definition !~* 'ev_per_trade' then
    raise exception 'strategy lab contract: selective-arm EV per trade is hidden';
  end if;
end
$test$;

rollback;
