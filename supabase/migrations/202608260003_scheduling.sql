-- Extension prerequisites for Supabase-native scheduling.
--
-- This historical migration used to create jobs immediately.  That created a
-- race on clean rebuilds because Functions/Vault might not exist yet.  Job
-- creation now lives exclusively behind the explicit, credential-validating
-- signal_atlas.activate_schedules() installed by migration 011.  Existing
-- projects are paused safely when 011 is applied; new projects never create a
-- premature job here.

begin;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

comment on extension pg_cron is 'Signal Atlas schedules are activated explicitly after Functions and Vault pass the migration 011 preflight.';

commit;
