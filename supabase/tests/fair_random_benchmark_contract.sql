-- Run inside a rollback transaction after the fair benchmark migration.
do $test$
declare expected numeric; observed numeric; lab_random numeric; lab_sides numeric;
begin
  -- Independent reference: a fair coin is the average of buying and selling
  -- the exact same realized candle, under the frozen stake/payout/tie rules.
  with economics as materialized (
  select sign(o.close_price-o.entry_price) as move, d.stake,d.payout_ratio,d.operation_cost,d.tie_policy,count(*) as n
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id=e.paper_trade_id
  join signal_atlas.decision_events d on d.id=t.decision_event_id
  join signal_atlas.outcomes o on o.id=e.outcome_id
  where e.event_type='resolved' and d.policy_version_id=(select p.id from signal_atlas.policy_versions p where p.policy_key='cloud-engine-single' and p.version=1 and p.mode='neutro' order by p.effective_from desc,p.id desc limit 1)
    and not exists (select 1 from signal_atlas.correction_events c where c.correction_type='invalidate' and c.target_type='decision' and c.target_id=d.id)
    and not exists (select 1 from signal_atlas.correction_events c where c.correction_type='invalidate' and c.target_type='paper_trade' and c.target_id=t.id)
    and not exists (select 1 from signal_atlas.correction_events c where c.correction_type='invalidate' and c.target_type='outcome' and c.target_id=o.id)
  group by sign(o.close_price-o.entry_price),d.stake,d.payout_ratio,d.operation_cost,d.tie_policy
  )
  select sum(n*(signal_atlas.trade_pnl('buy',100,100+move,stake,payout_ratio,operation_cost,tie_policy)
              +signal_atlas.trade_pnl('sell',100,100+move,stake,payout_ratio,operation_cost,tie_policy))/2)/sum(n)
  into expected from economics;
  select benchmark_ev_per_trade into observed from signal_atlas.cloud_single_paper_summary_rows();
  if expected is null or observed is null or abs(expected-observed)>0.000000001 then raise exception 'Random benchmark does not match realized economics'; end if;
  select avg(ev_per_opportunity),avg(coverage_matched_random_ev) into lab_sides,lab_random
  from signal_atlas.strategy_lab_summary_rows() where arm in ('always_buy','always_sell');
  if abs(lab_random-lab_sides)>0.000000001 then raise exception 'Strategy benchmark does not match both directions'; end if;
  -- Basic tie policies and non-unit stake are part of the economic contract.
  if (signal_atlas.trade_pnl('buy',100,100,2,0.85,0.1,'loss') + signal_atlas.trade_pnl('sell',100,100,2,0.85,0.1,'loss'))/2 <> -2.1 then raise exception 'tie loss'; end if;
  if (signal_atlas.trade_pnl('buy',100,100,2,0.85,0.1,'refund') + signal_atlas.trade_pnl('sell',100,100,2,0.85,0.1,'refund'))/2 <> -0.1 then raise exception 'tie refund'; end if;
  if (signal_atlas.trade_pnl('buy',100,100,2,0.85,0.1,'win') + signal_atlas.trade_pnl('sell',100,100,2,0.85,0.1,'win'))/2 <> 1.6 then raise exception 'tie win'; end if;
end $test$;
