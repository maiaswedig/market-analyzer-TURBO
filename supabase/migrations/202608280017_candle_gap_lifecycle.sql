begin;

-- Close queue records that no longer have an unresolved decision attached.
-- This is operational state only; attempt and abandonment ledgers remain
-- append-only and no market decision or outcome is rewritten.

alter table signal_atlas.candle_gaps
  add column if not exists cancelled_at timestamptz;

alter table signal_atlas.candle_gaps
  drop constraint if exists candle_gaps_status_check;
alter table signal_atlas.candle_gaps
  add constraint candle_gaps_status_check
  check (status in ('pending', 'resolved', 'permanently_missing', 'cancelled'));

alter table signal_atlas.candle_gaps
  drop constraint if exists candle_gaps_check;
alter table signal_atlas.candle_gaps
  add constraint candle_gaps_terminal_clock_check
  check (
    (status = 'resolved' and resolved_at is not null and cancelled_at is null)
    or (status = 'cancelled' and resolved_at is null and cancelled_at is not null)
    or (status in ('pending', 'permanently_missing') and resolved_at is null and cancelled_at is null)
  );

create or replace function signal_atlas.cancel_unreferenced_candle_gaps_at(
  p_as_of timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_as_of is null or p_as_of > pg_catalog.clock_timestamp() then
    raise exception using errcode = '23514',
      message = 'gap cancellation clock must be present and cannot be in the future';
  end if;

  update signal_atlas.candle_gaps g
  set status = 'cancelled',
      cancelled_at = p_as_of,
      lease_token = null,
      lease_expires_at = null
  where g.status = 'pending'
    and not exists (
      select 1
      from signal_atlas.decision_events d
      where d.asset_id = g.asset_id and d.timeframe = g.timeframe
        and d.expiry_at <= p_as_of
        and not exists (
          select 1 from signal_atlas.outcomes o where o.decision_event_id = d.id
        )
        and not exists (
          select 1 from signal_atlas.resolution_abandonments a where a.decision_event_id = d.id
        )
        and not exists (
          select 1 from signal_atlas.correction_events ce
          where ce.target_type = 'decision' and ce.target_id = d.id
            and ce.correction_type = 'invalidate'
        )
        and (
          (g.missing_kind = 'entry' and d.entry_at = g.missing_time)
          or (g.missing_kind = 'expiry' and d.expiry_at = g.missing_time)
        )
    );
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

create or replace function signal_atlas.cancel_candle_gaps_after_outcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform signal_atlas.cancel_unreferenced_candle_gaps_at(pg_catalog.clock_timestamp());
  return new;
end
$$;

drop trigger if exists candle_gap_outcome_cleanup on signal_atlas.outcomes;
create trigger candle_gap_outcome_cleanup
after insert on signal_atlas.outcomes
for each statement execute function signal_atlas.cancel_candle_gaps_after_outcome();

-- Clean queue residue produced between migrations 016 and 017.
select signal_atlas.cancel_unreferenced_candle_gaps_at(pg_catalog.clock_timestamp());

revoke all on function signal_atlas.cancel_unreferenced_candle_gaps_at(timestamptz),
  signal_atlas.cancel_candle_gaps_after_outcome()
from public, anon, authenticated, service_role;

comment on column signal_atlas.candle_gaps.cancelled_at is
  'Terminal clock for queue work made unnecessary by a resolved, invalidated, or abandoned decision.';
comment on function signal_atlas.cancel_unreferenced_candle_gaps_at(timestamptz) is
  'Private lifecycle cleanup for pending gaps with no unresolved eligible decision.';

commit;
