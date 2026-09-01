# Diagnóstico de EV, score e modos — 27/08/2026

## Conclusão executiva

O sistema ainda **não comprova vantagem estatística sobre o acaso**. No corte consultado após a migration `013`, a classe `low` tinha EV próximo de `−0,184` por operação, contra benchmark líquido de `−0,095`. Nenhum coeficiente foi alterado para melhorar retrospectivamente esse número.

A semelhança entre conservador, neutro e agressivo é explicada principalmente pela composição da amostra: quase todos os sinais resolvidos são `low`. Como a regra do produto preserva a direção técnica visível mesmo quando os gates falham, os três modos acompanham praticamente os mesmos eventos rebaixados. As diferenças de limiar só poderão ser avaliadas honestamente quando `technical` e `confirmed` tiverem amostras prospectivas suficientes.

## Corte observado

| Modo | Qualidade | N | Taxa | EV líquido | Benchmark | Edge |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Conservador | baixo | 2.133 | 45,19% | −0,1839 | −0,0950 | −0,0889 |
| Neutro | baixo | 2.133 | 45,19% | −0,1839 | −0,0950 | −0,0889 |
| Agressivo | baixo | 2.132 | 45,17% | −0,1844 | −0,0950 | −0,0894 |
| Agressivo | técnico | 1 | 100% | +0,8300 | −0,0950 | +0,9250 |

`confirmed` tinha zero operações nos três modos; `technical` tinha somente uma observação no agressivo. Uma observação não é evidência de edge.

## Revisão dos arquivos indicados

- `js/score.js` produz força de confluência, não probabilidade de acerto. Nota alta não deve ser interpretada como taxa de vitória.
- `js/decision.js` separa score, estimativa estatística e EV depois dos custos. Quando há direção mas os gates falham, a UI mantém COMPRA/VENDA com avaliação baixa.
- `js/probability.js` usa somente snapshots anteriores ao atual e, em E2/E3, exclui rótulos cuja expiração ainda não havia fechado.
- O EV citado acima vem do motor cloud em `supabase/functions/_shared/features.ts`, que ainda possui um schema diferente do motor local. Portanto, alterar `js/score.js` para reagir ao EV cloud seria uma correção no lugar errado.

O corte também mostrou score cloud sem relação monotônica com o resultado: algumas faixas menores foram melhores que faixas maiores. Isso é hipótese para validação futura, não autorização para escolher retrospectivamente um limiar vencedor. Direções de venda também ficaram piores que compra na amostra consultada, mas remover vendas agora seria seleção sobre o próprio conjunto medido.

## Correções aplicadas

1. Curvas por modo e qualidade foram adicionadas sem apagar/reclassificar o ledger.
2. A interface distingue “Sem amostra” de 0% e mostra EV, benchmark, edge e N por qualidade.
3. O botão do ranking abre a mesma fotografia que recebeu direção, força e nota; uma nova análise é uma ação separada e identificada.
4. Testes permanentes cobrem features locais, análogos E1/E2/E3, relógios de decisão/shadow, candles exatos de outcome e resolução após a expiração.
5. O contrato RLS testa todas as tabelas privadas, automaticamente, sob `anon` e `authenticated`.

## Validação da hipótese de direção — corte de 27/08/2026

A consulta recebida para separar “sem modelo treinado” pela frase `champion causal ainda não disponível` não mede essa hipótese: todos os 8.369 eventos `low` resolvidos caíram no grupo “com modelo”. Isso acontece porque `decision_events.model_artifact_id` é obrigatório; um slot sem champion não vira esse tipo de evento.

O corte corrigido usa `model_artifacts.validation_metrics.usable` e o PnL efetivamente registrado em `paper_trade_events`:

| Estado do artefato usado | N | Acerto | EV líquido |
| --- | ---: | ---: | ---: |
| Existente, mas não validado | 6.738 | 43,10% | −0,2227 |
| Validado/utilizável | 1.662 | 46,75% | −0,1551 |

O modelo validado melhora o corte em relação ao artefato não validado, mas ainda não supera o benchmark líquido aproximado de −0,095. Entre modelos não validados, concordar com a direção heurística foi pior (40,57%; EV −0,2695) que discordar (44,85%; EV −0,1904). Entre modelos validados, concordância e discordância ficaram praticamente iguais (46,94% contra 46,65%). Portanto, o snapshot não autoriza inverter a direção nem reajustar a fórmula na mesma amostra; ele indica que a direção heurística não demonstrou edge e deve competir como nova política em shadow prospectivo.

O SQL reproduzível está em `tools/validacao-hipotese-direcao.sql`. A interface continua mostrando COMPRA/VENDA de baixa qualidade como leitura técnica, conforme a regra do produto, sem promovê-la a sinal confirmado nem contaminar as métricas elegíveis.

## Próximos experimentos seguros

1. Continuar acumulando amostra prospectiva sem mudar os critérios atuais.
2. Quando houver volume suficiente, comparar os modos dentro de cada qualidade e por ativo/timeframe.
3. Criar uma nova versão de política para qualquer hipótese de score/direção e testá-la como challenger em shadow, sem reescrever eventos antigos.
4. Planejar um schema de features compartilhado entre local e cloud; a migração deve manter versões antigas legíveis.
5. Só promover uma mudança se superar o champion fora da amostra e após custos, com intervalo de confiança e drawdown aceitáveis.

## Correção estrutural do comparador shadow

A auditoria posterior encontrou que `shadow_predictions.direction` recebia a mesma direção heurística do evento champion. Assim, os dois braços tinham o mesmo PnL e o ΔEV era estruturalmente zero; as revisões antigas continuam preservadas, mas não comprovam uma disputa direcional. A migration `202608280014_independent_shadow_policies.sql` cria um ledger v2 separado: heurística, champion e challenger escolhem `BUY`, `SELL` ou `WAIT` de forma independente, usa apenas uma oportunidade do modo neutro por vela e exige vantagem prospectiva também contra a heurística antes de qualquer promoção.

## Limitações mantidas

- Forex depende do Yahoo Finance e de transporte público sem SLA; não há fallback equivalente a outra bolsa.
- Volume Forex não é centralizado.
- Sem arquivo histórico confiável de notícias, o backtest declara o filtro como indisponível em vez de aplicar notícias atuais ao passado.
- Este diagnóstico é um snapshot datado; as contagens mudam com novos candles.
