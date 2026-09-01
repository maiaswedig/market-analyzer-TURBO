# Market Analyzer — revisão técnica atual

> Documento gerado por `tools/generate-technical-review.mjs`. Não edite números de produção diretamente neste arquivo: atualize primeiro `docs/technical-review-runtime-snapshot.json` com consultas somente leitura e execute `npm run docs:technical-review`.

Última verificação do ambiente: **2026-09-01T12:59:03.252784Z**  
Fonte do snapshot: **Supabase production, read-only queries**  
Contrato de qualidade vigente: **v4 (migration 026)**

## 1. Conclusão executiva

O Market Analyzer é uma ferramenta educacional de análise e paper trading para cripto e Forex. Ele não envia ordens, não acessa saldo e não promete lucro. O sistema coleta dados e treina challengers automaticamente, mas uma melhoria só pode virar champion após validação prospectiva pareada. A nota técnica A/A+ ordena oportunidades; ela não é probabilidade calibrada nem transforma uma decisão em `confirmed`.

No snapshot acima, o sistema **ainda não comprovou vantagem líquida sobre o benchmark**. Isso não deve ser escondido nem corrigido ajustando pesos na mesma amostra. O próximo avanço depende de coleta prospectiva, comparação fora da amostra e eventual promoção que passe os gates existentes.

## 2. Estado real verificado

### Backend e agendamentos

| Função | Versão | Estado | JWT verificado |
|---|---:|---|---|
| bootstrap-data | 6 | ACTIVE | sim |
| market-cycle | 10 | ACTIVE | sim |
| train-challenger | 5 | ACTIVE | sim |
| calendar-replay | 1 | ACTIVE | sim |

| Job | Agenda | Estado |
|---|---|---|
| signal-atlas-market-cycle | `* * * * *` | ativo |
| signal-atlas-train-challenger | `7 * * * *` | ativo |

O site não precisa permanecer aberto para esses ciclos cloud. O processamento local no navegador continua separado e complementar.

### Ledger e contrato de qualidade v4

- Decisões totais: **7978**.
- Decisões já emitidas sob o contrato v4: **3124**.
- Notas A/A+ no contrato v4: **970**.
- Qualidade `confirmed` no contrato v4: **0**.
- Eventos `bootstrap_champion`: **27**.
- Eventos reais `promote_champion`: **0**.

Ter A/A+ e continuar em avaliação baixa é comportamento intencional: a nota mede qualidade técnica comparativa; `confirmed` exige evidência prospectiva independente.

### Paper trading cloud legado (congelado para auditoria)

| Modo | Operações | EV líquido/op. | Benchmark/op. | Diferença | Drawdown máx. |
|---|---:|---:|---:|---:|---:|
| agressivo (legado) | 2615 | -0.1336 | -0.0950 | -0.0386 | 367.81 |
| conservador (legado) | 2615 | -0.1336 | -0.0950 | -0.0386 | 367.81 |
| neutro (legado) | 2615 | -0.1336 | -0.0950 | -0.0386 | 367.81 |

Desde a migration 027, novos ciclos usam somente a política única interna `neutro`, com custo adicional zero. A curva atual começa do zero e não mistura os resultados antigos: **0 operações resolvidas**, benchmark inicial **-0.0750** por operação. O ledger histórico dos três modos não foi apagado nem recalculado.

O estado de saúde do snapshot era `partial`, com **7845** sinais prospectivos resolvidos. `partial` descreve cobertura/execução incompleta do ciclo, não lucro nem falha estatística por si só.

## 3. Regra atual de nota e qualidade

1. A direção técnica permanece visível quando calculável; filtros rebaixam qualidade e explicam o motivo.
2. A nota usa oito verificações organizadas em cinco famílias com pesos e retorno decrescente para evidência correlacionada. Ela serve para **ordenação técnica**.
3. `technical` exige passar o gate da política econômica/estatística única.
4. `confirmed` exige, além do gate técnico, um evento real e anterior de `promote_champion` para o mesmo ativo, timeframe e artefato; amostra prospectiva pareada mínima; limite inferior de probabilidade; e EV conservador positivo.
5. O banco relê a fonte de verdade. Nenhum campo alegado pelo frontend ou pela Edge Function concede confirmação.
6. Histórico antigo não é reclassificado retroativamente.

## 4. Auditoria externa dos oito pontos da qualidade v4

Revisão externa recebida em 01/09/2026: **oito de oito pontos aprovados**. O registro completo está em `docs/AUDITORIA-CLAUDE-QUALIDADE-V4-2026-09-01.md`.

1. A promoção é limitada por ativo, timeframe, artefato e instante efetivo anterior à decisão.
2. `paired_samples` vem do shadow prospectivo pareado no mesmo evento, não da validação offline.
3. A seleção pública do champion não ressuscita artefato aposentado nem atribui decisão antiga ao champion atual.
4. Nenhum caminho transforma A/A+ em `confirmed`.
5. Na mesclagem do ranking, a fotografia canônica congelada vence campos transitórios da oportunidade.
6. Pesos são apresentados como ordenação técnica; nota e probabilidade permanecem separadas.
7. `register_market_decision` relê a qualidade calculada pela autoridade SQL.
8. A view pública é somente leitura e não expõe tabelas privadas.

O contrato automatizado `supabase/tests/confirmed_quality_contract.sql` também inspeciona a definição viva da função com `pg_get_functiondef` para impedir a volta de atalhos por nota ou `champion_usable`.

## 5. Causalidade e integridade

- A decisão é registrada antes da entrada e o resultado somente após a expiração.
- A resolução exige candles exatos; não interpola nem substitui pelo candle seguinte.
- Lacunas entram em fila deduplicada e backfill; após o limite, são abandonadas sem contaminar outcome, aprendizado ou EV.
- Backtest e replay usam cortes temporais, embargo e holdout fora da busca.
- O calendário econômico é arquivado de forma append-only e consultado `as-of`; revisões futuras não aparecem no passado.
- Ranking real, ranking de backtest, histórico local e histórico cloud permanecem separados.
- Empates continuam no denominador e seguem uma única política econômica versionada.

## 6. Timeframes, fontes e limites operacionais

O frontend suporta M1, M5, M15, M30, H1 e H4. O cloud opera M5, M15, M30 e H1. M30 foi adicionado sem inventar candles e começa sua própria amostra prospectiva do zero.

Fontes públicas incluem OKX, Binance/Coinbase/Kraken para cripto conforme disponibilidade e Yahoo Finance com proxies/fallbacks para Forex. Não existe SLA. Idade e latência do dado devem permanecer visíveis; volume de Forex é aproximação e não equivale a volume centralizado.

## 7. Segurança

- Edge Functions ativas mantêm `verify_jwt=true` e segredo interno separado.
- `anon`/`authenticated` não recebem acesso direto às tabelas privadas.
- Views públicas são projeções explícitas, somente leitura e `security_invoker`.
- Segredos reais não pertencem ao frontend, documentação, pacote de revisão ou repositório.
- RLS sem policy nas tabelas privadas é deny-by-default intencional; mudanças devem manter os contratos de segurança.

## 8. Migrations aplicadas e presentes no código (27)

1. `202608260001_cloud_validation.sql`
2. `202608260002_edge_contract.sql`
3. `202608260003_scheduling.sql`
4. `202608260004_service_role_read_contract.sql`
5. `202608260005_baseline_bootstrap.sql`
6. `202608270006_mode_metrics_and_ranking.sql`
7. `202608270007_foreign_key_indexes.sql`
8. `202608270008_public_mode_views.sql`
9. `202608270009_public_health_view.sql`
10. `202608270010_integrity_contract.sql`
11. `202608270011_security_release_hardening.sql`
12. `202608270012_deterministic_resolution_reviews.sql`
13. `202608270013_quality_curves_and_security_contract.sql`
14. `202608280014_independent_shadow_policies.sql`
15. `202608280015_policy_shadow_fk_index.sql`
16. `202608280016_missing_candle_gap_backfill.sql`
17. `202608280017_candle_gap_lifecycle.sql`
18. `202608280018_abandonment_gap_cleanup.sql`
19. `202608280019_canonical_tie_economics.sql`
20. `202608300020_add_m30_timeframe_enum.sql`
21. `202608300021_m30_runtime_and_calendar_archive.sql`
22. `202608300022_calendar_asof_uses_versioned_observation.sql`
23. `202608300023_calendar_replay_bridge.sql`
24. `202608310024_public_cloud_grade_history.sql`
25. `202608310025_public_cloud_decision_explanations.sql`
26. `202608310026_decouple_confirmed_quality.sql`
27. `202609010027_single_policy_zero_cost.sql`

## 9. Verificações automatizadas disponíveis

- `npm run test:edge` — `node --experimental-strip-types tools/run-edge-tests-node.mjs`
- `npm run test:causality` — `node tools/verify-local-causality.mjs`
- `npm run test:history` — `node tools/verify-history-settlement.mjs`
- `npm run test:history-policy` — `node tools/verify-history-policy.mjs`
- `npm run test:ranking` — `node tools/verify-ranking-snapshot.mjs`
- `npm run test:scanner` — `node tools/verify-scanner-queue.mjs`
- `npm run test:security` — `node tools/verify-security-release.mjs`
- `npm run test:backend-score` — `node tools/verify-backend-score-contract.mjs`
- `npm run test:backtest-replay` — `node tools/verify-backtest-replay.mjs`
- `npm run test:score-calibration` — `node tools/verify-score-calibration.mjs`
- `npm run test:technical-review` — `node tools/verify-technical-review.mjs`
- `npm run test:public-docs` — `node tools/check-public-docs.mjs`
- `npm run test:single-policy-frontend` — `node tools/verify-single-policy-frontend.mjs`

O teste `test:technical-review` falha se este documento divergir do gerador, se o snapshot declarar quantidade errada de migrations, se a migration 026 desaparecer ou se o texto voltar a ligar A/A+ a `confirmed`.

## 10. Pontos ainda abertos

- Não há evento real de promoção prospectiva no snapshot; portanto, zero confirmações é o resultado correto.
- Os três modos legados produziram decisões e EV praticamente idênticos; por isso foram aposentados para novas emissões. Permanecem apenas como auditoria histórica.
- A política única com custo zero começou uma curva prospectiva separada e ainda precisa acumular resultados antes de qualquer conclusão.
- O EV líquido seguia pior que o benchmark. Mais código não prova edge; somente dados prospectivos e validação fora da amostra podem fazê-lo.
- O arquivo de calendário precisa acumular meses antes de sustentar conclusões históricas fortes.
- Atualize o snapshot com consultas somente leitura antes de publicar uma nova afirmação numérica.

## 11. Arquivos prioritários para nova revisão

- `supabase/migrations/202608310026_decouple_confirmed_quality.sql`
- `supabase/migrations/202609010027_single_policy_zero_cost.sql`
- `supabase/tests/confirmed_quality_contract.sql`
- `supabase/tests/single_policy_contract.sql`
- `supabase/functions/market-cycle/index.ts`
- `supabase/functions/_shared/features.ts`
- `js/signal-ai.js`
- `js/score.js`
- `js/backtest.js`
- `tools/generate-technical-review.mjs`
- `docs/technical-review-runtime-snapshot.json`

## 12. Uso correto

Trate direção, força, nota, probabilidade e histórico como apoio a paper trading e pesquisa. Mesmo uma nota A+ pode perder. Nenhuma métrica isolada é recomendação financeira ou garantia de acerto.
