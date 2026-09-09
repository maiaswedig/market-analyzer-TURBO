# Recuperação e revisão periódica — 09/09/2026

O reinício autorizado recuperou o banco. Os cinco ciclos consultados às
01:45 UTC concluíram sem erros, em 4,36–9,56 segundos. Isso confirma recuperação
operacional imediata, não estabilidade prolongada nem melhora preditiva.

## Revisão independente

- `market-cycle` não faz mais a revisão global de promoção a cada minuto.
- `review-models` revisa um ativo/timeframe a cada cinco minutos, com rotação
  determinística sobre a watchlist ativa e M5/M15/M30/H1.
- Com oito ativos, a cobertura completa leva 160 minutos. A quantidade cresce
  proporcionalmente ao número de ativos. Falhas são reavaliadas na próxima volta.
- O treinamento mantém sua revisão adicional do próprio escopo após gravar um
  artefato. A rotina periódica independe de sucesso ou falha desse treinamento.
- A RPC existente continua aplicando todos os critérios de promoção, com mínimo
  de 500 e margem Z 1,96. Não há alteração de pesos, direção ou histórico.
- A função exige JWT no gateway e o segredo interno já usado pelos workers.

## Implantação reproduzível

Publicar `review-models` com suas dependências e `verify_jwt=true`; depois executar
`tools/schedule-model-reviews.sql`. O script atualiza o job pelo nome e reutiliza
as referências existentes ao Vault sem copiar valores secretos. Se os jobs forem
recriados ou desativados, incluir `signal-atlas-review-models` nessa manutenção.

Teste: `npm run test:review-schedule` verifica cobertura, repetição da rotação,
independência da ordem recebida, fronteiras de tempo e watchlist vazia.
Os 32 testes Edge também passaram.

## Correção do diagnóstico anterior

Não foi demonstrado que a promoção fosse a causa principal da saturação.
Na medição acumulada, `resolve_due_outcomes` consumia 15.686 segundos em 11.485
chamadas (média 1,366 s); a revisão global, 3.361 segundos em 10.977 chamadas
(média 0,306 s). Essas métricas acumuladas não isolam CPU nem o incidente.
A redução de revisões é uma limitação de carga, não uma prova de causa raiz.
Resta acompanhar resolução, consultas de candles e latência sob carga real.
