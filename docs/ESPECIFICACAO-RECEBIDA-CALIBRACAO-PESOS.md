# Pacote para o programador — Calibração ampliada de pesos (score.js)

Este arquivo reúne: (1) as ressalvas e avisos levantados na revisão, e (2) a especificação completa do desenho técnico da calibração ampliada de pesos (`desenho-calibracao-pesos-score.md`). Leia as ressalvas primeiro — elas contextualizam decisões críticas que aparecem no desenho abaixo.

---

## PARTE 1 — Ressalvas e avisos antes de codar

### 1.1 Sobre as duas margens estatísticas (99% na busca, 95% na confirmação)

A diferença entre `z = 2.58` (~99%) na Camada 1 de Seleção e `z = 1.96` (95%) na Camada 2 de Confirmação **não é capricho** — é o que resolve o problema de "testar até 35 combinações de peso até uma parecer boa por acaso" (multiple comparisons). Se o programador usar 95% nas duas camadas, ou pior, só numa camada, a calibração perde a proteção contra falso positivo que o resto do sistema já aplica em outros pontos: o `BRIER_Z` em `ml.js` e o limite inferior de 95% pareado usado em `review_challenger()`. Essas três proteções seguem a mesma lógica estatística e precisam permanecer consistentes entre si.

### 1.2 Sobre a refatoração de `runBacktest`

Dividir `runBacktest` em `buildReplayContext` (fase cara, independente de peso: indicadores, zonas, estrutura) e `replayWithConfig` (fase barata, dependente de peso: score, decide, guards, fingerprint) é uma mudança estrutural que toca um arquivo (`js/backtest.js`) compartilhado por três consumidores: UI, scanner e a própria calibração. Recomendação: rodar a suíte de testes existente (`tools/verify-*.mjs`) imediatamente depois dessa refatoração, **antes** de escrever qualquer lógica nova de busca de pesos — só para confirmar que nada quebrou no comportamento atual (UI, scanner e calibração de B0/B1 continuam idênticos).

### 1.3 Avaliação geral do desenho de calibração de pesos

**Pontos fortes:**
- Separação caro/barato bem identificada — evita recalcular EMA/RSI/ATR/zonas a cada candidato de peso.
- Redução de dimensionalidade inteligente: soma fixa em 100 (6 graus de liberdade reais) e ajuste de um peso por vez via coordinate ascent, tornando a busca auditável e explicável.
- Proteção contra multiple comparisons bem fundamentada e consistente com o resto do sistema (ver 1.1).
- Uso de janelas independentes (não walk-forward expansivo), evitando que um candidato "decore" um único período longo.

**Pontos que merecem atenção antes de codar:**
- **k=4 janelas pode ser pouco** para a barra exigida (passar em todas as 4, não na média). Com só 4 janelas, o critério fica sensível a uma única janela "ruim" por razão de regime de mercado, não de qualidade real do peso. Avaliar se compensa usar 5-6 janelas nos ativos com mais histórico.
- **Mínimo de 200 sinais por janela pode ser inviável em vários segmentos ativo/timeframe.** Antes de rodar em produção, checar quantos segmentos de fato acumulam volume suficiente para bater 200 sinais × 4 janelas. O desenho já prevê pular a categoria nesse caso (decisão correta), mas o programador deve esperar isso com frequência no início, não como exceção rara.
- **Ordem de prioridade fixa** (tendência → momentum → multi-TF → price action → S/R → volatilidade → volume) é uma escolha de negócio, não estatística. Como o coordinate ascent é sensível à ordem, vale confirmar explicitamente essa hipótese antes de implementar, já que ajustar volume primeiro poderia levar a um resultado final diferente de ajustar tendência primeiro.
- **Camada 2 é single-shot** — se falhar, a rodada inteira é descartada, sem chance de reajuste no mesmo holdout (correto para integridade estatística, mas caro em tempo). Vale já prever como o relatório de falha na Camada 2 será registrado e comunicado, não só o booleano final `accepted: true/false`.

### 1.4 Recomendação geral

Tratar esta calibração como parte de um sistema causal de paper trading, não como gerador de promessas de lucro. A implementação só deve ser considerada pronta quando preservar causalidade e append-only, tiver teste proporcional ao risco, não introduzir segredo no frontend, e não promover nenhum novo vetor de pesos sem evidência estatística fora da amostra usada para escolhê-lo.

---

## PARTE 2 — Especificação completa: desenho técnico da calibração ampliada de pesos

# Desenho técnico — calibração ampliada de `score.js` (pesos de categoria)

Este documento é a especificação para o programador implementar a Fase A do
item 3 (calibrar os 7 pesos de categoria de `DEFAULT_WEIGHTS`, mantendo os
coeficientes internos de cada categoria fixos por enquanto). Baseado em
leitura direta de `js/backtest.js`, `js/analyze.js`, `js/score.js` e
`js/score-calibration.js` do pacote atual.

---

## Por que a busca de hoje não escala direto para pesos

`tools/calibrate-score.mjs` hoje roda `runBacktest()` (que já embute
`evaluateBar()` por vela) **uma vez**, gera `bars[]` com `bias`/`penalties`
já agregados, e depois `evaluateScoreScale()` só reprocessa esse array final
trocando `B0`/`B1`/`minScore` — barato, porque `bias` não muda com esses dois
números.

Pesos de categoria são diferentes: eles mudam `bias` (e, por consequência,
`direction`, que alimenta praticamente tudo — travas de zona, VSA, sessão,
fingerprint de setup). Isso quer dizer que, para cada combinação de pesos
candidata, o sistema realmente precisa recalcular `computeScore` +
`decide()` de novo, vela por vela. A pergunta certa não é "dá pra evitar
isso", é "o que exatamente precisa ser recalculado, e o que pode continuar
sendo reaproveitado".

## Separar o que é caro do que é barato

Olhando `js/backtest.js` e `js/analyze.js`:

- **Caro, independente de peso** (rodar 1 vez só): `buildSeries()` +
  `snapshotAt()` em `js/features.js` — constrói EMA/RSI/MACD/ATR/zonas/
  price action/estrutura para toda a série de candles. Isso não depende de
  `cfg.weights` nem de `B0/B1`.
- **Barato, depende de peso** (precisa rodar por candidato): dentro de
  `evaluateBar()` — `computeScore(snap, mtf, cond, cfg)`, `decide(...)`,
  as travas (`wickRejectionGuard`, `higherTfZoneGuard`, `vsaGuard`,
  `sessionGuard` — todas recebem `dir` como parâmetro) e `fingerprint()`
  para a classe de setup. Nenhuma dessas recalcula indicador nenhum; são
  aritmética simples em cima do `snap` já pronto.

**A refatoração necessária:** separar `runBacktest()` em duas funções.

```js
// js/backtest.js

// Fase cara — roda 1x por ativo/timeframe/janela de dados, nunca por candidato.
export async function buildReplayContext(asset, tfKey, settings, opts = {}) {
  // ...tudo que hoje monta `candles`, `snaps` (via buildSeries/snapshotAt),
  // `higherAt`, `lowerZonesAt`, `historicalNewsUnavailable` etc.
  // Retorna um objeto imutável: { asset, tfKey, tfSec, candles, snaps,
  //   higherAt, lowerZonesAt, historicalNewsUnavailable, startIdx, meta }
}

// Fase barata — roda 1x por candidato de pesos/B0/B1/minScore, reaproveitando o contexto.
export function replayWithConfig(context, candidateCfg, opts = {}) {
  // ...o laço `for (let n = startIdx; n < snaps.length - 1; n++)` que hoje
  // vive dentro de runBacktest, mas lendo de `context` em vez de recalcular
  // candles/snaps. Constrói `bars[]` exatamente como hoje, só que com
  // `candidateCfg.weights`/`scoreB0`/`scoreB1`/`minScore` no lugar do cfg fixo.
  // Retorna { bars, meta } no mesmo formato que `runBacktest` retorna hoje.
}

// runBacktest(asset, tfKey, settings, opts) continua existindo, agora como
// buildReplayContext(...) seguido de replayWithConfig(...) — não quebra
// nenhum chamador atual (UI, scanner, calibrate-score.mjs para B0/B1).
```

Isso é reaproveitável no lugar certo: o ranking de setups (`rankSetups`,
`resolvedByExpiry`) e as janelas de resolução walk-forward que já existem no
laço de hoje continuam dentro de `replayWithConfig`, porque dependem de
`dir`/`fingerprint`, que mudam com peso. Só a parte de indicadores fica de
fora.

---

## Parametrização: pesos normalizados, não 7 números livres

`DEFAULT_WEIGHTS` soma 100 (`22+18+18+14+12+8+8`). Buscar 7 números livres é
buscar em 7 dimensões; qualquer grid vira inviável rápido. Duas decisões
reduzem isso:

1. **Manter a soma fixa em 100** (renormalizar depois de qualquer alteração)
   — reduz para 6 graus de liberdade reais, não 7.
2. **Não buscar tudo de uma vez.** Seguir a ordem de prioridade já combinada
   (tendência → momentum → multi-TF → price action → S/R → volatilidade →
   volume) e ajustar **um peso por vez**, redistribuindo a diferença
   proporcionalmente entre os demais. Isso transforma uma busca
   multidimensional cara numa sequência de buscas unidimensionais baratas —
   e cada passo é auditável (dá pra dizer exatamente "o peso de tendência
   subiu de 22 para 26 porque X", em vez de um vetor de 7 números que ninguém
   consegue explicar).

### Algoritmo (coordinate ascent guiado)

```
pesos_atuais = DEFAULT_WEIGHTS (cópia)
para cada categoria C na ordem de prioridade:
    candidatos = [pesos_atuais com peso(C) em 0.7×, 0.85×, 1.0×, 1.15×, 1.3× do valor atual]
    (renormalizar cada candidato para somar 100, distribuindo a diferença
     proporcionalmente entre as OUTRAS categorias, não mexendo em C)
    avaliar cada candidato pelo protocolo de validação abaixo
    se o melhor candidato bater o critério de aceite (ver seção seguinte):
        pesos_atuais = melhor candidato
    senão:
        manter o peso de C como estava, seguir para a próxima categoria
fim
```

Isso dá, no máximo, `7 categorias × 5 valores = 35` avaliações completas de
backtest — cada uma reaproveitando o mesmo `context` caro, então o custo
total é gerenciável.

---

## Protocolo de validação: nested walk-forward + holdout final único

A calibração de B0/B1/minScore de hoje usa um único corte
calibração/validação. Isso é aceitável para 3 parâmetros com pouca chance de
"acertar por sorte". Para pesos, com até 35 avaliações, o risco de multiple
comparisons é real — testar 35 candidatos e aceitar o que bateu o benchmark
com 95% de confiança tem uma chance bem maior que 5% de aceitar um falso
positivo, exatamente pela quantidade de tentativas.

**Estrutura em duas camadas:**

### Camada 1 — Seleção (walk-forward com k janelas, dados "gastáveis")
Divide os dados disponíveis (exceto o holdout final reservado, camada 2) em
k janelas cronológicas não sobrepostas (sugestão: k=4).

Para cada categoria sendo ajustada (loop do algoritmo acima), cada candidato
de peso precisa passar em **todas as k janelas**, não na média:
- Treina/avalia na janela 1, com embargo (`purgeBars`) antes do corte de
  validação daquela janela — reaproveitar `purgeBars` que já existe em
  `score-calibration.js`.
- Repete para janelas 2, 3, 4 (cada uma é uma fatia cronológica diferente,
  não uma expansão cumulativa — janelas independentes, não walk-forward
  expansivo, para não deixar o candidato "decorar" um único período longo).
- Critério de aceite do candidato nesta camada: em **todas** as 4 janelas,
  `evLb95 > benchmarkEv` E `ev > ev_do_peso_atual_na_mesma_janela`.
- **Correção por múltiplas comparações:** como até 35 candidatos são
  testados ao longo do processo completo, usar um `z` mais conservador que
  1.96 nesta camada — sugestão prática: `z = 2.58` (equivalente a ~99% em
  vez de 95%) para o cálculo de `evLb95` usado **só** nesta fase de seleção.
  Isso não precisa ser uma correção de Bonferroni exata; o objetivo é só
  não deixar a barra de aceitação tão baixa que 35 tentativas quase
  garantam um "vencedor" por acaso.

### Camada 2 — Confirmação (holdout final, nunca visto até este ponto)
Depois que o algoritmo de coordinate ascent terminar e produzir um vetor de
pesos final, esse vetor único passa **uma vez** por um holdout reservado
desde o início (o pedaço mais recente dos dados, nunca usado em nenhuma das
k janelas da Camada 1).

- Aqui sim, `z = 1.96` (95%) é apropriado — porque só há **um** candidato
  sendo testado nesta camada, não 35. É essa separação (buscar num lado,
  confirmar uma única vez do outro) que torna as duas margens diferentes
  estatisticamente corretas ao mesmo tempo, em vez de contraditórias.
- Critério de aceite final: `evLb95 > benchmarkEv` E `ev > ev_do_default`
  E `ev > ev_do_default` também precisa valer comparando com o modelo atual
  em produção (não só o `DEFAULT_WEIGHTS` de código), se houver um.

Se o candidato falhar na Camada 2, o resultado é descartado por inteiro —
**não** se tenta "salvar" ajustando de novo com o mesmo holdout (isso
queimaria a única confirmação independente que existe).

---

## Gating de amostra mínima por fase

Regra prática (aproximação, não é uma fórmula estatística exata, mas dá uma
âncora concreta para o programador não subdimensionar): cada categoria
ajustada nesta fase consome efetivamente 1 grau de liberdade por vez (graças
ao coordinate ascent), mas a Camada 1 já está testando 5 valores por
categoria × 4 janelas = 20 avaliações por categoria.

- Mínimo de sinais por janela de validação na Camada 1: **200** (acima do
  `minValidationSignals` de 60 usado hoje para B0/B1 — porque agora o
  z exigido é maior e o efeito de cada peso é mais sutil que o de B0/B1).
- Mínimo de sinais no holdout final da Camada 2: **300**, não compartilhado
  com nenhuma janela da Camada 1.
- Se qualquer janela não atingir o mínimo, a categoria inteira é pulada
  nesta rodada (mantém o peso atual) — não se reduz o mínimo para "conseguir
  rodar".

---

## Onde isso se encaixa nos arquivos existentes

| Arquivo | Mudança |
|---|---|
| `js/backtest.js` | Dividir `runBacktest` em `buildReplayContext` + `replayWithConfig` (ver seção de arquitetura). `runBacktest` continua existindo como composição das duas, para não quebrar UI/scanner. |
| `js/score-calibration.js` | Nova função `calibrateCategoryWeights(context, options)` — implementa o coordinate ascent + as duas camadas descritas acima. Reaproveita `evaluateScoreScale`-like para calcular EV/LB95/benchmark por janela. |
| `tools/calibrate-score.mjs` | Novo modo (`--mode=weights` ou script irmão `calibrate-weights.mjs`) que chama `buildReplayContext` uma vez e depois `calibrateCategoryWeights`. Manter o modo atual (B0/B1/minScore) intacto e default. |
| `tools/verify-score-calibration.mjs` | Adicionar verificação de que o relatório de pesos sempre declara `candidatesEvaluated` (contagem real) e o `z` usado em cada camada — para a correção por múltiplas comparações ser auditável, não implícita no código. |

---

## O que este desenho deliberadamente NÃO faz (ainda)

- Não calibra os coeficientes internos de cada categoria (os `0.42`, `0.16`,
  os limiares de RSI 74/26 etc.) — isso é a Fase B, só depois desta Fase A
  estar rodando e ter passado por um ciclo real de dados novos (ver item 1
  do roteiro anterior: não recalibrar duas vezes seguidas com a mesma
  amostra).
- Não promove nada automaticamente. Igual à calibração de B0/B1 hoje, o
  resultado é sempre diagnóstico — uma pessoa decide se adota, olhando o
  relatório completo (as 4 janelas da Camada 1 + a Camada 2), não só o
  `accepted: true/false` final.
- Não tenta resolver o "corte por concordância modelo-heurística" nem
  nenhum outro achado antigo — escopo é só a calibração de pesos.
