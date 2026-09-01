-- Signal Atlas — validação somente leitura da hipótese de direção
-- Execute no SQL Editor do projeto Supabase ativo.
-- Não altera tabelas, políticas, modelos ou histórico.
--
-- Importante: decision_events.model_artifact_id é obrigatório. Portanto,
-- procurar a frase "champion causal ainda não disponível" nos eventos gravados
-- NÃO separa ausência de modelo. O corte correto distingue artefato existente
-- que falhou nos gates (usable=false) de modelo validado (usable=true).
-- O PnL vem de paper_trade_events para respeitar a tie_policy congelada.

-- 1) EV e acerto por estado de validação do artefato usado na decisão.
select
  case
    when coalesce((ma.validation_metrics->>'usable')::boolean, false)
      then 'modelo_validado_utilizavel'
    else 'modelo_existente_nao_validado'
  end as estado_modelo,
  count(*) as n,
  round(100.0 * avg((o.decision_result = 'win')::int), 2) as taxa_acerto_pct,
  round(avg(pe.pnl)::numeric, 4) as ev_liquido_medio
from signal_atlas.decision_events de
join signal_atlas.model_artifacts ma on ma.id = de.model_artifact_id
join signal_atlas.outcomes o on o.decision_event_id = de.id
join signal_atlas.paper_trades pt on pt.decision_event_id = de.id
join signal_atlas.paper_trade_events pe
  on pe.paper_trade_id = pt.id
 and pe.event_type = 'resolved'
where de.quality in ('low', 'technical', 'confirmed')
group by 1
order by 1;

-- 2) A direção é escolhida pela fórmula técnica; probability é a
-- probabilidade do champion condicionada àquela direção. Este corte mede se
-- a fórmula escolheu o mesmo lado favorecido pelo modelo (>= 0,5).
select
  case
    when coalesce((ma.validation_metrics->>'usable')::boolean, false)
      then 'modelo_validado_utilizavel'
    else 'modelo_existente_nao_validado'
  end as estado_modelo,
  case when de.probability >= 0.5
    then 'modelo_concorda_com_direcao_escolhida'
    else 'modelo_discorda_da_direcao_escolhida'
  end as concordancia,
  count(*) as n,
  round(100.0 * avg((o.decision_result = 'win')::int), 2) as taxa_acerto_pct,
  round(avg(pe.pnl)::numeric, 4) as ev_liquido_medio
from signal_atlas.decision_events de
join signal_atlas.model_artifacts ma on ma.id = de.model_artifact_id
join signal_atlas.outcomes o on o.decision_event_id = de.id
join signal_atlas.paper_trades pt on pt.decision_event_id = de.id
join signal_atlas.paper_trade_events pe
  on pe.paper_trade_id = pt.id
 and pe.event_type = 'resolved'
where de.quality in ('low', 'technical', 'confirmed')
group by 1, 2
order by 1, 2;

-- 3) Evita que o agregado esconda um ativo/timeframe específico.
select
  a.symbol,
  de.timeframe,
  coalesce((ma.validation_metrics->>'usable')::boolean, false) as modelo_utilizavel,
  count(*) as n,
  round(100.0 * avg((o.decision_result = 'win')::int), 2) as taxa_acerto_pct,
  round(avg(pe.pnl)::numeric, 4) as ev_liquido_medio,
  round(avg(de.probability)::numeric, 4) as probabilidade_media
from signal_atlas.decision_events de
join signal_atlas.assets a on a.id = de.asset_id
join signal_atlas.model_artifacts ma on ma.id = de.model_artifact_id
join signal_atlas.outcomes o on o.decision_event_id = de.id
join signal_atlas.paper_trades pt on pt.decision_event_id = de.id
join signal_atlas.paper_trade_events pe
  on pe.paper_trade_id = pt.id
 and pe.event_type = 'resolved'
where de.quality in ('low', 'technical', 'confirmed')
group by 1, 2, 3
having count(*) >= 30
order by modelo_utilizavel desc, ev_liquido_medio desc, n desc;
