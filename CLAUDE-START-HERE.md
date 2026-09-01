# Market Analyzer — material para revisão técnica

Comece por `docs/VALIDACAO-STAGING-2026-08-29.md`. O pacote contém o código-fonte completo, as 19 migrations, as Edge Functions, os contratos SQL e os verificadores locais. Nenhuma credencial real foi incluída.

## Ordem sugerida de auditoria

1. `supabase/migrations/202608260001_cloud_validation.sql`: o DDL completo de `signal_atlas.outcomes` começa na declaração `create table if not exists signal_atlas.outcomes`.
2. `supabase/migrations/202608280014_independent_shadow_policies.sql`: a definição vigente de `signal_atlas.review_challenger()` começa na declaração homônima e contém LB95 pareado, Brier, drawdown, cobertura e comparação com heurística.
3. `supabase/migrations/202608280015_policy_shadow_reporting.sql`
4. `supabase/migrations/202608280016_missing_candle_gap_backfill.sql`: contém o DDL de `resolution_abandonments`, `reject_abandoned_outcome()`, `reject_resolved_abandonment()` e os dois triggers de exclusão mútua.
5. `supabase/migrations/202608280017_candle_gap_lifecycle.sql`
6. `supabase/migrations/202608280018_abandonment_gap_cleanup.sql`
7. `supabase/migrations/202608280019_canonical_tie_economics.sql`
8. `supabase/tests/gap_backfill_contract.sql`: prova em transação que abandono rejeita outcome e outcome rejeita abandono.
9. `supabase/functions/market-cycle/index.ts`
10. `supabase/functions/train-challenger/index.ts`
11. `supabase/functions/_shared/gap-backfill.ts`
12. `supabase/functions/_shared/providers.ts`: fallback independente Binance → OKX.
13. `js/decision.js`, `js/backtest.js`, `js/probability.js`, `js/score.js` e `js/signal-ai.js`
14. `docs/RESPOSTA-AUDITORIA-CLAUDE-2026-08-30.md`

## Questões objetivas para a revisão

- Algum caminho usa candle, outcome ou estado de modelo posterior ao instante causal da decisão?
- Uma decisão abandonada pode receber outcome depois do abandono?
- O tratamento de empate é idêntico no registro, backtest, paper trading, EV, benchmark e UI?
- Alguma função/RPC privada pode ser executada ou lida por `anon` ou `authenticated`?
- O challenger pode ser promovido sem superar champion e heurística em dados independentes?
- A falha HTTP 451 da Binance possui fallback real, sem fabricar dados?

## Resultado já observado

O pipeline foi reconstruído num Supabase gratuito isolado e os contratos passaram. Um challenger AUD/USD M5 foi treinado com 526 amostras de validação e recusado porque a melhora pareada de Brier (`0,000816`) ficou abaixo da exigida (`0,001388`). Não há alegação de vantagem estatística comprovada.
