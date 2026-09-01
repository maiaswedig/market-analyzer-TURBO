-- Make cloud comparison mode-aware and rank opportunities with an auditable
-- composite.  Historical performance remains strictly prospective and is
-- never mixed with offline/backtest results.

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
    - 0.5 - coalesce(p.operation_cost, 0.02))::numeric
    as benchmark_ev_per_trade,
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

create or replace view public.cloud_opportunities
with (security_invoker = true)
as
with base as (
  select
    o.id,
    o.symbol,
    o.market,
    o.timeframe::text as timeframe,
    o.mode::text as mode,
    o.direction::text as direction,
    o.expiration::text as expiration,
    o.quality::text as quality,
    o.score,
    o.probability,
    d.statistical_sample_size as sample_size,
    o.expected_ev as ev_net,
    d.decision_at,
    o.entry_at,
    o.expiry_at,
    o.data_age_ms,
    o.source_latency_ms,
    o.used_live_candle,
    coalesce(o.reasons->>0, 'Oportunidade prospectiva aguardando entrada.') as reason,
    coalesce(nullif(d.feature_snapshot->>'grade', ''), 'D') as grade,
    coalesce(m.resolved, 0)::bigint as resolved,
    m.win_rate as historical_win_rate,
    m.ev_net_per_trade as historical_ev_net,
    0.5::numeric as benchmark_win_rate,
    (0.5 * d.payout_ratio - 0.5 - d.operation_cost)::numeric as benchmark_ev_per_trade,
    ((coalesce(m.wins, 0) + 25.0) / (coalesce(m.resolved, 0) + 50.0))::numeric
      as shrunk_win_rate,
    case coalesce(nullif(d.feature_snapshot->>'grade', ''), 'D')
      when 'A+' then 100 when 'A' then 92 when 'B' then 78
      when 'C' then 62 else 45 end::numeric as grade_score,
    case o.quality::text
      when 'confirmed' then 100 when 'technical' then 75 else 45 end::numeric
      as quality_score
  from public.signal_atlas_opportunities o
  join signal_atlas.decision_events d on d.id = o.id
  left join public.signal_atlas_metrics m
    on m.symbol = o.symbol
   and m.timeframe = o.timeframe
   and m.direction = o.direction
   and m.expiration = o.expiration
   and m.mode = o.mode
   and m.model_artifact_id = o.model_artifact_id
   and m.policy_version_id = o.policy_version_id
), scored as (
  select b.*,
    (
      0.35 * coalesce(b.probability_lb, 0.5) * 100
      + 0.25 * coalesce(b.score, 50)
      + 0.25 * b.shrunk_win_rate * 100
      + 0.10 * b.grade_score
      + 0.05 * b.quality_score
    )::numeric as ranking_score
  from (
    select base.*,
      greatest(0::numeric,
        base.probability - 1.5 * sqrt(
          greatest(0::numeric, base.probability * (1 - base.probability))
          / greatest(base.sample_size, 1)
        )
      ) as probability_lb
    from base
  ) b
)
select
  s.id,
  s.symbol,
  s.market,
  s.timeframe,
  s.mode,
  s.direction,
  s.expiration,
  s.quality,
  s.score,
  s.probability,
  s.sample_size,
  s.ev_net,
  s.decision_at,
  s.entry_at,
  s.expiry_at,
  s.data_age_ms,
  s.source_latency_ms,
  s.used_live_candle,
  s.reason,
  row_number() over (
    order by s.ranking_score desc, s.probability_lb desc,
             s.score desc, s.entry_at, s.id
  ) as rank,
  s.grade,
  s.resolved,
  s.historical_win_rate,
  s.historical_ev_net,
  s.benchmark_win_rate,
  s.benchmark_ev_per_trade,
  s.probability_lb,
  s.shrunk_win_rate,
  s.ranking_score,
  case when s.resolved >= 300 then 'prospective_validated' else 'building_sample' end::text
    as sample_status
from scored s;

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

revoke all on public.cloud_segment_metrics, public.cloud_opportunities,
  public.cloud_paper_summary from public;
grant select on public.cloud_segment_metrics, public.cloud_opportunities,
  public.cloud_paper_summary to anon, authenticated, service_role;

comment on view public.cloud_opportunities is
  'Pending prospective opportunities ranked by conservative model probability, technical score, shrinkage-adjusted real win rate, grade and quality. Offline backtests are excluded.';
comment on view public.cloud_paper_summary is
  'Paper-trading curve separated by operation mode so simultaneous policy trials are never added as one bankroll.';

commit;
