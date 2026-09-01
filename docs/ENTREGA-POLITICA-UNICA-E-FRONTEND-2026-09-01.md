# Entrega — política única e refinamento do frontend

Data de corte: 01/09/2026.

URL pública vigente: `https://market-analyzer-ia.vercel.app/`.

## Objetivo

Remover uma segmentação operacional que não produzia curvas diferentes, retirar o custo adicional que o usuário não utiliza e reduzir a fricção visual da primeira visita. A entrega não altera resultados passados, não promove modelos e não cria alegação de vantagem estatística.

## Política única

- O seletor conservador/neutro/agressivo foi removido do frontend.
- O backend passa a registrar decisões novas somente na política `cloud-engine-single`, usando internamente o código neutro por compatibilidade com o schema existente.
- O custo adicional das decisões novas é zero.
- Os ledgers e as curvas antigas dos três modos permanecem imutáveis e identificados como legado.
- As views públicas `cloud_single_paper_summary` e `cloud_single_quality_paper_summary` isolam a curva prospectiva vigente. Elas não misturam decisões antigas.
- A primeira execução limpa após a implantação registrou somente decisões neutras da nova política.

Essa simplificação não melhora o motor por si só. Ela elimina a repetição artificial de uma mesma decisão em três modos e torna a medição futura mais clara.

## Frontend

- As variáveis visuais foram consolidadas em `theme.css`, o único arquivo com `:root`.
- Seções secundárias e estados vazios foram agrupados em um painel de detalhes fechado inicialmente. Ele é revelado após a primeira análise bem-sucedida e a preferência fica salva no navegador.
- Ativo e timeframe permanecem antes do botão principal. Quantidade de candles e regra de empate foram movidas para configurações avançadas.
- O widget do TradingView usa carregamento tardio por `IntersectionObserver`.
- Badges de nota vazios ficam invisíveis até existir uma nota real.
- As tabelas viram cards empilhados em telas pequenas, sem rolagem horizontal.
- A grade principal foi corrigida para não exceder a largura da tela.
- A interface usa os rótulos “política única” e “custo adicional zero”; o antigo seletor e o campo de custo não existem mais.

## Motor preservado

- A direção continua visível mesmo quando a qualidade é baixa.
- Nota técnica, qualidade estatística e probabilidade continuam sendo conceitos separados.
- `confirmed` continua dependendo de promoção prospectiva real e dos gates da migration 026; A/A+ não concede confirmação.
- O histórico A/A+ continua sendo uma amostragem de frontend; não reclassifica o ledger canônico.
- Nenhum resultado antigo foi recalculado ou apagado.

## Banco e contratos

- Migration nova e append-only: `202609010027_single_policy_zero_cost.sql`.
- Contrato SQL: `supabase/tests/single_policy_contract.sql`.
- Contrato estático do frontend: `tools/verify-single-policy-frontend.mjs`.
- O `market-cycle` foi implantado na versão 10.
- O snapshot técnico passou a declarar 27 migrations e a política única como estado vigente.
- O frontend foi publicado na Vercel no projeto `market-analyzer-ia`, plano Hobby, mantendo o Supabase como backend independente.

## Validação executada

- Sintaxe JavaScript e TypeScript.
- Testes das Edge Functions: 29/29.
- Contratos de causalidade, histórico, ranking, scanner, segurança e replay.
- Contratos de calibração e documentação técnica.
- Verificação desktop e mobile em navegador real, incluindo ausência de rolagem horizontal.
- Verificação do lazy-load do TradingView.
- Verificação de que não há botões de modo nem campo de custo no DOM.
- Advisors do Supabase sem erro ou alerta novo; permanecem apenas avisos informativos já documentados sobre RLS deny-by-default e índices ainda não usados.

## Estado estatístico honesto

A curva da política única começa sem amostra resolvida própria. O legado continua com EV abaixo do benchmark e zero promoções prospectivas reais. Portanto, esta entrega melhora coerência, operação e auditabilidade; não comprova lucro nem aumento de assertividade.

## Pontos para o revisor externo

1. Confirmar que as views vigentes filtram exclusivamente `cloud-engine-single` e não caem para políticas antigas.
2. Confirmar que decisões novas registram `operation_cost = 0` sem reescrever o legado.
3. Confirmar que `MODES` no `market-cycle` contém somente `neutro`.
4. Confirmar que o código de compatibilidade local força modo neutro e custo zero antes da análise.
5. Confirmar que o accordion, o lazy-load e os cards mobile não alteram a fotografia canônica do sinal.
6. Confirmar que a migration 027 não enfraquece o gate `confirmed` definido na migration 026.
