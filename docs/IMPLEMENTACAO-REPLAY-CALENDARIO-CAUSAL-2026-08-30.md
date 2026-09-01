# Replay causal do calendário econômico

Data: 30/08/2026

## Resultado

O arquivo prospectivo do calendário econômico deixou de ser apenas gravado e
passou a alimentar o backtest de forma causal. Para cada decisão histórica, o
motor solicita a fotografia completa que já havia sido observada naquele
instante. Revisões, valores `actual`, cancelamentos ou remoções conhecidos
depois da decisão não aparecem retroativamente.

Essa integração não afirma que notícias melhoram os sinais. Ela cria a base
necessária para medir essa hipótese com honestidade quando houver histórico
prospectivo suficiente.

## Fluxo implementado

1. `market-cycle` consulta o calendário disponível naquele ciclo.
2. `archive_economic_calendar` grava os eventos versionados e liga a coleta a
   uma fotografia completa e imutável.
3. A Edge Function `calendar-replay` recebe somente pontos temporais limitados
   e consulta o RPC privado de replay.
4. `js/cloud-api.js` busca as fotografias em lotes.
5. `buildReplayContext()` associa uma fotografia exata a cada decisão do
   backtest.
6. `calendarGuard()` recebe somente a fotografia conhecida naquele instante.

## Garantias de integridade

- O arquivo é append-only. Correções geram novas observações.
- Cada coleta possui uma fotografia completa, inclusive quando um evento foi
  removido ou cancelado desde a coleta anterior.
- O RPC é somente leitura, limitado a 750 pontos e acessível apenas pelo papel
  de serviço.
- A Edge Function exige JWT e não expõe tabelas privadas ao navegador.
- O backtest exige cobertura exata de 100%. Uma única fotografia ausente
  desativa o filtro de notícias para toda a execução.
- Cobertura parcial nunca é misturada com calendário atual nem completada por
  inferência retrospectiva.
- O período anterior à implantação da migration `023` permanece explicitamente
  indisponível. Ele não pode ser reconstruído com causalidade.

## Treino cloud

`train-challenger` permanece baseado nas features de preço já versionadas. Isso
é intencional: introduzir notícias agora alteraria a distribuição das features
e o contrato de promoção antes de existir amostra prospectiva suficiente.

Quando o arquivo tiver meses de cobertura, o caminho seguro será criar uma
política candidata separada, avaliá-la em shadow contra a política atual e só
permitir promoção após evidência futura pareada. O calendário não ganha poder
automático sobre champion, pesos ou direção nesta entrega.

## Arquivos principais

- `supabase/migrations/202608300023_calendar_replay_bridge.sql`
- `supabase/functions/calendar-replay/index.ts`
- `supabase/functions/_shared/calendar-replay.ts`
- `supabase/functions/tests/calendar_replay_test.ts`
- `js/cloud-api.js`
- `js/backtest.js`
- `tools/verify-backtest-replay.mjs`
- `supabase/tests/calendar_archive_contract.sql`
- `supabase/tests/security_contract.sql`

## Evidências de aceite

- 101 verificações locais passaram.
- O contrato SQL do calendário passou em PostgreSQL real no projeto de teste.
- O contrato SQL de segurança passou em PostgreSQL real no projeto de teste.
- A Edge Function `calendar-replay` foi implantada com `verify_jwt=true` no
  projeto de teste.
- O teste ponta a ponta retornou HTTP 200 e cobertura completa para um ponto
  temporal arquivado.
- O advisor não apresentou `WARN` nem `ERROR`; os avisos informativos de RLS
  sem policy correspondem ao desenho privado deny-by-default.
- Produção e os pesos/modelos ativos não foram alterados.

## Limite honesto

Esta entrega elimina uma pendência arquitetural; ela não transforma o EV
negativo em positivo. A utilidade do filtro de notícias só poderá ser avaliada
depois de acumular amostra prospectiva, com custos, empate, drawdown e benchmark
medidos sob a mesma política.
