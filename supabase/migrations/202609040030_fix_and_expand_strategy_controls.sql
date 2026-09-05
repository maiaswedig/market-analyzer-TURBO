begin;

-- Migration 029 intentionally created a prospective-only laboratory, but the
-- canonical grade is stored in feature_snapshot rather than a physical grade
-- column. Correct that lookup before collecting the first usable sample and
-- add the simple baselines requested by the diagnostic protocol.
alter table signal_atlas.strategy_shadow_arms
  drop constraint if exists strategy_shadow_arms_arm_check;
alter table signal_atlas.strategy_shadow_arms
  add constraint strategy_shadow_arms_arm_check check (arm in (
    'technical_current',
    'technical_inverse',
    'grade_a_or_a_plus',
    'always_buy',
    'always_sell',
    'last_closed_candle'
  ));

create or replace function signal_atlas.freeze_strategy_shadow_arms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_inverse signal_atlas.direction_code;
  v_grade text;
  v_last_candle_direction signal_atlas.direction_code;
  v_last_candle_action text;
begin
  if new.mode <> 'neutro' then
    return new;
  end if;
  if new.decision_at >= new.entry_at then
    raise exception using errcode = '23514',
      message = 'strategy shadow must be frozen before entry';
  end if;

  v_inverse := case when new.direction = 'buy' then 'sell' else 'buy' end;
  v_grade := pg_catalog.upper(coalesce(new.feature_snapshot->>'grade', ''));

  -- Only a candle already closed at the frozen feature cutoff may influence
  -- this baseline. A doji is WAIT; no future or live close is consulted.
  select case
    when c.close > c.open then 'buy'::signal_atlas.direction_code
    when c.close < c.open then 'sell'::signal_atlas.direction_code
    else null
  end into v_last_candle_direction
  from signal_atlas.candles c
  where c.asset_id = new.asset_id
    and c.timeframe = new.timeframe
    and c.is_closed
    and c.close_time <= new.feature_cutoff_at
  order by c.close_time desc, c.id desc
  limit 1;
  v_last_candle_action := coalesce(v_last_candle_direction::text, 'wait');

  insert into signal_atlas.strategy_shadow_arms(
    decision_event_id, strategy_version, arm, action, direction,
    predicted_at, feature_cutoff_at, candle_set_hash,
    policy_hash_snapshot, config_snapshot
  ) values
  (
    new.id, 1, 'technical_current', new.direction::text, new.direction,
    new.decision_at, new.feature_cutoff_at, new.candle_set_hash,
    new.policy_hash_snapshot,
    pg_catalog.jsonb_build_object('prospective', true, 'selection', 'all canonical technical directions', 'purpose', 'current-strategy control; diagnostic only')
  ),
  (
    new.id, 1, 'technical_inverse', v_inverse::text, v_inverse,
    new.decision_at, new.feature_cutoff_at, new.candle_set_hash,
    new.policy_hash_snapshot,
    pg_catalog.jsonb_build_object('prospective', true, 'selection', 'opposite of canonical technical direction', 'purpose', 'anti-signal diagnostic; never auto-applied')
  ),
  (
    new.id, 1, 'grade_a_or_a_plus',
    case when v_grade in ('A', 'A+') then new.direction::text else 'wait' end,
    case when v_grade in ('A', 'A+') then new.direction else null end,
    new.decision_at, new.feature_cutoff_at, new.candle_set_hash,
    new.policy_hash_snapshot,
    pg_catalog.jsonb_build_object('prospective', true, 'selection', 'trade canonical direction only for grades A or A+', 'grade_snapshot', v_grade, 'purpose', 'tests whether the visible grade adds selection value')
  ),
  (
    new.id, 1, 'always_buy', 'buy', 'buy',
    new.decision_at, new.feature_cutoff_at, new.candle_set_hash,
    new.policy_hash_snapshot,
    pg_catalog.jsonb_build_object('prospective', true, 'selection', 'always buy', 'purpose', 'simple directional baseline')
  ),
  (
    new.id, 1, 'always_sell', 'sell', 'sell',
    new.decision_at, new.feature_cutoff_at, new.candle_set_hash,
    new.policy_hash_snapshot,
    pg_catalog.jsonb_build_object('prospective', true, 'selection', 'always sell', 'purpose', 'simple directional baseline')
  ),
  (
    new.id, 1, 'last_closed_candle', v_last_candle_action, v_last_candle_direction,
    new.decision_at, new.feature_cutoff_at, new.candle_set_hash,
    new.policy_hash_snapshot,
    pg_catalog.jsonb_build_object('prospective', true, 'selection', 'repeat direction of latest candle closed by feature cutoff; doji waits', 'purpose', 'simple momentum baseline')
  )
  on conflict (decision_event_id, strategy_version, arm) do nothing;

  return new;
end
$function$;

comment on function signal_atlas.freeze_strategy_shadow_arms() is
  'Freezes six prospective controls before entry; grade comes from canonical feature_snapshot and the last-candle arm uses only an already closed candle.';

commit;
