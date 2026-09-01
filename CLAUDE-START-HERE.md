# Market Analyzer — início da revisão técnica

Data de corte do pacote: 01/09/2026.

Aplicação: `https://market-analyzer-ia.vercel.app/`

Repositório: `https://github.com/maiaswedig/market-analyzer-TURBO`

Comece por `PERPLEXITY-REVIEW.md`, que é gerado a partir de `docs/technical-review-runtime-snapshot.json` e validado pelo teste `test:technical-review`. Depois leia `docs/ENTREGA-POLITICA-UNICA-E-FRONTEND-2026-09-01.md` e `docs/ENTREGA-GITHUB-VERCEL-2026-09-01.md`.

O pacote contém o frontend, o motor local, as Edge Functions, 27 migrations, contratos SQL e verificadores. Não contém `.env`, `node_modules`, `.git` da origem nem segredos administrativos.

## Estado que deve ser preservado

- Vercel é o domínio canônico; `netlify.toml` é apenas alternativa de recuperação.
- Novas decisões cloud usam somente a política `cloud-engine-single`, custo adicional zero e código neutro por compatibilidade de schema.
- Os três modos antigos permanecem congelados como legado e não entram na curva vigente.
- Nota A/A+ é ordenação técnica, não probabilidade nem confirmação estatística.
- `confirmed` exige promoção prospectiva real e os gates da migration `026`; a migration `027` não pode enfraquecer essa regra.
- Direções de baixa qualidade continuam visíveis, com os motivos; não são transformadas artificialmente em confirmação.
- Backtest, histórico local e ledger cloud permanecem separados.

## Ordem sugerida da auditoria

1. `supabase/migrations/202608260001_cloud_validation.sql`: DDL base do schema, outcomes e modelos.
2. `supabase/migrations/202608280014_independent_shadow_policies.sql`: ledger shadow independente e promoção contra champion e heurística.
3. `supabase/migrations/202608280016_missing_candle_gap_backfill.sql` até `202608280018_abandonment_gap_cleanup.sql`: fila de lacunas, abandono terminal e exclusão mútua com outcomes.
4. `supabase/migrations/202608280019_canonical_tie_economics.sql`: economia canônica de vitória, derrota e empate.
5. `supabase/migrations/202608300020_add_m30_timeframe_enum.sql` até `202608300023_calendar_replay_bridge.sql`: M30 e calendário causal versionado.
6. `supabase/migrations/202608310024_public_cloud_grade_history.sql` e `202608310025_public_cloud_decision_explanations.sql`: projeções públicas sanitizadas.
7. `supabase/migrations/202608310026_decouple_confirmed_quality.sql`: confirmação separada de nota e ligada à promoção real.
8. `supabase/migrations/202609010027_single_policy_zero_cost.sql`: política única, custo adicional zero e preservação do legado.
9. `supabase/functions/market-cycle/index.ts`, `train-challenger/index.ts` e `_shared/`: coleta, decisão, treino e resolução.
10. `js/score.js`, `decision.js`, `probability.js`, `backtest.js`, `history-settlement.js` e `signal-ai.js`: motor local e apresentação.
11. `supabase/tests/` e `tools/verify-*.mjs`: contratos permanentes contra regressão.

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

## Interpretação estatística obrigatória

Os números presentes no snapshot são fotografias datadas e não devem ser apresentados como consulta ao vivo. Zero promoções ou EV abaixo do benchmark não são corrigidos ajustando pesos na mesma amostra. Qualquer mudança de modelo deve competir em shadow prospectivo e passar pelos gates existentes. O sistema continua adequado para análise e paper trading; não há promessa de lucro nem autorização para execução automática em corretora.
