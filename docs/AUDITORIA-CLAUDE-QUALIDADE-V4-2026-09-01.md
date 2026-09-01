# Auditoria externa — qualidade v4

Data do retorno externo: 01/09/2026.

## Resultado

O Claude revisou os oito pontos solicitados contra o código real e aprovou todos. Esta aprovação não prova vantagem financeira; confirma que a separação entre nota técnica e qualidade estatística foi implementada conforme o contrato.

## Oito pontos aprovados

1. A consulta de promoção limita corretamente ativo, timeframe, artefato e instante efetivo anterior à decisão.
2. `paired_samples` é a amostra pareada do shadow prospectivo no mesmo evento, não uma amostra offline reaproveitada.
3. O champion público não expõe modelo aposentado e não recua silenciosamente para um artefato antigo.
4. Nenhum caminho transforma nota A/A+ em `confirmed`.
5. A fotografia canônica congelada prevalece na mesclagem com oportunidades transitórias.
6. Os pesos servem para ordenação técnica; nota e probabilidade permanecem métricas distintas.
7. `register_market_decision` continua relendo a qualidade determinada pela função/trigger SQL.
8. A visão pública continua somente leitura e não expõe tabelas privadas.

## Defesas destacadas

- A classificação busca promoção na fonte de verdade do banco, sem confiar em `champion_usable` ou em campos enviados pela Edge Function.
- `supabase/tests/confirmed_quality_contract.sql` inspeciona a definição viva com `pg_get_functiondef` e protege contra a volta do atalho nota → confirmado.
- A nota A/A+ pode continuar com avaliação baixa enquanto não existir evidência prospectiva suficiente. Esse comportamento é intencional.

## Consequência prática

Não foi necessária nova alteração no motor após esse retorno. A ação correta foi incorporar o resultado na documentação técnica atual, preservar os contratos e continuar coletando dados prospectivos.
