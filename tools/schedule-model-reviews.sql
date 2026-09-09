-- Run after deploying review-models. Reuse the existing Vault-backed worker
-- authentication without exporting secret values. Re-running updates this job.
do $schedule$
declare v_command text;
begin
  select command into strict v_command from cron.job
  where jobname = 'signal-atlas-train-challenger' and active;
  if position('/functions/v1/train-challenger' in v_command) = 0 then
    raise exception 'Unexpected training cron command';
  end if;
  perform cron.schedule('signal-atlas-review-models', '*/5 * * * *',
    replace(v_command, '/functions/v1/train-challenger', '/functions/v1/review-models'));
end;
$schedule$;
