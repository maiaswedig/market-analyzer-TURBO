# Revisão Claude — motor canônico no frontend e qualidade v4

Data da implementação: 31/08/2026

## Objetivo desta rodada

Esta rodada não tenta aumentar artificialmente a taxa de acerto e não recalibra o motor com a mesma amostra usada para avaliá-lo. Ela corrige duas separações de produto:

1. a nota técnica A+/A/B/C/D passa a representar somente a força relativa das evidências técnicas, com pesos transparentes e retorno decrescente entre sinais correlacionados;
2. a qualidade operacional `confirmed/technical/low` passa a ser decidida pelo banco e não pode receber `confirmed` apenas por possuir nota A/A+ ou `artifact.usable=true`.

O frontend passa a mostrar o resultado congelado do backend como fonte oficial. O motor local continua disponível abaixo para gráfico, explicação complementar e comparação, mas não é apresentado como a mesma decisão.

## 1. Avaliação técnica por famílias

Arquivo principal: `supabase/functions/_shared/features.ts`.

Os oito critérios continuam visíveis, mas agora pertencem a cinco famílias. Os pesos dentro das famílias correlacionadas são decrescentes:

| Família | Critérios | Peso máximo |
| --- | --- | ---: |
| Tendência | força direcional 15; alinhamento EMA 9; estrutura EMA 6 | 30 |
| Momentum | MACD 12; momentum recente 8 | 20 |
| RSI | contexto do RSI 12 | 12 |
| Volume | volume relativo 20 | 20 |
| Price action | pavios/rejeição 18 | 18 |
| Total | 8 critérios | 100 |

Um critério aprovado recebe o peso inteiro, parcial recebe metade e reprovado recebe zero. As faixas não foram afrouxadas: A+ >= 85, A >= 72, B >= 58, C >= 42 e D abaixo de 42.

O payload agora inclui `assessment.families`, e os motivos gravados mostram tanto o resumo de cada família quanto cada aprovação/parcial/reprovação. A nota continua independente de atrasos, notícias, liquidez, validade do modelo e demais travas operacionais.

Durante a validação em produção foi detectado que o payload enviava `decision.score` (intensidade direcional usada como uma entrada do primeiro critério), enquanto `grade` vinha de `decision.assessment.score`. Isso permitia uma apresentação incoerente como nota A com força 53. A Edge Function agora envia `score: decision.assessment.score`; a probabilidade e o limite inferior do modelo continuam separados e a intensidade direcional permanece apenas como evidência interna do critério de força.

## 2. Contrato de qualidade v4 no banco

Migration: `supabase/migrations/202608310026_decouple_confirmed_quality.sql`.

A migration cria versões imutáveis v3 das três políticas operacionais, derivadas das políticas que estavam ativas e acrescidas destes campos:

- `require_promoted_champion_confirmed = true`;
- `min_promotion_paired_samples_confirmed = 500`;
- `min_probability_lb_confirmed = 0.55`;
- `min_ev_lb_confirmed = 0`;
- `quality_contract_version = 4`.

Nenhuma decisão antiga é reclassificada. Cada decisão mantém seu `policy_version_id` original.

### Regra final

- `LOW`: a análise não produziu sinal ou falhou no gate base da política do modo;
- `TECHNICAL`: passou no gate base, mas não provou toda a confirmação prospectiva;
- `CONFIRMED`: passou no gate base e, adicionalmente, o banco provou:
  - evento durável `promote_champion` para o modelo usado;
  - `promotion_review_id` válido e revisão `passed=true`;
  - promoção efetiva antes do momento da decisão;
  - pelo menos 500 oportunidades prospectivas pareadas na revisão;
  - limite inferior da probabilidade >= 0,55;
  - EV calculado com o limite inferior > 0 após custo e política de empate.

O trigger consulta `model_deployment_events` e `promotion_reviews` diretamente. Ele não confia em `champion_usable`, em texto de blocker ou em um campo enviado pela Edge Function. A nota `grade` não participa do gate de qualidade.

O `feature_snapshot` das novas decisões registra a prova usada: `confirmed_pass`, `champion_promoted_prospectively`, `promotion_review_id`, `promotion_paired_samples`, `expected_ev_lb95` e `quality_contract_version=4`.

## 3. Fonte oficial do navegador

A migration cria a projeção somente leitura `public.cloud_canonical_signals`:

- uma decisão congelada mais recente por `asset|timeframe|mode`;
- somente o champion ativo no momento da consulta;
- decisões invalidadas são excluídas;
- a tabela privada continua inacessível ao navegador;
- `anon` e `authenticated` possuem apenas `SELECT` na view;
- a função privada usa `security definer` com `search_path=''` e a view usa `security_invoker=true`.

Arquivos do navegador:

- `js/cloud-api.js` lê e normaliza a nova projeção;
- `index.html` adiciona o cartão “SINAL OFICIAL · MOTOR BACKEND 24/7” no topo;
- `js/signal-ai.js` escolhe automaticamente a melhor oportunidade oficial, preserva direção e nota, exibe qualidade separada, LB da probabilidade, EV conservador, amostra, entrada/expiração e prova da promoção;
- `market-analyzer.css` adiciona o visual responsivo do cartão;
- a análise e o scanner locais foram rotulados como complementares.

Decisões antigas ao contrato v4 permanecem visíveis, mas o frontend não reaproveita uma eventual classificação `confirmed` antiga: mostra “aguardando contrato estatístico v4” até o próximo ciclo publicar uma nova decisão.

## 4. Estado real observado antes da publicação

No banco de produção havia 26 eventos `bootstrap_champion` e nenhum evento `promote_champion`. Portanto, no início desta versão, zero sinais devem aparecer como confirmação prospectiva. Isso é esperado e honesto: A/A+ ainda pode aparecer como nota técnica, mas a qualidade será `technical` ou `low` até ocorrer uma promoção que passe nos gates prospectivos.

A Edge Function `market-cycle` foi publicada como versão 9, com JWT obrigatório. O cron existente continua ativo a cada minuto; o backend não depende de a página ficar aberta. Os primeiros ciclos do contrato v4 retornaram HTTP 200 e já produziram linhas canônicas; como não existe promoção prospectiva no ledger, `confirmed_pass=false` permanece correto.

## 5. Testes executados

- Edge unit tests: 29/29;
- causalidade local: 5/5;
- liquidação do histórico: 8/8;
- política do histórico: 17/17;
- fotografia do ranking: 8/8;
- fila do scanner: 3/3;
- contrato estático de segurança: aprovado;
- contrato de consistência entre força e nota do backend: aprovado;
- replay/backtest: 14 verificações;
- calibração de score: 25/25;
- migration ensaiada no Postgres em transação com rollback: aprovada;
- `confirmed_quality_contract.sql` executado no banco após a migration: aprovado;
- auditoria de sintaxe de `signal-ai.js` e `cloud-api.js`: aprovada.

### Verificação final em produção

- deploy Netlify de produção: `6a963badccc035071f49a139`, estado `ready`;
- URL: `https://market-analyzer-ia.netlify.app/`;
- Edge Function `market-cycle`: versão 9 ativa, `verify_jwt=true`;
- os ciclos da versão 9 retornaram HTTP 200;
- o banco confirmou exemplos consistentes depois do ajuste: score 77/nota A, score 61/nota B, score 57/nota C e score 39/nota D;
- o frontend exibiu uma decisão cloud A+ com 85/100 e qualidade baixa, provando visualmente que nota e qualidade continuam separadas;
- teste responsivo em 390 px: cartão oficial com 351 px, sem rolagem horizontal;
- console do navegador: zero erros após o carregamento do sinal cloud;
- a pasta pública enviada à Netlify continha somente o frontend; migrations, testes e código administrativo não foram enviados ao host estático.

## 6. Pontos específicos para o Claude revisar

1. Confirmar que a consulta de promoção está corretamente limitada a evento anterior ou igual a `decision_at` e ao mesmo `asset|timeframe|model_artifact_id`.
2. Confirmar que `promotion_reviews.paired_samples` é a amostra prospectiva pareada adequada e não uma amostra offline reutilizada.
3. Confirmar que a seleção do champion em `cloud_canonical_signal_rows()` acompanha corretamente o último evento de deployment e não expõe modelo aposentado.
4. Confirmar que nenhum caminho de frontend volta a tratar a nota A/A+ como qualidade `confirmed`.
5. Confirmar que a mesclagem da oportunidade ranqueada com a linha canônica do mesmo `id` não troca a fotografia da decisão.
6. Confirmar que os pesos decrescentes por família são aceitáveis como ordenação técnica, sem interpretá-los como probabilidade calibrada.
7. Confirmar que o wrapper vigente `public.register_market_decision` continua relendo e retornando a qualidade canônica calculada pelo trigger.
8. Confirmar que a view pública não oferece nenhum caminho de escrita nem exposição das tabelas privadas.

## 7. Decisões deliberadamente não tomadas

- não houve inversão automática de direção;
- não houve ajuste de pesos para melhorar resultado passado;
- não houve promoção manual de modelo;
- não houve reclassificação do histórico;
- não houve integração para executar ordens em corretora;
- `usable=true` não foi tratado como prova de edge;
- o histórico local e o ledger cloud continuam separados e identificados.

Esta entrega melhora coerência, auditabilidade e apresentação. Ela não afirma que o sistema já possui vantagem estatística positiva e não transforma nota técnica em promessa de acerto.
