begin;

-- A decision may have separate entry and expiry gaps. If one reaches the
-- terminal abandonment state before its sibling is claimed, the sibling no
-- longer has eligible work and must not remain pending forever.

create or replace function signal_atlas.cancel_related_gaps_after_abandonment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update signal_atlas.candle_gaps g
  set status = 'cancelled',
      cancelled_at = new.abandoned_at,
      lease_token = null,
      lease_expires_at = null
  from signal_atlas.decision_events abandoned
  where abandoned.id = new.decision_event_id
    and g.status = 'pending'
    and g.asset_id = abandoned.asset_id
    and g.timeframe = abandoned.timeframe
    and (
      (g.missing_kind = 'entry' and g.missing_time = abandoned.entry_at)
      or (g.missing_kind = 'expiry' and g.missing_time = abandoned.expiry_at)
    )
    and not exists (
      select 1
      from signal_atlas.decision_events d
      where d.asset_id = g.asset_id
        and d.timeframe = g.timeframe
        and d.expiry_at <= new.abandoned_at
        and not exists (
          select 1 from signal_atlas.outcomes o where o.decision_event_id = d.id
        )
        and not exists (
          select 1 from signal_atlas.resolution_abandonments a where a.decision_event_id = d.id
        )
        and not exists (
          select 1 from signal_atlas.correction_events ce
          where ce.target_type = 'decision'
            and ce.target_id = d.id
            and ce.correction_type = 'invalidate'
        )
        and (
          (g.missing_kind = 'entry' and d.entry_at = g.missing_time)
          or (g.missing_kind = 'expiry' and d.expiry_at = g.missing_time)
        )
    );
  return new;
end
$function$;

drop trigger if exists candle_gap_abandonment_cleanup
on signal_atlas.resolution_abandonments;
create trigger candle_gap_abandonment_cleanup
after insert on signal_atlas.resolution_abandonments
for each row execute function signal_atlas.cancel_related_gaps_after_abandonment();

-- Close residue created before this trigger existed.
select signal_atlas.cancel_unreferenced_candle_gaps_at(pg_catalog.clock_timestamp());

revoke all on function signal_atlas.cancel_related_gaps_after_abandonment()
from public, anon, authenticated, service_role;

comment on function signal_atlas.cancel_related_gaps_after_abandonment() is
  'Cancels only sibling gap work made ineligible by an immutable terminal abandonment.';

commit;
