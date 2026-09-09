begin;
do $test$
declare a timestamptz[]; b timestamptz[];
begin
  select array_agg(open_time order by open_time desc) into a
  from public.worker_closed_candles('BTCUSDT','M5',320);
  select array_agg(open_time order by open_time desc) into b from (
    select open_time from public.candles where symbol='BTCUSDT' and timeframe='M5'
    and is_closed and close_time<=statement_timestamp() order by open_time desc limit 320
  ) q;
  if a is distinct from b then raise exception 'reader changed candle history'; end if;
  if has_function_privilege('anon','public.worker_closed_candles(text,text,integer,integer,timestamptz)','EXECUTE')
    or has_function_privilege('authenticated','public.worker_closed_candles(text,text,integer,integer,timestamptz)','EXECUTE') then
    raise exception 'private candle reader exposed';
  end if;
  begin
    perform * from public.worker_closed_candles('BTCUSDT','M5',1001);
    raise exception 'unbounded page accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$test$;
rollback;
