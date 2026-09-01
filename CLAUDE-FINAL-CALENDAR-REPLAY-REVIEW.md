# Market Analyzer — revisão final do replay causal do calendário

Data: 30/08/2026

## Contexto

A auditoria anterior aprovou as dez perguntas do
`CLAUDE-COMBINED-REVIEW.md` e deixou uma observação: o calendário era arquivado,
mas ainda não era lido pelo backtest/treino. Esta rodada fecha a leitura causal
no backtest sem dar poder automático ao calendário e sem alterar produção.

## Delta desta rodada

1. A migration `023` cria fotografias completas e imutáveis por coleta.
2. O novo RPC privado devolve o calendário conhecido em pontos temporais
   específicos, com lote limitado.
3. A nova Edge Function `calendar-replay` é JWT-protected e somente leitura.
4. O frontend busca o replay em lotes e o injeta no contexto caro reutilizável
   do backtest.
5. O filtro histórico só fica ativo com cobertura de 100%; qualquer ausência
   desativa todo o filtro naquela execução.
6. Remoção/cancelamento posterior de um evento não deixa um evento antigo
   “fantasma” em fotografias novas.
7. `train-challenger` continua price-only. Integrar notícia ao treino antes de
   acumular dados e criar um challenger separado violaria a ordem de validação.

## Arquivos para revisar

- `supabase/migrations/202608300023_calendar_replay_bridge.sql`
- `supabase/functions/calendar-replay/index.ts`
- `supabase/functions/_shared/calendar-replay.ts`
- `supabase/functions/tests/calendar_replay_test.ts`
- `supabase/config.toml`
- `js/cloud-api.js`
- `js/backtest.js`
- `tools/verify-backtest-replay.mjs`
- `tools/verify-security-release.mjs`
- `supabase/tests/calendar_archive_contract.sql`
- `supabase/tests/security_contract.sql`
- `docs/IMPLEMENTACAO-REPLAY-CALENDARIO-CAUSAL-2026-08-30.md`

## Evidência entregue

- 101 verificações locais aprovadas.
- Contratos SQL de calendário e segurança aprovados em PostgreSQL real.
- Edge Function ativa no projeto Supabase de teste com `verify_jwt=true`.
- Smoke test autenticado ponta a ponta com HTTP 200 e cobertura completa.
- Backend Supabase de produção não alterado durante esta rodada de validação.
- Nenhuma credencial real incluída no pacote.

## Perguntas objetivas para o Claude

1. A fotografia completa por coleta resolve corretamente a retirada ou o
   cancelamento posterior de um evento?
2. A seleção `as-of` impede que revisão ou `actual` futuro apareça na decisão
   antiga?
3. O gate de cobertura exatamente 100% impede qualquer uso seletivo de períodos
   que seriam mais favoráveis ao resultado?
4. O limite de 750 no RPC, o lote de 500 no cliente e a validação de pontos
   únicos são suficientes contra abuso e consultas acidentais muito amplas?
5. Existe alguma rota direta sob `anon` ou `authenticated` para as tabelas/RPCs
   privados?
6. O descarte total da cobertura parcial está aplicado antes de `calendarGuard`
   em todos os caminhos do replay?
7. A decisão de manter `train-challenger` price-only preserva corretamente o
   contrato estatístico atual?
8. Há look-ahead, mutação de fotografia, vazamento de segredo ou regressão
   confirmável nesta rodada?

## Retorno da revisão externa

O Claude encerrou a rodada como limpa nas oito perguntas. O parecer destacou
especialmente o gate tudo-ou-nada do calendário: além da implementação, existe
teste automatizado provando que uma única fotografia ausente desativa o filtro
histórico completo.

O próximo trabalho relevante não é afrouxar gates nem ajustar o mesmo holdout.
É acumular tempo de coleta prospectiva suficiente para provar ou descartar edge
estatístico real fora da amostra.

Depois desse aceite, o frontend v16 foi publicado em
`https://market-analyzer-ia.netlify.app/` pelo deploy
`6a94bb1fb54da3350baa8e7e`. A página oficial foi validada com painel cloud
conectado e console sem erros.

## O que deve ser preservado

- Não reconstruir calendário anterior à migration `023`.
- Não usar o calendário atual como substituto histórico.
- Não promover modelo ou peso por resultado retrospectivo.
- Não esconder o EV negativo atual.
- Não integrar notícia como direção ou sentimento antes de validação shadow.
