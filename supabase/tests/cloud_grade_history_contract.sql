-- Run after migration 024. Read-only contract for the public A/A+ projection.

begin;

do $test$
begin
  if exists (
    select 1 from public.cloud_grade_history
    where grade not in ('A', 'A+')
  ) then
    raise exception 'cloud_grade_history exposed a non-A/A+ decision';
  end if;

  if exists (
    select 1 from public.cloud_grade_history
    where outcome in ('win', 'loss', 'tie')
      and (resolved_at is null or resolved_at < expiry_at)
  ) then
    raise exception 'cloud_grade_history exposed a prematurely resolved outcome';
  end if;

  if exists (
    select 1 from public.cloud_grade_history h
    join signal_atlas.correction_events c
      on c.target_type = 'decision'
     and c.target_id = h.id
     and c.correction_type = 'invalidate'
  ) then
    raise exception 'cloud_grade_history exposed an invalidated decision';
  end if;
end
$test$;

set local role anon;
select * from public.cloud_grade_history limit 0;
reset role;

set local role authenticated;
select * from public.cloud_grade_history limit 0;
reset role;

rollback;
