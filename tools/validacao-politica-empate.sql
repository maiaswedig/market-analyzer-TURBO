-- Market Analyzer — diagnóstico somente leitura da economia de empates cloud.
-- Execute no SQL Editor do Supabase. Não altera tabela, modelo ou histórico.

-- 1) Decisões v2: compara o EV congelado com o EV canônico de três resultados.
with decisions as (
  select
    d.id,
    d.tie_policy,
    d.probability as conditional_win_probability,
    d.tie_probability,
    d.stake,
    d.payout_ratio,
    d.operation_cost,
    d.expected_ev as stored_ev,
    case d.tie_policy
      when 'win' then d.stake * d.payout_ratio - d.operation_cost
      when 'refund' then -d.operation_cost
      else -(d.stake + d.operation_cost)
    end as tie_pnl
  from signal_atlas.decision_events d
  join signal_atlas.model_artifacts m on m.id = d.model_artifact_id
  where coalesce((m.training_config->'artifact'->>'decisionPolicyVersion')::integer, 1) >= 2
), compared as (
  select *,
    conditional_win_probability * (1 - tie_probability)
      * (stake * payout_ratio - operation_cost)
    + (1 - conditional_win_probability) * (1 - tie_probability)
      * (-(stake + operation_cost))
    + tie_probability * tie_pnl as canonical_ev
  from decisions
)
select
  tie_policy,
  count(*) as n,
  round(avg(tie_probability)::numeric, 6) as tie_probability_media,
  round(avg(stored_ev)::numeric, 6) as ev_gravado_medio,
  round(avg(canonical_ev)::numeric, 6) as ev_canonico_medio,
  count(*) filter (where abs(stored_ev - canonical_ev) > 0.000001) as divergencias,
  round(max(abs(stored_ev - canonical_ev))::numeric, 6) as maior_diferenca
from compared
group by tie_policy
order by tie_policy;

-- 2) Laboratório independente: mesma conferência para champion/challenger.
with shadows as (
  select
    s.id,
    s.evaluation_role,
    (s.config_snapshot->>'tie_policy')::signal_atlas.tie_policy_code as tie_policy,
    case when s.direction = 'buy' then s.probability_up else 1 - s.probability_up end
      as conditional_win_probability,
    s.tie_probability,
    (s.config_snapshot->>'payout_ratio')::numeric as payout_ratio,
    (s.config_snapshot->>'operation_cost')::numeric as operation_cost,
    s.expected_ev as stored_ev
  from signal_atlas.policy_shadow_decisions s
  where s.evaluation_role in ('champion', 'challenger')
    and s.probability_up is not null
    and s.tie_probability is not null
), compared as (
  select *,
    conditional_win_probability * (1 - tie_probability) * (payout_ratio - operation_cost)
    + (1 - conditional_win_probability) * (1 - tie_probability) * (-1 - operation_cost)
    + tie_probability * case tie_policy
        when 'win' then payout_ratio - operation_cost
        when 'refund' then -operation_cost
        else -1 - operation_cost
      end as canonical_ev
  from shadows
)
select
  evaluation_role,
  tie_policy,
  count(*) as n,
  round(avg(stored_ev)::numeric, 6) as ev_gravado_medio,
  round(avg(canonical_ev)::numeric, 6) as ev_canonico_medio,
  count(*) filter (where abs(stored_ev - canonical_ev) > 0.000001) as divergencias
from compared
group by evaluation_role, tie_policy
order by evaluation_role, tie_policy;
