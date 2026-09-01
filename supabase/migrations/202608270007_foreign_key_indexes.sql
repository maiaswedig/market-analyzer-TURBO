-- Cover ledger foreign keys that are used by joins, append-only validation and
-- retention checks.  The database grows continuously, so these indexes avoid
-- table scans as prospective decisions accumulate.

begin;

create index if not exists decision_events_model_idx
  on signal_atlas.decision_events(model_artifact_id);
create index if not exists decision_events_policy_idx
  on signal_atlas.decision_events(policy_version_id);

create index if not exists model_deployment_model_idx
  on signal_atlas.model_deployment_events(model_artifact_id);
create index if not exists model_deployment_previous_model_idx
  on signal_atlas.model_deployment_events(previous_model_artifact_id)
  where previous_model_artifact_id is not null;

create index if not exists outcomes_entry_candle_idx
  on signal_atlas.outcomes(entry_candle_id);
create index if not exists outcomes_expiry_candle_idx
  on signal_atlas.outcomes(expiry_candle_id);

create index if not exists paper_trade_events_outcome_idx
  on signal_atlas.paper_trade_events(outcome_id)
  where outcome_id is not null;

create index if not exists promotion_reviews_challenger_idx
  on signal_atlas.promotion_reviews(challenger_model_artifact_id);
create index if not exists promotion_reviews_champion_idx
  on signal_atlas.promotion_reviews(champion_model_artifact_id);

create index if not exists scanner_health_run_idx
  on signal_atlas.scanner_health_events(scanner_run_id)
  where scanner_run_id is not null;

create index if not exists shadow_predictions_policy_idx
  on signal_atlas.shadow_predictions(policy_version_id);

commit;
