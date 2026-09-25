-- Read-only future review. No promotion or retrospective parameter tuning.
with scored as materialized (
 select s.decision_event_id,s.arm,s.action,(d.entry_at at time zone 'UTC')::date as trading_day,
 case when s.action='wait' then 0 else signal_atlas.trade_pnl(s.direction,o.entry_price,o.close_price,d.stake,d.payout_ratio,d.operation_cost,d.tie_policy) end pnl
 from signal_atlas.strategy_shadow_arms s
 join signal_atlas.decision_events d on d.id=s.decision_event_id
 join signal_atlas.outcomes o on o.decision_event_id=d.id
 where s.strategy_version=2 and s.arm in ('quality_control','quality_filtered')
 and s.predicted_at<d.entry_at and o.resolved_at>=d.expiry_at
 and not exists(select 1 from signal_atlas.correction_events c where c.correction_type='invalidate' and c.target_type='decision' and c.target_id=d.id)
 and not exists(select 1 from signal_atlas.correction_events c where c.correction_type='invalidate' and c.target_type='outcome' and c.target_id=o.id)
), paired as (
 select decision_event_id,min(trading_day) as trading_day,
 max(pnl) filter(where arm='quality_control') control_pnl,
 max(pnl) filter(where arm='quality_filtered') filtered_pnl,
 bool_or(arm='quality_filtered' and action<>'wait') filtered_trade
 from scored group by decision_event_id having count(*)=2
), daily as (
 select trading_day,avg(filtered_pnl-control_pnl) delta from paired group by trading_day
), uncertainty as (
 select avg(delta)-1.96*stddev_samp(delta)/sqrt(count(*)) delta_lb95 from daily
)
select count(*) opportunities,count(distinct trading_day) days,
 count(*) filter(where filtered_trade) filtered_trades,
 avg(control_pnl) control_ev_per_opportunity,avg(filtered_pnl) filtered_ev_per_opportunity,
 avg(filtered_pnl-control_pnl) paired_delta,
 (select delta_lb95 from uncertainty) daily_delta_lb95,
 count(*)>=500 and count(distinct trading_day)>=20 and count(*) filter(where filtered_trade)>=100 as review_ready,
 false as automatic_promotion
from paired;
