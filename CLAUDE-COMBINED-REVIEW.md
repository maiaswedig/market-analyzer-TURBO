# Market Analyzer — pacote combinado para revisão do Claude

Data: 30/08/2026

Este diretório reúne o projeto completo e as duas entregas que devem ser
avaliadas juntas. Não contém `.env`, segredo de cron, `service_role`, senha de
banco, JWT privado, `node_modules`, `.git` ou configuração real do navegador.

## Entrega anterior incluída

1. M30 no pipeline Supabase, sem editar migrations antigas.
2. Calendário econômico causal e versionado, arquivado antes de influenciar a
   decisão.
3. Leitura `as-of` baseada na observação conhecida naquele instante.
4. Categorias determinísticas de notícia, sem sentimento nem previsão de
   direção.
5. Testes de relógio M30, provedor Yahoo M30, causalidade do calendário e
   contratos SQL.
6. Edge Functions implantadas e verificadas no projeto de teste.

Arquivos centrais:

- `supabase/migrations/202608300020_add_m30_timeframe_enum.sql`
- `supabase/migrations/202608300021_m30_runtime_and_calendar_archive.sql`
- `supabase/migrations/202608300022_calendar_asof_uses_versioned_observation.sql`
- `supabase/functions/_shared/types.ts`
- `supabase/functions/_shared/providers.ts`
- `supabase/functions/_shared/market-guards.ts`
- `supabase/functions/market-cycle/index.ts`
- `supabase/functions/bootstrap-data/index.ts`
- `supabase/tests/calendar_archive_contract.sql`
- `docs/IMPLEMENTACAO-M30-E-CALENDARIO-CAUSAL-2026-08-30.md`

## Entrega nova incluída

1. `runBacktest()` refatorado em contexto caro reutilizável e replay barato.
2. Contextos causais sem ponteiro mutável entre candidatos.
3. Teste determinístico de equivalência e repetibilidade do replay.
4. Coordinate ascent para os sete pesos, soma fixa em 100 e ordem explícita.
5. Até 35 candidatos realmente contabilizados.
6. Seleção em 4–6 janelas independentes, mínimo 200 sinais por janela,
   embargo e `z=2,58`.
7. Holdout final recente, mínimo 300 sinais, candidato único e `z=1,96`.
8. Comparação final contra benchmark, `DEFAULT_WEIGHTS` e pesos de produção.
9. Rejeição detalhada e proibição de reajustar no mesmo holdout.
10. CLI antiga preservada; modo novo habilitado apenas por
    `--mode=weights`.
11. Analogias históricas E1/E2/E3 pré-calculadas uma vez somente no modo de
    calibração e cobertas por teste de equivalência.

Arquivos centrais:

- `js/backtest.js`
- `js/score-calibration.js`
- `tools/calibrate-score.mjs`
- `tools/verify-score-calibration.mjs`
- `tools/verify-backtest-replay.mjs`
- `docs/IMPLEMENTACAO-CALIBRACAO-PESOS-2026-08-30.md`
- `docs/ATIVACAO-BACKEND-TESTE-2026-08-30.md`

## Evidências desta rodada

- 93 verificações locais passaram nesta etapa; depois da ponte final do
  calendário, a bateria completa passou a totalizar 101.
- Contratos SQL de causalidade, economia, lacunas, segurança e calendário já
  haviam passado no mesmo projeto de teste depois das migrations M30/notícias.
- M5, M15, M30 e H1 têm candles reais para os 8 ativos no banco de teste.
- Cron do mercado executa a cada minuto e os registros mais recentes estão
  `ok`, sem erros.
- O calendário causal inseriu sua primeira fotografia versionada.
- O treinador processou 1.500 candles e rejeitou corretamente um candidato que
  não superou o baseline de Brier.
- Produção não foi alterada.

## Perguntas objetivas para a revisão

1. `buildReplayContext()` e `replayWithConfig()` preservam a causalidade e a
   equivalência do motor anterior?
2. Existe algum estado mutável ainda compartilhado entre candidatos?
3. As janelas da Camada 1 estão verdadeiramente isoladas e o holdout final fica
   fora da busca?
4. A renormalização mantém a categoria candidata fixa e a soma em 100 sem
   distorção material?
5. O gate conservador “qualquer janela/candidato abaixo de 200 pula a
   categoria” corresponde à especificação ou deveria ser ainda mais explícito
   no relatório?
6. A métrica de benchmark e a política de empate coincidem com `decision.js` e
   `backtest.js` em todos os caminhos?
7. Há algum caminho que aplique automaticamente os pesos diagnósticos? A
   resposta esperada é não.
8. As migrations 020–022 mantêm observações append-only e impedem que `actual`
   ou revisões posteriores apareçam num `as-of` antigo?
9. O uso de Vault + JWT `anon` + segredo independente mantém as funções
   internas fechadas para usuários comuns?
10. Há regressão, look-ahead, sobreposição de janelas ou vazamento de segredo
    confirmável?

## O que deve ser preservado

- direção técnica continua visível mesmo com qualidade baixa;
- apenas sinais A/A+ entram no histórico operacional elegível, enquanto os
  demais continuam disponíveis para diagnóstico interno;
- nenhum modelo ou peso é promovido por backtest retrospectivo isolado;
- empate permanece no denominador e no EV segundo uma política única;
- candles ausentes nunca são interpolados nem substituídos pelo seguinte;
- o sistema é ferramenta de análise e paper trading, sem promessa de lucro.

## Rodada final depois da auditoria 10/10

A auditoria anterior aprovou as dez perguntas acima e apontou somente que o
arquivo do calendário ainda não era consumido. Essa pendência foi fechada pela
migration `023`, pela Edge Function `calendar-replay` e pela integração causal
em `js/backtest.js`.

O backtest exige cobertura de calendário exatamente igual a 100%. Se qualquer
fotografia estiver ausente, o filtro histórico inteiro fica indisponível. O
treino cloud permanece baseado em preços até existir amostra prospectiva para
um challenger separado. Consulte `CLAUDE-FINAL-CALENDAR-REPLAY-REVIEW.md` para o
delta, as evidências e as novas perguntas objetivas.
