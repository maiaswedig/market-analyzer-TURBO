# Revisão Claude — separação entre nota técnica e qualidade operacional

Data: 31/08/2026

## Motivo da mudança

O backend reduzia automaticamente qualquer decisão com pelo menos um bloqueador para nota C ou D. Na prática, isso misturava duas perguntas diferentes:

1. **O gráfico é tecnicamente mais forte ou mais fraco que os demais?**
2. **Já existe evidência estatística e operacional suficiente para confirmar a entrada?**

O banco continha 3.156 decisões champion: 3.147 D, 9 C e nenhuma A/A+/B. Todas estavam com `status=wait` e `quality=low`. Assim, uma leitura que passasse em quatro critérios podia receber a mesma nota de outra que passasse em apenas dois.

## Intenção

- Preservar sempre a direção técnica quando ela existir.
- Comparar oportunidades pela soma ponderada de evidências positivas e negativas.
- Manter separada a qualidade operacional (`confirmed`, `technical`, `low`).
- Não facilitar promoção de modelo, não alterar outcomes e não reclassificar o passado.
- Fazer os novos A/A+ de qualidade baixa aparecerem no histórico visual, mas continuarem fora do ranking local elegível.

## Implementação

### Oito critérios ponderados

`supabase/functions/_shared/features.ts` agora calcula:

| Critério | Peso |
| --- | ---: |
| Força direcional | 16 |
| Alinhamento das EMAs | 16 |
| Estrutura EMA 9/21/50 | 10 |
| Contexto do RSI | 10 |
| Impulso MACD | 12 |
| Momentum recente | 12 |
| Confirmação por volume | 14 |
| Pavios e rejeição | 10 |

Cada item pode receber `pass` (100% do peso), `partial` (50%) ou `fail` (0%). O total soma 100 pontos. O retorno registra quantidade aprovada, parcial e reprovada, além do detalhe individual.

### Nota técnica

- A+: 85 ou mais
- A: 72 a 84,9
- B: 58 a 71,9
- C: 42 a 57,9
- D: abaixo de 42

A nota deixou de receber um teto C/D simplesmente porque existe bloqueador. Portanto, uma saída válida pode ser `COMPRA · nota A · avaliação baixa`.

### Qualidade operacional preservada

Nada mudou nos gates que determinam:

- `status=signal` ou `status=wait`;
- `quality=confirmed|technical|low`;
- EV líquido e limite inferior;
- amostra estatística mínima;
- latência/idade do dado;
- promoção champion/challenger;
- elegibilidade do ranking local;
- resolução causal de outcomes.

### Explicação no frontend

Cada nova decisão inclui primeiro um resumo, por exemplo:

`Avaliação técnica ponderada: 74/100 · 5/8 aprovadas · 1 parcial · 2 reprovadas`

Em seguida ficam os oito itens `APROVADO`, `PARCIAL` ou `REPROVADO`, com pontos e justificativa. O frontend cloud mostra esses itens em um painel expansível.

## Persistência e segurança

- Migration `202608310025_public_cloud_decision_explanations.sql`.
- Nova projeção somente leitura `public.cloud_decision_explanations`.
- Função privada `SECURITY DEFINER` com `search_path=''`.
- View pública `security_invoker`.
- `anon` e `authenticated` recebem somente `SELECT`; nenhuma escrita.
- Registros invalidados são excluídos.
- A projeção não é consumida por ranking, treino, inferência ou promoção.

## Arquivos alterados

- `supabase/functions/_shared/types.ts`
- `supabase/functions/_shared/features.ts`
- `supabase/functions/market-cycle/index.ts`
- `supabase/functions/tests/features_test.ts`
- `supabase/migrations/202608310025_public_cloud_decision_explanations.sql`
- `supabase/tests/cloud_decision_explanations_contract.sql`
- `supabase/tests/security_contract.sql`
- `js/cloud-api.js`
- `js/signal-ai.js`
- `index.html`
- `market-analyzer.css`
- `tools/verify-security-release.mjs`

## Integridade histórica

Decisões antigas não são recalculadas nem reclassificadas. A nova nota vale somente para decisões congeladas depois da implantação. Isso evita escolher retrospectivamente quais sinais antigos deveriam ter sido A ou A+.

## Testes executados

- Edge unit tests: 28/28.
- Causalidade local: 5/5.
- Liquidação do histórico: 8/8.
- Política do histórico: 17/17.
- Snapshot do ranking: 8/8.
- Fila do scanner: 3/3.
- Contrato estático de segurança: OK.
- Replay do backtest: 14 verificações.
- Calibração do score: 25/25.

## Pontos pedidos para a revisão

1. Os oito critérios são causalmente calculáveis no instante da decisão?
2. Há dupla contagem excessiva entre EMA, MACD e momentum?
3. Os pesos e faixas de nota são aceitáveis apenas como ordenação técnica, sem alegação de edge?
4. Algum caminho usa a nova nota para contornar `quality`, EV ou promoção?
5. A projeção pública de explicações expõe somente dados não sensíveis e permanece somente leitura?
6. O histórico antigo permaneceu imutável?

## Limite da mudança

Essa alteração melhora comparação e transparência; ela não comprova lucro, não garante acerto e não transforma uma avaliação baixa em confirmação estatística.
