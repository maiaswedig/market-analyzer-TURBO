-- Execute in a rollback transaction; synthetic values cannot enter the ledger.
do $$
declare c jsonb; result text[];
begin
 select jsonb_agg(jsonb_build_object('close_time',t,'received_at',t+interval '1s','is_closed',true,'high',101,'low',99)) into c
 from generate_series('2026-09-22 12:45Z'::timestamptz,'2026-09-22 12:55Z'::timestamptz,interval '5m') t;
 if cardinality(signal_atlas.data_quality_reasons(100,300,'2026-09-22 12:59Z',300,c))<>0 then raise exception 'valid history rejected'; end if;
 if not ('data_age_over_30s_or_unknown'=any(signal_atlas.data_quality_reasons(30001,300,'2026-09-22 12:59Z',300,c))) then raise exception 'stale feed accepted'; end if;
 if not ('source_latency_over_10s_or_unknown'=any(signal_atlas.data_quality_reasons(100,10001,'2026-09-22 12:59Z',300,c))) then raise exception 'slow source accepted'; end if;
 if not ('closed_history_missing_or_noncausal'=any(signal_atlas.data_quality_reasons(100,300,'2026-09-22 12:59Z',300,c-1))) then raise exception 'missing bar accepted'; end if;
 c:=jsonb_set(c,'{2,received_at}','"2026-09-22T13:01:00Z"');
 if not ('closed_history_missing_or_noncausal'=any(signal_atlas.data_quality_reasons(100,300,'2026-09-22 12:59Z',300,c))) then raise exception 'future data accepted'; end if;
 select jsonb_agg(jsonb_build_object('close_time',t,'received_at',t+interval '1s','is_closed',true,'high',100,'low',100)) into c
 from generate_series('2026-09-22 12:45Z'::timestamptz,'2026-09-22 12:55Z'::timestamptz,interval '5m') t;
 if not ('three_flat_closed_candles'=any(signal_atlas.data_quality_reasons(100,300,'2026-09-22 12:59Z',300,c))) then raise exception 'flat sequence accepted'; end if;
end $$;
