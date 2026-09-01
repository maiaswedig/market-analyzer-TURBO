-- The public views must remain security-invoker while avoiding a direct join
-- to the private policy ledger.  Payout/cost are read from immutable decision
-- snapshots, which are exactly the values used to resolve each paper trade.

begin;

create or replace view public.cloud_segment_metrics
with (security_invoker = true)
as
with policy_parameters as (
  select d.policy_version_id,
    avg(d.payout_ratio)::numeric as payout_ratio,
    avg(d.operation_cost)::numeric as operation_cost
  from signal_atlas.decision_events d
  group by d.policy_version_id
)
select
  m.symbol,
  m.timeframe::text as timeframe,
  m.direction::text as direction,
  m.expiration::text as expiration,
  m.mode::text as mode,
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
  0.5::numeric as benchmark_win_rate,
  (0.5 * coalesce(p.payout_ratio, 0.85)
    - 0.5 - coalesce(p.operation_cost, 0.02))::numeric as benchmark_ev_per_trade,
  (m.ev_net_per_trade - (
    0.5 * coalesce(p.payout_ratio, 0.85)
    - 0.5 - coalesce(p.operation_cost, 0.02)
  ))::numeric as edge_vs_benchmark,
  ((1 + coalesce(p.operation_cost, 0.02))
    / nullif(1 + coalesce(p.payout_ratio, 0.85), 0))::numeric
    as minimum_profitable_win_rate,
  case when m.resolved >= 300 then 'prospective_validated' else 'building_sample' end::text
    as sample_status
from public.signal_atlas_metrics m
left join policy_parameters p on p.policy_version_id = m.policy_version_id;

create or replace view public.cloud_paper_summary
with (security_invoker = true)
as
with modes(mode) as (
  values
    ('conservador'::signal_atlas.mode_code),
    ('neutro'::signal_atlas.mode_code),
    ('agressivo'::signal_atlas.mode_code)
), events as (
  select
    d.mode,
    e.event_at,
    e.paper_trade_id,
    e.pnl,
    d.payout_ratio,
    d.operation_cost,
    sum(e.pnl) over (
      partition by d.mode
      order by e.event_at, e.paper_trade_id rows unbounded preceding
    ) as equity
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  join signal_atlas.decision_events d on d.id = t.decision_event_id
  where e.event_type = 'resolved'::signal_atlas.paper_event_code
), curve as (
  select
    e.*,
    greatest(0::numeric,
      max(e.equity) over (
        partition by e.mode
        order by e.event_at, e.paper_trade_id rows unbounded preceding
      )
    ) - e.equity as drawdown
  from events e
)
select
  count(c.paper_trade_id) as trades,
  avg(c.pnl) as ev_net_per_trade,
  coalesce(sum(c.pnl), 0::numeric) as total_pnl,
  coalesce(max(c.drawdown), 0::numeric) as max_drawdown,
  max(c.event_at) as updated_at,
  m.mode::text as mode,
  coalesce(avg(0.5 * c.payout_ratio - 0.5 - c.operation_cost), -0.095)::numeric
    as benchmark_ev_per_trade,
  (avg(c.pnl) - coalesce(avg(0.5 * c.payout_ratio - 0.5 - c.operation_cost), -0.095))::numeric
    as edge_vs_benchmark
from modes m
left join curve c on c.mode = m.mode
group by m.mode;

revoke all on public.cloud_segment_metrics, public.cloud_paper_summary from public;
grant select on public.cloud_segment_metrics, public.cloud_paper_summary
  to anon, authenticated, service_role;

commit;
