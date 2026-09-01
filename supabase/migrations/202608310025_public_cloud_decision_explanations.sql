-- Public, read-only explanation projection for cloud decisions.
-- The private helper keeps direct access to the immutable decision ledger
-- denied while exposing only the fields required by the frontend.

create or replace function signal_atlas.cloud_decision_explanation_rows()
returns table (
  id uuid,
  mode text,
  decision_at timestamptz,
  reasons jsonb
)
language sql
stable
security definer
set search_path = ''
as $function$
select
  d.id,
  d.mode::text,
  d.decision_at,
  case
    when pg_catalog.jsonb_typeof(d.reasons) = 'array' then d.reasons
    else '[]'::jsonb
  end
from signal_atlas.decision_events d
where d.model_role = 'champion'
  and not exists (
    select 1
    from signal_atlas.correction_events c
    where c.correction_type = 'invalidate'
      and c.target_type = 'decision'
      and c.target_id = d.id
  );
$function$;

revoke all on function signal_atlas.cloud_decision_explanation_rows() from public;
grant execute on function signal_atlas.cloud_decision_explanation_rows() to anon, authenticated, service_role;

create or replace view public.cloud_decision_explanations
with (security_invoker = true)
as
select id, mode, decision_at, reasons
from signal_atlas.cloud_decision_explanation_rows();

revoke all on public.cloud_decision_explanations from public, anon, authenticated, service_role;
grant select on public.cloud_decision_explanations to anon, authenticated, service_role;

comment on view public.cloud_decision_explanations is
  'Read-only technical explanations for non-invalidated champion decisions. Not used by ranking, training, inference, or promotion.';
