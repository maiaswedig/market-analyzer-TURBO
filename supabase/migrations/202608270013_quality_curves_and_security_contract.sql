-- Expose prospective paper performance by mode AND quality without changing,
-- deleting or reclassifying any historical event.  These projections are
-- diagnostic only: they never feed ranking, inference or model promotion.

begin;

create or replace function signal_atlas.cloud_quality_segment_metrics_rows()
returns table(
  symbol text,
  timeframe text,
  direction text,
  expiration text,
  mode text,
  quality text,
  resolved bigint,
  wins bigint,
  losses bigint,
  ties bigint,
  win_rate numeric,
  brier_score numeric,
  ev_net_per_trade numeric,
  ev_net_lb95 numeric,
  total_pnl numeric,
  first_entry_at timestamptz,
  last_expiry_at timestamptz,
  benchmark_win_rate numeric,
  benchmark_ev_per_trade numeric,
  edge_vs_benchmark numeric,
  minimum_profitable_win_rate numeric,
  sample_status text
)
language sql
security definer
set search_path = ''
as $function$
with resolved as (
  select
    a.symbol,
    d.timeframe,
    d.direction,
    d.expiration,
    d.mode,
    d.quality,
    d.probability,
    d.payout_ratio,
    d.operation_cost,
    d.entry_at,
    d.expiry_at,
    e.result,
    e.pnl
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  join signal_atlas.assets a on a.id = d.asset_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
    and not exists (
      select 1
      from signal_atlas.correction_events c
      where c.correction_type = 'invalidate'
        and ((c.target_type = 'decision' and c.target_id = d.id)
          or (c.target_type = 'paper_trade' and c.target_id = t.id)
          or (c.target_type = 'outcome' and c.target_id = e.outcome_id))
    )
), metrics as (
  select
    r.symbol,
    r.timeframe,
    r.direction,
    r.expiration,
    r.mode,
    r.quality,
    pg_catalog.count(*)::bigint as resolved,
    pg_catalog.count(*) filter (where r.result = 'win')::bigint as wins,
    pg_catalog.count(*) filter (where r.result = 'loss')::bigint as losses,
    pg_catalog.count(*) filter (where r.result = 'tie')::bigint as ties,
    pg_catalog.avg((r.result = 'win')::integer::numeric) as win_rate,
    pg_catalog.avg(pg_catalog.power(r.probability - (r.result = 'win')::integer, 2)) as brier_score,
    pg_catalog.avg(r.pnl) as ev_net_per_trade,
    case when pg_catalog.count(*) >= 2 then
      pg_catalog.avg(r.pnl) - 1.96 * pg_catalog.stddev_samp(r.pnl)
        / pg_catalog.sqrt(pg_catalog.count(*)::numeric)
    end as ev_net_lb95,
    pg_catalog.sum(r.pnl) as total_pnl,
    pg_catalog.min(r.entry_at) as first_entry_at,
    pg_catalog.max(r.expiry_at) as last_expiry_at,
    pg_catalog.avg(0.5 * r.payout_ratio - 0.5 - r.operation_cost)::numeric
      as benchmark_ev_per_trade,
    pg_catalog.avg((1 + r.operation_cost) / nullif(1 + r.payout_ratio, 0))::numeric
      as minimum_profitable_win_rate
  from resolved r
  group by r.symbol, r.timeframe, r.direction, r.expiration, r.mode, r.quality
)
select
  m.symbol,
  m.timeframe::text,
  m.direction::text,
  m.expiration::text,
  m.mode::text,
  m.quality::text,
  m.resolved,
  m.wins,
  m.losses,
  m.ties,
  m.win_rate,
  m.brier_score,
  m.ev_net_per_trade,
  m.ev_net_lb95,
  m.total_pnl,
  m.first_entry_at,
  m.last_expiry_at,
  0.5::numeric,
  m.benchmark_ev_per_trade,
  (m.ev_net_per_trade - m.benchmark_ev_per_trade)::numeric,
  m.minimum_profitable_win_rate,
  case when m.resolved >= 300 then 'prospective_validated' else 'building_sample' end::text
from metrics m
$function$;

create or replace view public.cloud_quality_segment_metrics
with (security_invoker = true)
as
select * from signal_atlas.cloud_quality_segment_metrics_rows();

create or replace function signal_atlas.cloud_quality_paper_summary_rows()
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
security definer
set search_path = ''
as $function$
with modes(mode) as (
  values
    ('conservador'::signal_atlas.mode_code),
    ('neutro'::signal_atlas.mode_code),
    ('agressivo'::signal_atlas.mode_code)
), qualities(quality) as (
  values
    ('confirmed'::signal_atlas.signal_quality_code),
    ('technical'::signal_atlas.signal_quality_code),
    ('low'::signal_atlas.signal_quality_code)
), buckets as (
  select m.mode, q.quality from modes m cross join qualities q
), events as (
  select
    d.mode,
    d.quality,
    e.event_at,
    e.paper_trade_id,
    e.result,
    e.pnl,
    d.payout_ratio,
    d.operation_cost,
    pg_catalog.sum(e.pnl) over (
      partition by d.mode, d.quality
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    ) as equity
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
    and not exists (
      select 1
      from signal_atlas.correction_events c
      where c.correction_type = 'invalidate'
        and ((c.target_type = 'decision' and c.target_id = d.id)
          or (c.target_type = 'paper_trade' and c.target_id = t.id)
          or (c.target_type = 'outcome' and c.target_id = e.outcome_id))
    )
), curve as (
  select
    e.*,
    greatest(
      0::numeric,
      pg_catalog.max(e.equity) over (
        partition by e.mode, e.quality
        order by e.event_at, e.paper_trade_id rows unbounded preceding
      )
    ) - e.equity as drawdown
  from events e
), summary as (
  select
    b.mode,
    b.quality,
    pg_catalog.count(c.paper_trade_id)::bigint as trades,
    pg_catalog.count(c.paper_trade_id) filter (where c.result = 'win')::bigint as wins,
    pg_catalog.count(c.paper_trade_id) filter (where c.result = 'loss')::bigint as losses,
    pg_catalog.count(c.paper_trade_id) filter (where c.result = 'tie')::bigint as ties,
    pg_catalog.avg((c.result = 'win')::integer::numeric) as win_rate,
    pg_catalog.avg(c.pnl) as ev_net_per_trade,
    coalesce(pg_catalog.sum(c.pnl), 0::numeric) as total_pnl,
    coalesce(pg_catalog.max(c.drawdown), 0::numeric) as max_drawdown,
    pg_catalog.max(c.event_at) as updated_at,
    coalesce(pg_catalog.avg(0.5 * c.payout_ratio - 0.5 - c.operation_cost), -0.095)::numeric
      as benchmark_ev_per_trade
  from buckets b
  left join curve c on c.mode = b.mode and c.quality = b.quality
  group by b.mode, b.quality
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
  s.mode::text,
  s.quality::text,
  s.benchmark_ev_per_trade,
  case when s.trades > 0 then
    (s.ev_net_per_trade - s.benchmark_ev_per_trade)::numeric
  end,
  case when s.trades >= 300 then 'prospective_validated' else 'building_sample' end::text
from summary s
$function$;

create or replace view public.cloud_quality_paper_summary
with (security_invoker = true)
as
select * from signal_atlas.cloud_quality_paper_summary_rows();

-- Preserve deny-by-default on the private ledger.  Only the two argument-free,
-- fixed-search-path projections and their public read-only views are exposed.
revoke all on function signal_atlas.cloud_quality_segment_metrics_rows(),
  signal_atlas.cloud_quality_paper_summary_rows()
from public, anon, authenticated, service_role;
grant execute on function signal_atlas.cloud_quality_segment_metrics_rows(),
  signal_atlas.cloud_quality_paper_summary_rows()
to anon, authenticated, service_role;

revoke all on public.cloud_quality_segment_metrics,
  public.cloud_quality_paper_summary
from public, anon, authenticated, service_role;
grant select on public.cloud_quality_segment_metrics,
  public.cloud_quality_paper_summary
to anon, authenticated, service_role;

comment on view public.cloud_quality_segment_metrics is
  'Prospective paper outcomes separated by mode and immutable emission quality; diagnostic only.';
comment on view public.cloud_quality_paper_summary is
  'Prospective paper curves separated by mode and immutable emission quality; never used for ranking or promotion.';

commit;
