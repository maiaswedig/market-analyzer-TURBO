-- Permanent live-ledger anti-lookahead checks. Any row matching one of these
-- predicates is a release-blocking causal violation.

do $test$
declare
  v_count bigint;
begin
  select count(*) into v_count
  from signal_atlas.decision_events d
  where d.feature_cutoff_at > d.decision_at
     or d.source_received_at > d.decision_at
     or d.decision_at >= d.entry_at
     or d.source_candle_open_time >= d.entry_at
     or d.entry_at >= d.expiry_at;
  if v_count > 0 then
    raise exception 'causality regression: % decisions use late data or invalid clocks', v_count;
  end if;

  select count(*) into v_count
  from signal_atlas.shadow_predictions s
  join signal_atlas.decision_events d on d.id = s.decision_event_id
  join signal_atlas.model_artifacts m on m.id = s.model_artifact_id
  where s.feature_cutoff_at > s.predicted_at
     or s.predicted_at >= d.entry_at
     or m.created_at > s.predicted_at;
  if v_count > 0 then
    raise exception 'causality regression: % shadow predictions were not frozen before entry', v_count;
  end if;

  select count(*) into v_count
  from signal_atlas.policy_shadow_decisions s
  join signal_atlas.decision_events d on d.id = s.decision_event_id
  left join signal_atlas.model_artifacts m on m.id = s.model_artifact_id
  where d.mode <> 'neutro'
     or s.feature_cutoff_at > s.predicted_at
     or s.predicted_at >= d.entry_at
     or (m.id is not null and m.created_at > s.predicted_at)
     or (s.evaluation_role = 'heuristic' and s.model_artifact_id is not null)
     or (s.evaluation_role <> 'heuristic' and s.model_artifact_id is null);
  if v_count > 0 then
    raise exception 'causality regression: % independent policy shadows violate canonical clocks/roles', v_count;
  end if;

  select count(*) into v_count
  from signal_atlas.outcomes o
  join signal_atlas.decision_events d on d.id = o.decision_event_id
  join signal_atlas.candles ec on ec.id = o.entry_candle_id
  join signal_atlas.candles xc on xc.id = o.expiry_candle_id
  where o.resolved_at < d.expiry_at
     or o.expiry_at <> d.expiry_at
     or o.entry_at <> d.entry_at
     or ec.open_time <> d.entry_at
     or xc.close_time <> d.expiry_at
     or not ec.is_closed
     or not xc.is_closed;
  if v_count > 0 then
    raise exception 'causality regression: % outcomes use an early or mismatched candle', v_count;
  end if;

  select count(*) into v_count
  from signal_atlas.paper_trade_events e
  join signal_atlas.paper_trades t on t.id = e.paper_trade_id
  where e.event_type = 'resolved'
    and e.event_at < t.scheduled_expiry_at;
  if v_count > 0 then
    raise exception 'causality regression: % paper outcomes were resolved before expiry', v_count;
  end if;

  select count(*) into v_count
  from signal_atlas.promotion_reviews r
  where r.comparison_version = 2
    and r.passed
    and (r.unique_opportunities < 500
      or r.distinct_days < 20
      or r.challenger_trades < 100
      or r.delta_ev_lb95 <= 0
      or r.delta_ev_vs_heuristic_lb95 <= 0);
  if v_count > 0 then
    raise exception 'causality regression: % independent promotions bypass statistical gates', v_count;
  end if;

  select count(*) into v_count
  from signal_atlas.resolution_abandonments a
  join signal_atlas.decision_events d on d.id = a.decision_event_id
  join signal_atlas.candle_gaps g on g.id = a.candle_gap_id
  where a.abandoned_at < d.expiry_at
     or g.status <> 'permanently_missing'
     or g.asset_id <> d.asset_id
     or g.timeframe <> d.timeframe
     or not (
       (g.missing_kind = 'entry' and g.missing_time = d.entry_at)
       or (g.missing_kind = 'expiry' and g.missing_time = d.expiry_at)
     );
  if v_count > 0 then
    raise exception 'causality regression: % abandonments do not match an exact expired decision gap', v_count;
  end if;

  select count(*) into v_count
  from signal_atlas.resolution_abandonments a
  join signal_atlas.outcomes o on o.decision_event_id = a.decision_event_id;
  if v_count > 0 then
    raise exception 'causality regression: % terminal abandonments also have outcomes', v_count;
  end if;

  select count(*) into v_count
  from signal_atlas.candle_gaps g
  where g.status = 'cancelled'
    and (
      g.cancelled_at is null
      or exists (
        select 1
        from signal_atlas.decision_events d
        where d.asset_id = g.asset_id and d.timeframe = g.timeframe
          and d.expiry_at <= g.cancelled_at
          and not exists (
            select 1 from signal_atlas.outcomes o where o.decision_event_id = d.id
          )
          and not exists (
            select 1 from signal_atlas.resolution_abandonments a where a.decision_event_id = d.id
          )
          and not exists (
            select 1 from signal_atlas.correction_events ce
            where ce.target_type = 'decision' and ce.target_id = d.id
              and ce.correction_type = 'invalidate'
          )
          and (
            (g.missing_kind = 'entry' and d.entry_at = g.missing_time)
            or (g.missing_kind = 'expiry' and d.expiry_at = g.missing_time)
          )
      )
    );
  if v_count > 0 then
    raise exception 'causality regression: % cancelled gaps still had eligible unresolved work', v_count;
  end if;
end
$test$;
