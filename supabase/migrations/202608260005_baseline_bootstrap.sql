-- A segment needs an initial reference model before prospective champion vs.
-- challenger comparisons can exist.  The first chronological model with at
-- least 300 holdout rows becomes a clearly labelled baseline even when it did
-- not beat the naive rate offline.  Its live decisions remain LOW quality.

begin;

create or replace function signal_atlas.bootstrap_first_segment_baseline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_samples integer;
begin
  v_samples := coalesce((new.validation_metrics->>'sample_size')::integer, 0);
  if v_samples >= 300
     and signal_atlas.current_champion_model(new.asset_id, new.timeframe) is null then
    perform signal_atlas.bootstrap_champion(
      new.asset_id,
      new.timeframe,
      new.id,
      'initial-baseline|' || new.asset_id::text || '|' || new.timeframe::text || '|' || new.artifact_sha256,
      case when coalesce((new.validation_metrics->>'usable')::boolean, false)
        then 'Primeiro modelo passou os gates offline e inicia a medição prospectiva.'
        else 'Baseline inicial para iniciar medição prospectiva; ainda não validado como melhoria e exibido com qualidade baixa.'
      end
    );
  end if;
  return new;
end
$$;

drop trigger if exists bootstrap_first_segment_baseline on signal_atlas.model_artifacts;
create trigger bootstrap_first_segment_baseline
after insert on signal_atlas.model_artifacts
for each row execute function signal_atlas.bootstrap_first_segment_baseline();

commit;
