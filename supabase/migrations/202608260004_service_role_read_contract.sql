-- security_invoker views require their caller to hold SELECT on the underlying
-- private relations.  Only service_role gets these worker reads; browser roles
-- remain limited to the cloud_* read models.

begin;

grant select on signal_atlas.candles,
  signal_atlas.model_artifacts,
  signal_atlas.policy_versions,
  signal_atlas.current_champions
to service_role;

commit;
