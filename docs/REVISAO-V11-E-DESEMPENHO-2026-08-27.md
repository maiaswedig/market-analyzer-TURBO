# Revisão v11, hipótese de direção e desempenho — 27/08/2026

## Decisão sobre a alteração recebida

A versão revisada propôs substituir COMPRA/VENDA por “SEM CONFIRMAÇÃO” em toda leitura cloud de qualidade baixa. Essa alteração **não foi integrada** porque conflita com a regra definida para o produto: uma direção técnica continua visível quando os gates falham, mas recebe qualidade baixa, perde prioridade e não é promovida a sinal confirmado.

O banco, o histórico e o aprendizado continuam sem reclassificação retrospectiva. A interface não apresenta baixa qualidade como garantia; ela mostra direção, qualidade e motivo de rebaixamento separadamente.

## Resultado das consultas recebidas

A primeira consulta agrupou os 8.369 eventos `low` resolvidos como “com modelo treinado”. Logo, procurar a frase `champion causal ainda não disponível` não separa a origem da direção nos eventos gravados. O artefato é obrigatório em `decision_events`; um slot realmente sem champion não entra nessa tabela como decisão.

A segunda consulta encontrou:

- modelo com probabilidade condicional ≥ 0,5 para a direção escolhida: N=3.324, acerto 41,88%;
- modelo com probabilidade condicional < 0,5 para a direção escolhida: N=5.052, acerto 45,25%.

O diagnóstico corrigido separou artefatos por `validation_metrics.usable` e usou o PnL congelado em `paper_trade_events`:

- modelo existente, mas não validado: N=6.738, acerto 43,10%, EV −0,2227;
- modelo validado/utilizável: N=1.662, acerto 46,75%, EV −0,1551.

Há melhora relativa no grupo validado, mas nenhum dos dois cortes supera o benchmark líquido aproximado de −0,095. Isso não autoriza inverter direções ou recalibrar na mesma amostra. Uma política nova deve competir prospectivamente em shadow.

O arquivo reproduzível é `tools/validacao-hipotese-direcao.sql`.

## Por que o scanner demorava

O scanner repetia uma análise profunda de até 10.000 candles para cada um dos 10 ativos. Na OKX, o histórico é paginado em blocos de 300 candles. Além disso, os ativos eram processados um por um e a fila global, embora descrita como limite de cinco requisições por segundo, também mantinha apenas uma requisição ativa. Um timeout de proxy Yahoo podia bloquear todas as outras fontes.

## Correção de desempenho

1. A fila agora separa limite de início (cinco por segundo) de concorrência (até três em voo).
2. O scanner consulta até três ativos em paralelo.
3. A lista usa uma janela intermediária de 3.000 candles por ativo, mantendo o motor completo, indicadores, zonas e análise multi-timeframe.
4. “Abrir análise” reutiliza exatamente a fotografia ranqueada; não ocorre uma segunda coleta escondida.
5. “Analisar agora” continua usando até 10.000 candles para o ativo escolhido.
6. Cada linha concluída aparece imediatamente e o ranking parcial é marcado como “MELHOR ATÉ AGORA” até o ciclo terminar.

Em medição real com BTCUSDT e ETHUSDT no M5, os dois ativos com 3.000 candles cada terminaram em 11.042 ms no total, média de 5.521 ms por ativo. O tempo de um ciclo completo ainda varia com rede, ativo, timeframe e disponibilidade dos proxies Yahoo.

## Verificações

- JavaScript: 24/24 arquivos com sintaxe válida;
- Edge Functions TypeScript: 18/18 arquivos com sintaxe válida;
- fila do scanner: 3/3;
- consistência da fotografia do ranking: 8/8;
- causalidade local: 5/5;
- testes Edge: 10/10;
- contrato estático de segurança: aprovado.

O navegador de teste não pôde abrir arquivos locais por política de segurança do ambiente. Nenhum contorno foi usado; a validação de integração foi feita pela mesma camada real de dados e pelos contratos automatizados acima.
