begin;
set local lock_timeout='3s';
-- Version 2 starts only on future inserts. Never backfill this experiment.
alter table signal_atlas.strategy_shadow_arms drop constraint strategy_shadow_arms_arm_check;
alter table signal_atlas.strategy_shadow_arms add constraint strategy_shadow_arms_arm_check check(arm in
('technical_current','technical_inverse','grade_a_or_a_plus','always_buy','always_sell','last_closed_candle','quality_control','quality_filtered'));

create function signal_atlas.data_quality_reasons(p_age integer,p_latency integer,p_cutoff timestamptz,p_tf_seconds integer,p_candles jsonb)
returns text[] language plpgsql immutable set search_path='' as $$
declare reasons text[] := '{}'; n integer; oldest timestamptz; newest timestamptz; flat_count integer; bad integer;
begin
 if p_age is null or p_age<0 or p_age>30000 then reasons:=array_append(reasons,'data_age_over_30s_or_unknown'); end if;
 if p_latency is null or p_latency<0 or p_latency>10000 then reasons:=array_append(reasons,'source_latency_over_10s_or_unknown'); end if;
 select count(*),min((c->>'close_time')::timestamptz),max((c->>'close_time')::timestamptz),
 count(*) filter(where (c->>'high')::numeric=(c->>'low')::numeric),
 count(*) filter(where (c->>'is_closed')::boolean is distinct from true or (c->>'received_at')::timestamptz>p_cutoff or (c->>'close_time')::timestamptz>p_cutoff)
 into n,oldest,newest,flat_count,bad from jsonb_array_elements(coalesce(p_candles,'[]')) c;
 if n<>3 or bad>0 or (select count(distinct c->>'close_time') from jsonb_array_elements(coalesce(p_candles,'[]')) c)<>3
 or extract(epoch from newest-oldest)<>2*p_tf_seconds then reasons:=array_append(reasons,'closed_history_missing_or_noncausal'); end if;
 if newest is null or extract(epoch from p_cutoff-newest)>p_tf_seconds+90 then reasons:=array_append(reasons,'closed_history_stale'); end if;
 if n=3 and flat_count=3 then reasons:=array_append(reasons,'three_flat_closed_candles'); end if;
 return reasons;
end $$;
revoke all on function signal_atlas.data_quality_reasons(integer,integer,timestamptz,integer,jsonb) from public,anon,authenticated;

create function signal_atlas.freeze_data_quality_experiment()
returns trigger language plpgsql security definer set search_path='' as $$
declare candles jsonb; reasons text[]; frozen_at timestamptz:=clock_timestamp(); config jsonb;
begin
 if new.mode<>'neutro' or new.model_role<>'champion' or frozen_at>=new.entry_at then return new; end if;
 select coalesce(jsonb_agg(to_jsonb(c) order by c.close_time),'[]'::jsonb) into candles from
 (select id,open_time,close_time,open,high,low,close,is_closed,received_at from signal_atlas.candles
  where asset_id=new.asset_id and timeframe=new.timeframe and is_closed
   and close_time<=new.feature_cutoff_at and received_at<=new.feature_cutoff_at
  order by close_time desc,id desc limit 3) c;
 reasons:=signal_atlas.data_quality_reasons(new.data_age_ms,new.source_latency_ms,new.feature_cutoff_at,signal_atlas.timeframe_seconds(new.timeframe),candles);
 config:=jsonb_build_object('experiment','data_quality_v2','prospective',true,'max_data_age_ms',30000,'max_latency_ms',10000,
 'closed_candles_required',3,'max_closed_lag_seconds',signal_atlas.timeframe_seconds(new.timeframe)+90,
 'reject_three_flat',true,'min_days',20,'min_opportunities',500,'min_filtered_trades',100,'auto_promote',false,
 'reasons',to_jsonb(reasons),'closed_candles',candles,'data_age_ms',new.data_age_ms,'source_latency_ms',new.source_latency_ms);
 insert into signal_atlas.strategy_shadow_arms(decision_event_id,strategy_version,arm,action,direction,predicted_at,feature_cutoff_at,candle_set_hash,policy_hash_snapshot,config_snapshot)
 values(new.id,2,'quality_control',new.direction::text,new.direction,frozen_at,new.feature_cutoff_at,new.candle_set_hash,new.policy_hash_snapshot,config),
 (new.id,2,'quality_filtered',case when cardinality(reasons)=0 then new.direction::text else 'wait' end,
 case when cardinality(reasons)=0 then new.direction else null end,frozen_at,new.feature_cutoff_at,new.candle_set_hash,new.policy_hash_snapshot,config)
 on conflict(decision_event_id,strategy_version,arm) do nothing;
 return new;
end $$;
revoke all on function signal_atlas.freeze_data_quality_experiment() from public,anon,authenticated;
create trigger freeze_data_quality_experiment_after_decision after insert on signal_atlas.decision_events
 for each row execute function signal_atlas.freeze_data_quality_experiment();
comment on function signal_atlas.freeze_data_quality_experiment() is 'Prospective paired quality-filter experiment v2; no backfill, live-signal change or automatic promotion. Review after >=20 days, >=500 opportunities and >=100 filtered trades.';
commit;
