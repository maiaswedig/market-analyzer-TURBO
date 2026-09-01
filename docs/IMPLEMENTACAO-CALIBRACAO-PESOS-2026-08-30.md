# Implementação — calibração ampliada dos pesos do score

Data: 30/08/2026

## Escopo entregue

Foi implementada somente a Fase A: calibração dos sete pesos de categoria de
`DEFAULT_WEIGHTS`. Os coeficientes internos dos indicadores, limiares de RSI,
ATR e suporte/resistência, o modelo ML e a heurística de direção não são
alterados.

O resultado é diagnóstico. Nenhum peso é salvo, promovido ou aplicado ao
frontend, ao scanner ou ao backend automaticamente.

## Refatoração do backtest

`js/backtest.js` agora expõe:

- `buildReplayContext()`: busca candles e calcula indicadores, snapshots,
  contextos multi-timeframe e zonas uma vez;
- `replayWithConfig()`: reaproveita o contexto e recalcula somente score,
  decisão, filtros, fingerprint e ranking walk-forward;
- `runBacktest()`: continua com a API anterior e apenas compõe as duas fases.

No modo de pesos, as analogias históricas de E1/E2/E3 também são
pré-calculadas uma vez. Sem isso, a distância histórica seria refeita em cada
candidato e em cada janela. O backtest comum não ativa esse pré-cálculo triplo,
preservando seu custo normal.

Os contextos multi-timeframe não usam ponteiros compartilhados. A busca do
último contexto fechado é determinística e o contexto superior é congelado,
impedindo que um candidato altere o próximo replay.

O contrato `tools/verify-backtest-replay.mjs` cobre:

1. contexto congelado;
2. dois replays idênticos sobre o mesmo contexto;
3. equivalência de `runBacktest()` com a nova composição;
4. isolamento temporal por `startT` e `endT`;
5. equivalência entre analogia histórica normal e pré-calculada.

## Busca dos pesos

Ordem explícita e auditável:

1. tendência;
2. momentum;
3. multi-TF;
4. price action;
5. suporte/resistência;
6. volatilidade;
7. volume.

Cada categoria testa os fatores `0,70`, `0,85`, `1,00`, `1,15` e `1,30`.
Os demais pesos são redistribuídos proporcionalmente e a soma é corrigida para
exatamente 100. A contagem máxima é 35 avaliações e o relatório grava a
contagem realmente executada.

## Duas camadas estatísticas

### Seleção

- 4 janelas cronológicas independentes por padrão, configuráveis entre 4 e 6;
- janelas não sobrepostas e separadas por embargo `purgeBars`;
- mínimo irredutível de 200 sinais em cada janela;
- `z = 2,58`, aproximadamente 99%, para reduzir falso positivo por múltiplas
  comparações;
- o candidato precisa, em todas as janelas, ter limite inferior do EV acima do
  benchmark e EV médio acima dos pesos correntes da mesma janela;
- se qualquer candidato deixar alguma janela abaixo do mínimo, a categoria é
  pulada inteira e o mínimo não é reduzido.

Cada janela é replayada isoladamente, com ranking walk-forward iniciado vazio.
Os snapshots anteriores continuam disponíveis apenas para analogia histórica
causal. `endT` impede que a busca processe o holdout recente.

### Confirmação final

- reserva o trecho cronológico mais recente desde o início;
- mínimo irredutível de 300 sinais;
- recebe um único vetor candidato, uma única vez;
- usa `z = 1,96`, aproximadamente 95%;
- exige limite inferior acima do benchmark, EV acima de `DEFAULT_WEIGHTS` e EV
  acima dos pesos atuais de produção;
- se falhar, a rodada inteira é rejeitada e o relatório lista todos os motivos;
- reajuste com o mesmo holdout é explicitamente proibido.

## Como executar

Modo antigo, preservado como padrão:

```text
node tools/calibrate-score.mjs BTCUSDT M5 5000
```

Calibração dos pesos:

```text
node tools/calibrate-score.mjs BTCUSDT M5 10000 --mode=weights --windows=4
```

Ativos com histórico maior podem usar `--windows=5` ou `--windows=6`. Aumentar
o número de janelas não autoriza reduzir os mínimos de 200/300 sinais.

## Interpretação correta

Uma rejeição por amostra insuficiente é um resultado válido, não um erro do
programa. Uma aceitação também não prova lucro futuro: apenas informa que o
candidato passou os critérios escolhidos naquela rodada e ainda depende de
revisão humana e de novos dados prospectivos.

Esta implementação não corrige por ajuste os resultados históricos negativos
e não reutiliza o holdout de auditorias anteriores para procurar uma resposta
mais favorável.
