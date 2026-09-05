# Market Analyzer — início da revisão técnica

Data de corte do pacote: 05/09/2026.

Aplicação: `https://market-analyzer-ia.vercel.app/`

Repositório: `https://github.com/maiaswedig/market-analyzer-TURBO`

Comece por `docs/CLAUDE-REVIEW-ESTRATEGIA-DIAGNOSTICA-2026-09-05.md`. Depois leia `PERPLEXITY-REVIEW.md`, gerado a partir de `docs/technical-review-runtime-snapshot.json` e validado pelo teste `test:technical-review`.

O pacote contém o frontend, o motor local, as Edge Functions, 32 migrations, contratos SQL e verificadores. Não contém `.env`, `node_modules`, `.git` da origem nem segredos administrativos.

## Estado que deve ser preservado

- Vercel é o domínio canônico; `netlify.toml` é apenas alternativa de recuperação.
- Novas decisões cloud usam somente a política `cloud-engine-single`, custo adicional zero e código neutro por compatibilidade de schema.
- Os três modos antigos permanecem congelados como legado e não entram na curva vigente.
- Nota A/A+ é ordenação técnica, não probabilidade nem confirmação estatística.
- `confirmed` exige promoção prospectiva real e os gates da migration `026`; a migration `027` não pode enfraquecer essa regra.
- Direções de baixa qualidade continuam visíveis, com os motivos; não são transformadas artificialmente em confirmação.
- Backtest, histórico local e ledger cloud permanecem separados.
- As migrations `029`–`032` são diagnóstico e shadow: não promovem estratégia, não reajustam pesos e não reclassificam histórico.
- Um braço seletivo é comparado a um acaso com a mesma cobertura; WAIT é comparado com WAIT.

## Ordem sugerida da auditoria

1. `supabase/migrations/202608260001_cloud_validation.sql`: DDL base do schema, outcomes e modelos.
2. `supabase/migrations/202608280014_independent_shadow_policies.sql`: ledger shadow independente e promoção contra champion e heurística.
3. `supabase/migrations/202608280016_missing_candle_gap_backfill.sql` até `202608280018_abandonment_gap_cleanup.sql`: fila de lacunas, abandono terminal e exclusão mútua com outcomes.
4. `supabase/migrations/202608280019_canonical_tie_economics.sql`: economia canônica de vitória, derrota e empate.
5. `supabase/migrations/202608300020_add_m30_timeframe_enum.sql` até `202608300023_calendar_replay_bridge.sql`: M30 e calendário causal versionado.
6. `supabase/migrations/202608310024_public_cloud_grade_history.sql` e `202608310025_public_cloud_decision_explanations.sql`: projeções públicas sanitizadas.
7. `supabase/migrations/202608310026_decouple_confirmed_quality.sql`: confirmação separada de nota e ligada à promoção real.
8. `supabase/migrations/202609010027_single_policy_zero_cost.sql`: política única, custo adicional zero e preservação do legado.
9. `supabase/migrations/202609040028_fix_gap_batch_reconciliation.sql`: concorrência e relógios da fila de lacunas.
10. `supabase/migrations/202609040029_prospective_strategy_lab.sql` até `202609050032_coverage_matched_strategy_benchmark.sql`: controles prospectivos, baselines, Wilson, regime e benchmark justo.
11. `supabase/functions/market-cycle/index.ts`, `train-challenger/index.ts` e `_shared/`: coleta, decisão, regime e treino walk-forward.
12. `js/cloud-api.js` e `js/signal-ai.js`: apresentação dos diagnósticos, sem realimentação do motor.
13. `supabase/tests/` e `tools/verify-*.mjs`: contratos permanentes contra regressão.

## Perguntas objetivas para o revisor

- Algum caminho usa candle, outcome, calendário ou estado de modelo posterior ao instante causal da decisão?
- Uma decisão abandonada consegue receber outcome ou voltar ao estado pendente?
- Empates usam a mesma política no registro, resolução, backtest, EV, benchmark e interface?
- Alguma tabela/RPC privada está acessível por `anon` ou `authenticated`?
- Um challenger consegue ser promovido sem superar champion e heurística em amostra prospectiva pareada?
- `confirmed` pode surgir de A/A+, de `usable=true` ou de campo enviado pela Edge Function sem evento real de promoção?
- A migration `027` mistura o legado dos três modos com a curva prospectiva da política única?
- O frontend troca a fotografia congelada do ranking ao abrir uma análise?
- O repositório ou os artefatos públicos expõem segredo real?
- O regime é calculado somente com candles disponíveis no instante da decisão e congelado no ledger?
- As três janelas walk-forward são cronológicas, purgadas e ficam todas fora do treino de sua própria janela?
- Algum diagnóstico retrospectivo altera pesos, sinais, modelos ou promoção?
- O braço A/A+ usa um benchmark aleatório restrito às mesmas entradas, impedindo vantagem artificial por WAIT?
- A inversão A versus D permanece quando segmentada por ativo, timeframe, direção, regime e período?

## Interpretação estatística obrigatória

Os números presentes no snapshot são fotografias datadas e não devem ser apresentados como consulta ao vivo. Zero promoções ou EV abaixo do benchmark não são corrigidos ajustando pesos na mesma amostra. Qualquer mudança de modelo deve competir em shadow prospectivo e passar pelos gates existentes. O sistema continua adequado para análise e paper trading; não há promessa de lucro nem autorização para execução automática em corretora.
