begin;

do $contract$
declare
  v_config jsonb;
  v_other_modes integer;
begin
  select p.config into strict v_config
  from signal_atlas.policy_versions p
  where p.policy_key = 'cloud-engine-single'
    and p.mode = 'neutro'::signal_atlas.mode_code
    and p.version = 1;

  if coalesce((v_config->>'operation_cost')::numeric, -1) <> 0 then
    raise exception 'single policy operation_cost must be zero';
  end if;
  if v_config->>'operating_policy' <> 'single' then
    raise exception 'single policy marker is missing';
  end if;

  select pg_catalog.count(*) into v_other_modes
  from signal_atlas.policy_versions p
  where p.policy_key = 'cloud-engine-single'
    and p.mode <> 'neutro'::signal_atlas.mode_code;
  if v_other_modes <> 0 then
    raise exception 'single policy must not seed additional modes';
  end if;

  perform * from public.cloud_single_paper_summary;
  perform * from public.cloud_single_quality_paper_summary;
end
$contract$;

rollback;
