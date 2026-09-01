# Revisão técnica do backfill de candles recebido na v13

Data: 28/08/2026.

## Decisão

A ideia central foi aceita: decisões vencidas não devem permanecer pendentes para sempre quando o provedor deixou uma lacuna. A implementação recebida, porém, não foi copiada literalmente. Ela conflitaria com as migrations `014`/`015` já publicadas e com o ledger imutável atual.

## O que foi preservado

- fila única por ativo, timeframe, tipo e horário exato;
- consulta dirigida ao período histórico no Yahoo (`period1`/`period2`);
- suporte equivalente a lacunas Binance;
- backoff progressivo de 5, 10, 20 minutos até 360;
- encerramento após oito tentativas ou 12 horas;
- exclusão natural de operações sem outcome das taxas e do EV;
- proibição de interpolar ou substituir pelo candle seguinte.

## Correções aplicadas

1. A feature passou a ser migration `016`, preservando o laboratório independente das migrations `014` e `015`.
2. Os RPCs públicos tiveram `EXECUTE` revogado de `PUBLIC`, `anon` e `authenticated`; apenas `service_role` pode chamá-los.
3. O sistema não atualiza `decision_events`. O abandono fica em `resolution_abandonments`, um ledger append-only compatível com a imutabilidade.
4. Uma trigger impede que uma decisão terminalmente abandonada receba outcome mais tarde.
5. A reclamação da fila usa lease de 90 segundos e lote máximo de seis; as chamadas externas usam concorrência três e timeout reduzido no Yahoo.
6. O primeiro intervalo é realmente cinco minutos (`tentativas - 1` no expoente).
7. Quando um candle é recuperado, o resolvedor causal roda novamente no mesmo ciclo.
8. A idade recebida do candle é marcada depois da resposta real do provedor.
9. O resolvedor normal ignora abandonos terminais, evitando varredura infinita.
10. A migration `017` fecha como `cancelled` a lacuna auxiliar que deixa de ter uma decisão pendente depois que sua lacuna irmã recupera o outcome; isso impede contadores e índices de fila artificialmente inflados.

## Evidência da publicação

- migrations `missing_candle_gap_backfill` e `candle_gap_lifecycle` aplicadas;
- `market-cycle` atualizado da versão 10 para a 11 com `verify_jwt=true`;
- contratos de segurança, causalidade e backfill executados no banco publicado;
- 24 lacunas históricas recuperadas com candle exato;
- 26 itens auxiliares sem trabalho restante encerrados como `cancelled`;
- zero decisões vencidas há mais de 10 minutos sem outcome ou estado terminal no corte final;
- zero abandonos necessários e último ciclo observado com status `ok` e zero erros.

## Interpretação estatística

Recuperar dados faltantes melhora completude operacional, não assertividade por si só. Nenhum sinal é reescrito e nenhum resultado ausente vira acerto ou erro artificial. O projeto continua sendo ferramenta de análise e paper trading até demonstrar EV líquido positivo fora da amostra.
