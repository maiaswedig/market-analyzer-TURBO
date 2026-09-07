# Market Analyzer — revisão da taxa de empate causal e diagnóstico contextual

Data de corte: **07/09/2026**

Esta entrega fecha três pontos metodológicos sem alterar pesos do score, direção dos sinais, decisões antigas ou regras de promoção.

## O que mudou

1. `train-challenger` deixou de calcular uma taxa de empate única com todo o período. Agora recebe uma linha do tempo que inclui outcomes direcionais e empates; cada janela walk-forward usa somente observações entre seu próprio início e fim de treino, com Laplace `(ties + 1) / (n + 2)`.
2. O artefato final também grava uma taxa de empate limitada ao seu treino principal. A validação de modelo subiu para a versão 4, separando artefatos novos da metodologia anterior.
3. A migration `033` adiciona `cloud_grade_a_session_diagnostics`, uma visão agregada por ativo, timeframe, direção, sessão/hora UTC, provedor, idade e latência do dado.
4. A nova tabela aparece no painel de diagnóstico do frontend, mas seus dados não entram no ranking, score, direção, qualidade, treino ou promoção.
5. `CLAUDE-COMBINED-REVIEW.md` foi movido para `docs/archive/CLAUDE-COMBINED-REVIEW-2026-08-30.md` com aviso explícito de documento histórico.

## Estado implantado

- Supabase: **33 migrations**; a última é `causal_tie_rate_and_grade_a_sessions`.
- Edge Function: `train-challenger` **v7**, `ACTIVE`, `verify_jwt=true`.
- Testes locais: **32/32** testes do motor, incluindo regressão que anexa empates futuros e exige taxas históricas idênticas.
- Contrato SQL ao vivo: leitura agregada permitida para `anon`/`authenticated`; `signal_atlas.decision_events` continua privado.
- A visão contextual retornou **118 grupos** com pelo menos cinco resultados no corte do snapshot.
- Advisors: nenhum `WARN` ou `ERROR` novo; apenas informações já conhecidas de RLS sem policy, que é deny-by-default intencional, e índices ainda sem uso no instante da criação.

## Arquivos prioritários

- `supabase/functions/_shared/logistic.ts`
- `supabase/functions/train-challenger/index.ts`
- `supabase/functions/_shared/features.ts`
- `supabase/functions/tests/logistic_test.ts`
- `supabase/migrations/202609070033_causal_tie_rate_and_grade_a_sessions.sql`
- `supabase/tests/statistical_diagnostics_contract.sql`
- `supabase/tests/security_contract.sql`
- `js/cloud-api.js`
- `js/signal-ai.js`
- `index.html`

## Perguntas objetivas para auditoria

1. A janela conta empates somente até `train.at(-1).at`, nunca até o fim da validação ou da série?
2. O artefato principal limita a taxa de empate ao treino principal e não ao holdout?
3. A compatibilidade por `options.tieRate` só é usada por callers antigos sem `outcomeTimeline`?
4. O teste realmente prova que observações posteriores ao último sample não alteram as três janelas nem o artefato?
5. A versão 4 impede confundir candidatos desta metodologia com artefatos treinados pela taxa global anterior?
6. A visão SQL inclui empates no denominador, rejeita resolução anterior à expiração e exclui correções `invalidate`?
7. Fonte, idade e latência vêm da fotografia congelada da decisão, sem consultar informação futura?
8. A função é somente leitura, usa `search_path=''`, e a view permanece `security_invoker + security_barrier` sem liberar tabelas privadas?
9. Algum caminho do frontend reutiliza `gradeASessions` para alterar ranking ou sinal?
10. O arquivamento preserva o documento antigo sem deixá-lo parecer vigente?

## Interpretação obrigatória

Os grupos por sessão/fonte ainda podem ter amostras pequenas. Eles servem para localizar hipóteses e desenhar testes prospectivos; não autorizam bloquear horários, inverter EURUSD ou reajustar pesos na mesma amostra. O snapshot continua com EV abaixo do benchmark, portanto o produto permanece adequado a análise e paper trading, não promessa de lucro.
