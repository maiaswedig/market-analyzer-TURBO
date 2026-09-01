-- Single operational policy. Historical mode decisions and economics remain
-- immutable; only future neutral decisions use zero additional operation cost.

begin;

with current_neutral as (
  select p.config
  from signal_atlas.policy_versions p
  where p.mode = 'neutro'::signal_atlas.mode_code
    and p.effective_from <= pg_catalog.clock_timestamp()
  order by p.effective_from desc, p.version desc, p.id desc
  limit 1
), prepared as (
  select config || pg_catalog.jsonb_build_object(
    'operation_cost', 0,
    'operating_policy', 'single',
    'ui_mode_label', 'politica_unica'
  ) as config
  from current_neutral
)
insert into signal_atlas.policy_versions(
  policy_key, mode, version, config, config_hash, effective_from, notes
)
select
  'cloud-engine-single',
  'neutro'::signal_atlas.mode_code,
  1,
  p.config,
  pg_catalog.md5(p.config::text),
  pg_catalog.clock_timestamp(),
  'Política operacional única para novas decisões; custo adicional zero. Histórico dos três modos permanece imutável.'
from prepared p
on conflict (policy_key, mode, version) do nothing;

create or replace function signal_atlas.cloud_single_paper_summary_rows()
returns table(
  trades bigint,
  ev_net_per_trade numeric,
  total_pnl numeric,
  max_drawdown numeric,
  updated_at timestamptz,
  mode text,
  benchmark_ev_per_trade numeric,
  edge_vs_benchmark numeric
)
language sql
stable
security definer
set search_path = ''
as $function$
with active_policy as (
  select p.id
  from signal_atlas.policy_versions p
  where p.policy_key = 'cloud-engine-single'
    and p.mode = 'neutro'::signal_atlas.mode_code
    and p.version = 1
  order by p.effective_from desc, p.id desc
  limit 1
), events as (
  select
    e.event_at,
    e.paper_trade_id,
    e.pnl,
    d.payout_ratio,
    d.operation_cost,
    pg_catalog.sum(e.pnl) over (
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    ) as equity
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
    and d.policy_version_id = (select id from active_policy)
    and not exists (
      select 1 from signal_atlas.correction_events c
      where c.correction_type = 'invalidate'
        and ((c.target_type = 'decision' and c.target_id = d.id)
          or (c.target_type = 'paper_trade' and c.target_id = t.id)
          or (c.target_type = 'outcome' and c.target_id = e.outcome_id))
    )
), curve as (
  select
    e.*,
    greatest(0::numeric, pg_catalog.max(e.equity) over (
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    )) - e.equity as drawdown
  from events e
), summary as (
  select
    pg_catalog.count(c.paper_trade_id)::bigint as trades,
    pg_catalog.avg(c.pnl) as ev_net_per_trade,
    coalesce(pg_catalog.sum(c.pnl), 0::numeric) as total_pnl,
    coalesce(pg_catalog.max(c.drawdown), 0::numeric) as max_drawdown,
    pg_catalog.max(c.event_at) as updated_at,
    coalesce(pg_catalog.avg(0.5 * c.payout_ratio - 0.5 - c.operation_cost), -0.075)::numeric as benchmark_ev_per_trade
  from curve c
)
select
  s.trades,
  s.ev_net_per_trade,
  s.total_pnl,
  s.max_drawdown,
  s.updated_at,
  'neutro'::text,
  s.benchmark_ev_per_trade,
  case when s.trades > 0 then (s.ev_net_per_trade - s.benchmark_ev_per_trade)::numeric end
from summary s
$function$;

create or replace view public.cloud_single_paper_summary
with (security_invoker = true)
as select * from signal_atlas.cloud_single_paper_summary_rows();

create or replace function signal_atlas.cloud_single_quality_paper_summary_rows()
returns table(
  trades bigint,
  wins bigint,
  losses bigint,
  ties bigint,
  win_rate numeric,
  ev_net_per_trade numeric,
  total_pnl numeric,
  max_drawdown numeric,
  updated_at timestamptz,
  mode text,
  quality text,
  benchmark_ev_per_trade numeric,
  edge_vs_benchmark numeric,
  sample_status text
)
language sql
stable
security definer
set search_path = ''
as $function$
with active_policy as (
  select p.id
  from signal_atlas.policy_versions p
  where p.policy_key = 'cloud-engine-single'
    and p.mode = 'neutro'::signal_atlas.mode_code
    and p.version = 1
  order by p.effective_from desc, p.id desc
  limit 1
), qualities(quality) as (
  values
    ('confirmed'::signal_atlas.signal_quality_code),
    ('technical'::signal_atlas.signal_quality_code),
    ('low'::signal_atlas.signal_quality_code)
), events as (
  select
    d.quality,
    e.event_at,
    e.paper_trade_id,
    e.result,
    e.pnl,
    d.payout_ratio,
    d.operation_cost,
    pg_catalog.sum(e.pnl) over (
      partition by d.quality
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    ) as equity
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
    and d.policy_version_id = (select id from active_policy)
    and not exists (
      select 1 from signal_atlas.correction_events c
      where c.correction_type = 'invalidate'
        and ((c.target_type = 'decision' and c.target_id = d.id)
          or (c.target_type = 'paper_trade' and c.target_id = t.id)
          or (c.target_type = 'outcome' and c.target_id = e.outcome_id))
    )
), curve as (
  select
    e.*,
    greatest(0::numeric, pg_catalog.max(e.equity) over (
      partition by e.quality
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    )) - e.equity as drawdown
  from events e
), summary as (
  select
    q.quality,
    pg_catalog.count(c.paper_trade_id)::bigint as trades,
    pg_catalog.count(c.paper_trade_id) filter (where c.result = 'win')::bigint as wins,
    pg_catalog.count(c.paper_trade_id) filter (where c.result = 'loss')::bigint as losses,
    pg_catalog.count(c.paper_trade_id) filter (where c.result = 'tie')::bigint as ties,
    pg_catalog.avg((c.result = 'win')::integer::numeric) as win_rate,
    pg_catalog.avg(c.pnl) as ev_net_per_trade,
    coalesce(pg_catalog.sum(c.pnl), 0::numeric) as total_pnl,
    coalesce(pg_catalog.max(c.drawdown), 0::numeric) as max_drawdown,
    pg_catalog.max(c.event_at) as updated_at,
    coalesce(pg_catalog.avg(0.5 * c.payout_ratio - 0.5 - c.operation_cost), -0.075)::numeric as benchmark_ev_per_trade
  from qualities q
  left join curve c on c.quality = q.quality
  group by q.quality
)
select
  s.trades,
  s.wins,
  s.losses,
  s.ties,
  s.win_rate,
  s.ev_net_per_trade,
  s.total_pnl,
  s.max_drawdown,
  s.updated_at,
  'neutro'::text,
  s.quality::text,
  s.benchmark_ev_per_trade,
  case when s.trades > 0 then (s.ev_net_per_trade - s.benchmark_ev_per_trade)::numeric end,
  case when s.trades >= 300 then 'prospective_validated' else 'building_sample' end::text
from summary s
$function$;

create or replace view public.cloud_single_quality_paper_summary
with (security_invoker = true)
as select * from signal_atlas.cloud_single_quality_paper_summary_rows();

revoke all on function signal_atlas.cloud_single_paper_summary_rows(),
  signal_atlas.cloud_single_quality_paper_summary_rows()
from public, anon, authenticated, service_role;
grant execute on function signal_atlas.cloud_single_paper_summary_rows(),
  signal_atlas.cloud_single_quality_paper_summary_rows()
to anon, authenticated, service_role;

revoke all on public.cloud_single_paper_summary,
  public.cloud_single_quality_paper_summary
from public, anon, authenticated, service_role;
grant select on public.cloud_single_paper_summary,
  public.cloud_single_quality_paper_summary
to anon, authenticated, service_role;

comment on view public.cloud_single_paper_summary is
  'Current single-policy prospective paper curve. Historical three-mode views remain unchanged for audit.';
comment on view public.cloud_single_quality_paper_summary is
  'Current single-policy prospective paper curves separated by immutable emission quality.';

commit;
