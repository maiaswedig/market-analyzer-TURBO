# Market Analyzer — pacote para auditoria da estratégia diagnóstica

Data de corte: **05/09/2026**  
Produção: `https://market-analyzer-ia.vercel.app/`  
Objetivo: descobrir por que a estratégia atual fica abaixo do acaso sem ajustar pesos na mesma amostra.

## O que mudou

1. `028_fix_gap_batch_reconciliation`: corrige uma corrida de estado na reconciliação em lote. Cada lacuna é bloqueada e relida antes da transição; um cancelamento feito por outra iteração não pode ser sobrescrito por um snapshot antigo.
2. `029_prospective_strategy_lab` e `030_fix_and_expand_strategy_controls`: congelam seis braços antes da entrada — direção atual, inversa, somente A/A+, sempre compra, sempre vende e último candle fechado.
3. `031_statistical_diagnostics_and_regime`: adiciona baselines retrospectivos na mesma amostra, intervalo de Wilson por nota, diagnóstico segmentado da nota A e regime causal no snapshot da decisão.
4. `032_coverage_matched_strategy_benchmark`: corrige a comparação de braços seletivos. O acaso opera apenas as mesmas entradas do braço; WAIT é comparado com WAIT.
5. `features.ts`: classifica regime somente com informações existentes no candle analisado e anteriores.
6. `logistic.ts`: um artefato só recebe `usable=true` se também passar três janelas walk-forward expansivas, purgadas e com EV/oportunidade não negativo em todas.
7. `providers.ts` e `market-cycle`: backfill Yahoo limitado ao candle exato, filtro contra reenvio de candles fechados antigos e erros operacionais visíveis por escopo.
8. Frontend: apresenta laboratório prospectivo, baselines ingênuos e Wilson por nota. Essas leituras ficam em um ramo de UI e não entram no sinal, no ranking, no IndexedDB nem no Worker.

## Resultado real observado

Snapshot de produção com **7.156 resultados** da política única:

| Estratégia | Taxa | EV por oportunidade |
|---|---:|---:|
| Market Analyzer | 48,11% | -0,1099 |
| Sempre compra | 49,29% | -0,0882 |
| Sempre vende | 46,03% | -0,1484 |
| Repete último candle | 46,64% | -0,1309 |
| Acaso esperado | 50,00% | -0,0750 |

Conclusão honesta: o motor supera “sempre vende” e “último candle”, mas permanece abaixo de “sempre compra” e do acaso esperado. Ainda não há edge comprovado.

## Curva por nota

| Nota | N | Taxa | Wilson 95% | EV |
|---|---:|---:|---:|---:|
| A+ | 516 | 51,16% | 46,86%–55,45% | -0,0535 |
| A | 1.178 | 42,95% | 40,15%–45,80% | -0,2053 |
| B | 1.887 | 45,84% | 43,60%–48,09% | -0,1520 |
| C | 2.269 | 49,05% | 47,00%–51,11% | -0,0925 |
| D | 1.306 | 53,22% | 50,50%–55,91% | -0,0155 |

O limite superior da nota A fica abaixo do limite inferior da D. Portanto, a inversão A/D não parece ser apenas ruído de amostra pequena. A+ ainda se sobrepõe a D e não permite a mesma conclusão.

O pior agrupamento de A foi `EURUSD=X|M5`: venda teve 50 sinais, 16,00% de acerto e EV -0,7040; compra teve 117 sinais, 24,79% e EV -0,5415. Isso sugere uma falha localizada de seleção/tendência nesse segmento ou uma particularidade do feed/período; não prova que inverter EURUSD seja lucrativo.

## Estado prospectivo

- O laboratório tinha 1.242 oportunidades em apenas 2 dias: nenhum braço está pronto para revisão.
- Gate: pelo menos 500 oportunidades **e 20 dias**, com limite inferior de 95% positivo contra acaso de mesma cobertura.
- Direção atual, direção inversa e o filtro A/A+ continuavam abaixo do controle na amostra inicial.
- Não houve `promote_champion`; `confirmed` continua corretamente vazio.

## O que deliberadamente não foi feito

- Nenhum peso de score foi ajustado.
- Nenhuma direção foi invertida no sinal ao vivo.
- O histórico não foi apagado nem reclassificado.
- O baseline “sempre compra” não foi adotado por ter se saído melhor nesta mesma amostra.
- O laboratório não tem caminho de promoção automática para o motor.

## Perguntas para o Claude

1. A fórmula de Wilson inclui empates no denominador de forma coerente com o ledger?
2. Os baselines retrospectivos usam exatamente os mesmos outcomes válidos, excluindo correções e resoluções precoces?
3. O último candle usa apenas `close_time <= feature_cutoff_at` em ambos os laboratórios?
4. O benchmark coberto da migration 032 compara WAIT com WAIT e evita que um braço totalmente inativo supere o acaso?
5. As três janelas walk-forward em `logistic.ts` são temporalmente independentes de seu próprio treino e têm purga suficiente para E1?
6. O cálculo offline de EV trata corretamente o risco de empate retirado dos rótulos direcionais?
7. O regime anexado pelo wrapper/trigger pode vazar entre chamadas em conexão reutilizada, considerando `set_config(..., true)` e transação do RPC?
8. A concentração da nota A em EURUSD M5 pode ser explicada por resolução, preço de entrada, horário/sessão ou feed, antes de atribuí-la aos pesos técnicos?
9. Alguma das novas views públicas permite inferir dado privado, escrever no ledger ou contornar RLS?
10. Algum diagnóstico chega ao estado do motor no frontend, mesmo indiretamente por cache ou mesclagem de objetos?

## Arquivos prioritários

- `supabase/migrations/202609040028_fix_gap_batch_reconciliation.sql`
- `supabase/migrations/202609040029_prospective_strategy_lab.sql`
- `supabase/migrations/202609040030_fix_and_expand_strategy_controls.sql`
- `supabase/migrations/202609040031_statistical_diagnostics_and_regime.sql`
- `supabase/migrations/202609050032_coverage_matched_strategy_benchmark.sql`
- `supabase/functions/_shared/features.ts`
- `supabase/functions/_shared/logistic.ts`
- `supabase/functions/_shared/providers.ts`
- `supabase/functions/market-cycle/index.ts`
- `supabase/functions/train-challenger/index.ts`
- `js/cloud-api.js`
- `js/signal-ai.js`
- `supabase/tests/statistical_diagnostics_contract.sql`
- `supabase/tests/strategy_lab_contract.sql`
- `supabase/tests/gap_backfill_contract.sql`

## Evidência de teste

- 31/31 testes unitários do motor passaram.
- Contratos SQL de diagnóstico, estratégia, lacunas e segurança passaram no Supabase de produção dentro de transações com rollback.
- Advisors de segurança mostraram somente avisos informativos de RLS sem policy nas tabelas privadas, desenho deny-by-default intencional; nenhum WARN/ERROR novo.
- Índices ainda sem uso apareceram apenas como INFO e foram preservados porque vários protegem fluxos raros ou acabaram de começar a coletar.

O sistema continua sendo ferramenta de pesquisa e paper trading. Resultado histórico não garante desempenho futuro.
