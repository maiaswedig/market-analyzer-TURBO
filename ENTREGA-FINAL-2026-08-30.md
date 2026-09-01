# Market Analyzer v16 — entrega final

Data: 30/08/2026

## Incluído nesta versão

- frontend completo e motor local;
- scanner progressivo e histórico operacional A/A+;
- backend Supabase com M5, M15, M30 e H1;
- ledger prospectivo, paper trading, baselines e laboratório shadow;
- recuperação auditável de candles ausentes;
- calibração diagnóstica dos pesos com janelas e holdout final;
- calendário econômico prospectivo, versionado e append-only;
- replay causal do calendário no backtest com cobertura obrigatória de 100%;
- testes locais, contratos SQL, documentação operacional e pacote de revisão do
  Claude.

## Validação final

- 101 verificações locais aprovadas;
- contratos SQL de calendário e segurança aprovados no Supabase de teste;
- Edge Function `calendar-replay` ativa e smoke test HTTP 200 no teste;
- backend Supabase de produção não alterado;
- frontend v16 publicado em `https://market-analyzer-ia.netlify.app/` pelo
  deploy `6a94bb1fb54da3350baa8e7e`;
- publicação validada com M30, lista progressiva e painel “Nuvem conectada”,
  sem erros ou avisos no console;
- nenhum `.env`, segredo real, `service_role`, senha, `node_modules` ou `.git`
  faz parte da entrega.

## Começar a revisão

1. Leia `CLAUDE-COMBINED-REVIEW.md` para a rodada anterior.
2. Leia `CLAUDE-FINAL-CALENDAR-REPLAY-REVIEW.md` para o delta final.
3. Confira `docs/IMPLEMENTACAO-REPLAY-CALENDARIO-CAUSAL-2026-08-30.md` para o
   desenho, as garantias e os limites.

## Limite estatístico

O projeto continua sendo uma ferramenta de análise e paper trading. O EV paper
histórico ainda não comprova vantagem líquida. Nenhum calendário, peso ou modelo
foi promovido automaticamente por esta entrega.
