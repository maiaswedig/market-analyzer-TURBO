begin;

-- Covers the policy_version_id foreign key for parent-row maintenance and
-- joins without weakening the private deny-by-default contract.
create index if not exists policy_shadow_policy_version_idx
  on signal_atlas.policy_shadow_decisions(policy_version_id);

commit;
