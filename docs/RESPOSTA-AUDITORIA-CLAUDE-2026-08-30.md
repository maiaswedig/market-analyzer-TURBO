# Resposta técnica à auditoria do Claude — 30/08/2026

## Resultado

A auditoria encontrou corretamente uma falha de disponibilidade do backend cripto. Ela foi corrigida. Os dois contratos SQL classificados como “não verificáveis” já estavam no pacote, mas não apareciam na ordem de leitura do guia; o guia foi corrigido para apontar as declarações exatas.

Nenhum peso de score foi alterado. O calibrador foi executado em divisão cronológica com embargo e holdout intocado, e recusou o candidato. Preservar os defaults foi a única decisão compatível com o resultado.

## 1. Fallback cripto independente

Arquivos alterados:

- `supabase/functions/_shared/providers.ts`
- `supabase/functions/_shared/types.ts`
- `supabase/functions/tests/provider_clock_test.ts`
- `supabase/functions/README.md`

Comportamento atual:

1. Binance permanece como provedor preferencial.
2. HTTP 451, timeout, payload inválido ou ausência de candles válidos aciona OKX.
3. Coleta recente, bootstrap profundo e reparo de lacuna exata usam a mesma política.
4. `Candle.source` registra `binance` ou `okx` conforme a origem real.
5. Nenhum caminho interpola ou sintetiza OHLCV.

O teste automatizado simula HTTP 451 em todos os hosts Binance, devolve um payload OKX conhecido e verifica fonte, timestamp e OHLC reais. Bateria Edge: 19/19.

As versões 4 de `market-cycle` e `bootstrap-data` foram implantadas no Supabase gratuito de teste com `verify_jwt=true`. A produção não foi alterada.

## 2. Bug confirmado durante a calibração

Ao rodar `tools/calibrate-score.mjs` de verdade, o backtest processava todas as velas e falhava ao montar `meta`: usava o identificador inexistente `newsHistoricalUnavailable` em vez de mapear a propriedade para `historicalNewsUnavailable`.

Correção:

- `js/backtest.js`: `newsHistoricalUnavailable: historicalNewsUnavailable`.
- `tools/verify-score-calibration.mjs`: regressão estática para impedir o retorno do identificador solto.

O contrato de calibração passou de 8 para 12 verificações.

## 3. Calibração executada, sem adoção

Escopo diagnóstico: BTC/USDT M5, fonte OKX, 5.099 candles.

- Linhas avaliadas: 2.910
- Calibração antiga: 1.888
- Embargo: 3 barras em cada lado
- Holdout recente intocado: 1.016
- Candidato escolhido apenas na calibração: `B0=0,02`, `B1=0,30`, `minScore=58`
- Sinais no holdout: 122
- EV do candidato no holdout: `-0,602459`
- Benchmark no holdout: `-0,375000`
- Diferença contra benchmark: `-0,227459`
- Limite inferior de 95% do EV: `-1,425553`
- Resultado: `accepted=false`

O default também ficou negativo no mesmo holdout (`EV=-0,583333`). O candidato selecionado no trecho antigo piorou no trecho novo; adotá-lo seria overfitting.

EUR/USD M5 também foi avaliado, mas a fonte Kraken entregou somente 720 candles e o holdout teve oito sinais default. Nenhum candidato atingiu a amostra mínima; `accepted=false`.

## 4. Limite real do calibrador

`tools/calibrate-score.mjs` calibra somente:

- `scoreB0`;
- `scoreB1`;
- `minScore`.

Ele não calibra os pesos de categoria, os coeficientes internos (`0,42`, `0,16` etc.) nem limiares RSI/ATR/SR. O relatório agora declara isso explicitamente e bloqueia adoção quando o filtro histórico de notícias não pode ser reproduzido.

Não é metodologicamente correto ampliar agora a busca para dezenas de pesos e reutilizar o mesmo holdout que acabou de rejeitar o candidato. Isso transformaria a validação em calibração e produziria viés de seleção. A próxima tentativa precisa usar um novo período futuro ou nested walk-forward com uma janela final ainda não aberta.

## 5. Contratos SQL que o revisor não encontrou

Eles não estavam ausentes:

- DDL de `outcomes`: `supabase/migrations/202608260001_cloud_validation.sql`.
- DDL de `resolution_abandonments` e exclusão mútua: `supabase/migrations/202608280016_missing_candle_gap_backfill.sql`.
- Trigger `reject_abandoned_outcome()`: impede outcome após abandono.
- Trigger `reject_resolved_abandonment()`: impede abandono após outcome.
- Teste bidirecional: `supabase/tests/gap_backfill_contract.sql`.
- Definição vigente de `signal_atlas.review_challenger()`: `supabase/migrations/202608280014_independent_shadow_policies.sql`.

`review_challenger()` exige 500 oportunidades únicas, 20 dias, 100 trades do challenger, LB95 positivo contra champion e heurística, Brier não pior e drawdown dentro do limite. A promoção ainda revalida que o champion não mudou.

## Conclusão

O problema HTTP 451 foi corrigido sem fabricar dados. O bug que impedia o calibrador de terminar foi corrigido. A calibração fora da amostra foi executada e rejeitou os novos parâmetros, então os defaults permaneceram intactos. O resultado honesto continua sendo: o pipeline está mais robusto, mas ainda não demonstrou EV positivo.
