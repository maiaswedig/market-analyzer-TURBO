with base as materialized (
select a.symbol,d.timeframe::text timeframe,coalesce(nullif(d.feature_snapshot->>'grade',''),'D') grade,d.direction::text direction,
case when extract(hour from d.decision_at at time zone 'UTC')<8 then '00-08 UTC' when extract(hour from d.decision_at at time zone 'UTC')<16 then '08-16 UTC' else '16-24 UTC' end session,
(d.decision_at at time zone 'UTC')::date trading_day,o.decision_result result,e.pnl,d.payout_ratio,d.operation_cost,d.tie_policy::text tie_policy
from signal_atlas.paper_trade_events e join signal_atlas.paper_trades t on t.id=e.paper_trade_id
join signal_atlas.decision_events d on d.id=t.decision_event_id join signal_atlas.outcomes o on o.id=e.outcome_id
join signal_atlas.assets a on a.id=d.asset_id join signal_atlas.policy_versions p on p.id=d.policy_version_id
where e.event_type='resolved' and p.policy_key='cloud-engine-single' and p.version=1 and d.mode='neutro'
and d.decision_at<'2026-09-21T23:40:00Z'
and not exists(select 1 from signal_atlas.correction_events c where c.correction_type='invalidate'
and ((c.target_type='decision' and c.target_id=d.id) or (c.target_type='paper_trade' and c.target_id=t.id) or (c.target_type='outcome' and c.target_id=o.id)))
), agg as (
select case when grouping(symbol,timeframe,grade,direction,session,trading_day)=63 then 'total'
when grouping(trading_day)=0 then 'trading_day' when grouping(session)=0 then 'session'
when grouping(direction)=0 then 'direction' when grouping(symbol)=0 and grouping(grade)=0 then 'asset_tf_grade'
when grouping(symbol)=0 then 'asset_tf' else 'grade' end dimension,
symbol,timeframe,grade,direction,session,trading_day,count(*) n,
count(*) filter(where result='win') wins,count(*) filter(where result='loss') losses,count(*) filter(where result='tie') ties,
sum(pnl) pnl,avg(pnl) ev,avg(payout_ratio) payout,avg(operation_cost) cost,
count(distinct trading_day) days,min(trading_day) first_day,max(trading_day) last_day
from base group by grouping sets ((),(symbol,timeframe),(grade),(direction),(session),(trading_day),(symbol,timeframe,grade))
)
select * from agg order by dimension,symbol,timeframe,grade,trading_day;
