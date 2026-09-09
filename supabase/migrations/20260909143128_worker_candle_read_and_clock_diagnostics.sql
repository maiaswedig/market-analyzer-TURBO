-- Version matches the migration applied by the Supabase management API.
begin;
create or replace function public.worker_closed_candles(
  p_symbol text, p_timeframe text, p_limit integer default 1000,
  p_offset integer default 0, p_before timestamptz default null
)
returns table(open_time timestamptz, open numeric, high numeric, low numeric,
  close numeric, volume numeric, source text, inserted_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v_asset uuid;
  v_tf signal_atlas.timeframe_code := p_timeframe::signal_atlas.timeframe_code;
begin
  if p_limit is null or p_limit not between 1 and 1000
    or p_offset is null or p_offset not between 0 and 5000 then
    raise exception using errcode='22023', message='invalid candle page bounds';
  end if;
  select a.id into v_asset from signal_atlas.assets a where a.symbol=p_symbol;
  return query select c.open_time,c.open,c.high,c.low,c.close,c.volume,c.source,c.received_at
    from signal_atlas.candles c
    where c.asset_id=v_asset and c.timeframe=v_tf and c.is_closed
      and c.close_time<=pg_catalog.statement_timestamp()
      and (p_before is null or c.open_time<=p_before)
    order by c.open_time desc limit p_limit offset p_offset;
end;
$fn$;
revoke all on function public.worker_closed_candles(text,text,integer,integer,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.worker_closed_candles(text,text,integer,integer,timestamptz)
  to service_role;

-- Preserve the existing ingestion contract verbatim except for error details.
do $diagnostic$
declare v_def text; v_old text; v_new text;
begin
  select pg_catalog.pg_get_functiondef(p.oid) into strict v_def
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='signal_atlas' and p.proname='ingest_candle';
  v_old := 'message = ''future candle/source timestamp rejected'';';
  v_new := 'message = ''future candle/source timestamp rejected'', detail = pg_catalog.jsonb_build_object(''open_time'',p_open_time,''source_observed_at'',p_source_observed_at,''database_now'',v_now,''open_ahead_ms'',extract(epoch from (p_open_time-v_now))*1000,''source_ahead_ms'',extract(epoch from (p_source_observed_at-v_now))*1000)::text;';
  if position(v_old in v_def)=0 then raise exception 'ingestion definition changed; review before applying'; end if;
  execute replace(v_def,v_old,v_new);
end;
$diagnostic$;
commit;
