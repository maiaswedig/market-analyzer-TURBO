-- Run after migrations in a disposable/staging database.
-- Contract: one tie-aware EV formula, enforced on every future ledger insert.

do $$
declare
  v_loss numeric;
  v_refund numeric;
  v_win numeric;
  v_trigger_count integer;
  v_public_wrapper_ok boolean;
  v_legacy_private boolean;
begin
  v_loss := signal_atlas.expected_trade_ev(0.60, 0.10, 1, 0.85, 0.02, 'loss');
  v_refund := signal_atlas.expected_trade_ev(0.60, 0.10, 1, 0.85, 0.02, 'refund');
  v_win := signal_atlas.expected_trade_ev(0.60, 0.10, 1, 0.85, 0.02, 'win');

  if pg_catalog.abs(v_loss - (-0.021)) > 0.0000001 then
    raise exception 'loss EV mismatch: %', v_loss;
  end if;
  if pg_catalog.abs(v_refund - 0.079) > 0.0000001 then
    raise exception 'refund EV mismatch: %', v_refund;
  end if;
  if pg_catalog.abs(v_win - 0.164) > 0.0000001 then
    raise exception 'win EV mismatch: %', v_win;
  end if;

  select count(*) into v_trigger_count
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and n.nspname = 'signal_atlas'
    and (
      (c.relname = 'decision_events' and t.tgname = 'canonical_decision_economics_before_insert')
      or (c.relname = 'shadow_predictions' and t.tgname = 'canonical_shadow_economics_before_insert')
      or (c.relname = 'policy_shadow_decisions' and t.tgname = 'canonical_policy_shadow_economics_before_insert')
    );
  if v_trigger_count <> 3 then
    raise exception 'canonical economics triggers missing: %/3', v_trigger_count;
  end if;

  select p.prosecdef
      and coalesce(pg_catalog.array_to_string(p.proconfig, ','), '') like '%search_path=%'
    into v_public_wrapper_ok
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'register_market_decision'
    and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_decision jsonb';
  if not coalesce(v_public_wrapper_ok, false) then
    raise exception 'public register_market_decision wrapper is not hardened';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'signal_atlas'
      and p.proname = 'register_market_decision_legacy_v2'
      and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_decision jsonb'
  ) into v_legacy_private;
  if not v_legacy_private then
    raise exception 'legacy implementation was not moved to the private schema';
  end if;

  if pg_catalog.has_function_privilege('anon', 'public.register_market_decision(jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.register_market_decision(jsonb)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.register_market_decision(jsonb)', 'EXECUTE') then
    raise exception 'public register_market_decision grants are unsafe';
  end if;

  if pg_catalog.has_function_privilege('anon', 'signal_atlas.register_market_decision_legacy_v2(jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'signal_atlas.register_market_decision_legacy_v2(jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'signal_atlas.register_market_decision_legacy_v2(jsonb)', 'EXECUTE') then
    raise exception 'legacy implementation is directly executable';
  end if;

  if pg_catalog.has_function_privilege(
      'service_role',
      'signal_atlas.expected_trade_ev(numeric,numeric,numeric,numeric,numeric,signal_atlas.tie_policy_code)',
      'EXECUTE'
    ) then
    raise exception 'internal EV helper is directly executable by service_role';
  end if;
end
$$;

select 'economic contract v3: OK' as result;
