# Status verificado da implantação

## Atualização de 30/08/2026 — projeto de teste

As migrations `020`–`023` foram acrescentadas ao pacote. M30, arquivo
prospectivo do calendário e replay causal foram validados no projeto Supabase
de teste; produção não foi alterada.

- `calendar-replay` v1 está ativa no teste com `verify_jwt=true`.
- O contrato SQL do calendário e o contrato de segurança passaram no
  PostgreSQL real do teste.
- Um smoke test autenticado retornou HTTP 200 com cobertura completa.
- O backtest só usa calendário histórico quando todas as decisões possuem uma
  fotografia exata; cobertura parcial é descartada integralmente.
- O arquivo começa prospectivamente na migration `023`; datas anteriores não
  são reconstruídas.
- A bateria local desta versão totalizou 101 verificações aprovadas.
- O frontend v16 foi publicado na Netlify em 31/08/2026 pelo deploy
  `6a94bb1fb54da3350baa8e7e`.
- O endereço oficial carregou Market Analyzer, M30, scanner progressivo e
  “Nuvem conectada”, sem erros ou avisos no console durante o aceite.

Registro de aceite técnico do backend cloud e da integração do frontend do Signal Atlas. Este documento descreve o snapshot verificado em **28/08/2026**; ele não substitui monitoramento contínuo porque candles, métricas e disponibilidade dos provedores mudam com o tempo.

## Resumo executivo

| Área | Estado verificado | Interpretação correta |
| --- | --- | --- |
| Coleta 24/7 | Saudável na janela auditada | O cron continuava processando com a página fechada. Provedores externos continuam sem SLA. |
| Escopos de modelo | 24/24 com baseline | Há um baseline para cada combinação de 8 ativos × M5/M15/H1; baseline não significa modelo forte. |
| Validação forte | Parcial | Somente modelos que passam os gates cronológicos e de Brier podem receber tratamento forte. Os demais permanecem visíveis como baixa qualidade. |
| Integridade causal | Aprovada na amostra auditada | Não foram encontrados vazamento futuro, resolução antecipada ou sinal novo sem vela live. |
| Política única e qualidade | Ativa | A curva vigente considera somente a política única; confirmado, técnico e baixo continuam separados. Os três modos anteriores permanecem como legado auditável. |
| Benchmark | Ativo | A taxa do modelo aparece com referência aleatória de 50% e EV calculado sob o mesmo payout e custo adicional zero. |
| Resultado paper atual | Negativo no snapshot | A evidência disponível ainda não sustenta expectativa positiva nem promessa de lucro. |
| Hardening de release | Implantado e testado | Migrations `010`–`015`, projeções sanitizadas e contratos sob `anon` e `authenticated` estão ativos. |
| Laboratório independente v2 | Coletando prospectivamente | Heurística, champion e challenger podem escolher compra, venda ou aguardar na mesma oportunidade neutra; o histórico v1 não é reaproveitado como evidência v2. |
| Recuperação de lacunas `016/017` | Implantada e em processamento | Fila privada com lease, backoff, abandono append-only e cancelamento de trabalho órfão; `market-cycle` v11 processou o primeiro lote real sem erro. |
| Complementos `018/019` | Validados no projeto de teste | Limpeza da lacuna irmã e EV canônico foram preservados na cadeia aplicada antes das migrations `020`–`023`; produção continua fora do escopo desta atualização. |

## O que foi implantado

- Ledger prospectivo e imutável para decisões, previsões, outcomes, políticas e promoções.
- Coleta agendada a cada minuto e treino challenger no minuto 7 de cada hora.
- 24 baselines iniciais, cobrindo `BTCUSDT`, `ETHUSDT`, `BNBUSDT`, `SOLUSDT`, `EURUSD=X`, `GBPUSD=X`, `USDJPY=X` e `AUDUSD=X` em M5, M15 e H1.
- Champion/challenger com holdout cronológico, purga na fronteira, mínimo de validação e promoção somente após evidência futura pareada.
- Métricas prospectivas, ranking auditável, benchmark de 50% e paper trading separados por modo operacional.
- Curvas prospectivas separadas por qualidade de emissão, sem alterar ou apagar o histórico existente.
- Frontend somente leitura sobre visões públicas; tabelas privadas, pesos completos e credenciais de serviço permanecem fora do navegador.

As migrations aplicáveis à versão atual são:

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

As migrations `006`–`009` introduzem separação por modo, ranking prospectivo, índices e visões públicas. A `010` instala `decision_slots`, corrige de forma append-only conflitos históricos, versiona as políticas reais do worker e torna artefatos idempotentes. A `011` remove grants legados e instala cinco projeções sanitizadas. A `012` resolve e revisa modelos usando um corte temporal determinístico. A `013` acrescenta duas visões somente de leitura para métricas por qualidade, totalizando sete endpoints públicos controlados. A `014` cria o ledger privado v2, a decisão independente por EV líquido e a promoção que precisa superar champion e heurística. A `015` adiciona o índice da chave estrangeira indicado pelo advisor de desempenho. A `016` cria a recuperação dirigida de candles ausentes sem modificar decisões imutáveis. A `017` encerra resíduos da fila quando todas as decisões relacionadas já receberam outcome, correção ou abandono. A `018` cancela imediatamente lacunas irmãs sem decisão elegível. A `019` aplica o EV canônico aos novos registros. A `020` adiciona M30 ao tipo cloud. A `021` ativa M30 e o arquivo prospectivo do calendário. A `022` ancora `as-of` na observação versionada. A `023` registra fotografias completas por coleta e disponibiliza replay causal limitado por uma Edge Function protegida.

## Checklist de segurança antes de reativar o cron

- `supabase/config.toml` mantém `verify_jwt=true` nas quatro Functions.
- O código recusa JWT de sessão `authenticated`; aceita somente o JWT de cron `anon` documentado (ou `service_role` por compatibilidade) e sempre exige o segredo independente. O token público sozinho recebe 403.
- `SIGNAL_ATLAS_CRON_SECRET` existe nas Edge Functions e o mesmo valor está no Vault como `signal_atlas_cron_secret`; ele é independente do JWT e nunca aparece no repositório.
- `signal_atlas_project_url` e o JWT público `signal_atlas_cron_jwt` existem no Vault; a ativação valida formato e claim `anon` sem imprimir valores. `service_role` não precisa e não deve ser copiado para o Vault.
- As Functions agendadas foram implantadas antes de `signal_atlas.activate_schedules()`; `calendar-replay` é somente leitura e não depende de cron próprio.
- `supabase/tests/security_contract.sql` passa sob `anon` e `authenticated`: as sete `cloud_*` abrem e toda tabela privada é descoberta e testada contra leitura e mutação.
- `supabase/tests/causality_contract.sql` rejeita decisões tardias, shadows após a entrada, candles de outcome divergentes e resolução antecipada.
- Logs confirmam sucesso do job por minuto depois da ativação; o job horário permanece ativo e será observado naturalmente no minuto 7.
- Em 28/08/2026, `market-cycle` v10 e `train-challenger` v7 ficaram ativos com `verify_jwt=true`; os contratos SQL de causalidade e segurança passaram no banco publicado.
- Depois do backfill dirigido, `market-cycle` v11 permaneceu ativo com `verify_jwt=true`; 24 lacunas foram recuperadas, 26 itens auxiliares foram cancelados e o contador de decisões vencidas sem outcome/estado terminal chegou a zero, sem abandono e sem erro no ciclo observado.
- O primeiro treino horário posterior à release criou um artefato `decisionPolicyVersion=2` para `ETHUSDT|M15`; ele falhou nos gates offline (`usable=false`) e, corretamente, não foi promovido nem recebeu poder sobre o sinal ao vivo.

## Evidências de integridade

Na auditoria do snapshot não foram encontrados:

- decisões marcadas como prospectivas depois do instante de entrada;
- outcomes resolvidos antes do fechamento exato da expiração;
- sinais novos registrados sem uma vela atual/live disponível;
- sinais Yahoo novos cuja idade do dado ultrapassasse 1,5× o timeframe;
- mistura de resultados retrospectivos de backtest com o ranking real prospectivo.

Também foram verificados zero artefatos duplicados por chave de treino, zero decisões conflitantes não invalidadas depois de um `AGUARDAR` já congelado e zero grants anônimos nas tabelas privadas. O backfill preservou o primeiro evento de 7.251 slots existentes e anexou 81 correções de invalidação quando uma decisão histórica havia surgido depois de um `AGUARDAR`; nenhum registro foi apagado.

O treino usa somente candles fechados e as features de cada observação são calculadas sem acessar candles futuros. A vela em formação pode orientar a inferência atual, mas nunca vira rótulo antes de fechar.

## Qualidade dos modelos e sinais

Os 24 baselines existem para que todos os escopos possam começar a acumular resultados futuros. Eles não receberam força artificial só por estarem ativos. No snapshot, apenas uma parte dos modelos havia passado os gates offline estritos; os demais foram mantidos como **baixa qualidade**.

O comportamento esperado é:

- se existe direção calculável, o sinal continua visível e filtros desfavoráveis reduzem nota, força e confiança;
- **AGUARDAR** é usado quando não há direção real, vela atual, dado válido ou estado mínimo para calcular o sinal;
- um modelo não validado nunca é apresentado como forte;
- backtest hipotético serve apenas de referência e não bonifica o ranking ao vivo.

## Métricas e paper trading

Desde a migration `027`, novas decisões usam uma política operacional única. Confirmado, técnico e baixo permanecem separados. Os três modos anteriores continuam preservados como legado, mas não entram na curva pública vigente; isso evita contar o mesmo instante mais de uma vez e criar uma banca artificialmente inflada.

O benchmark de taxa de acerto é **50%**, mas a comparação principal é de **EV**. O benchmark recebe o mesmo payout, stake e custo adicional zero da política vigente. Com payout de 0,85, 50% de acerto ainda produz EV negativo; portanto, superar 50% isoladamente não prova vantagem econômica.

Na verificação inicial de 27/08/2026, cada modo possuía 2.038 operações resolvidas, EV líquido aproximado de `−0,1831` por operação, benchmark `−0,095` e edge `−0,0881`. Após a migration `013`, o corte de aceite mostrou que praticamente toda a amostra pertencia à classe `low`; `confirmed` estava vazia e `technical` tinha somente uma observação em um único modo. Isso explica a convergência sem inventar diferença entre os modos. Consulte o diagnóstico datado; nunca ajuste a apresentação para sugerir lucro inexistente.

## Evidência final da release

- Edge Functions ativas no corte final: `market-cycle` v11, `train-challenger` v7 e `bootstrap-data` v6, todas com `verify_jwt=true`.
- Dois cron jobs ativos: ciclo por minuto e treino no minuto 7 de cada hora.
- 1.594 execuções do scanner registradas no corte da auditoria; a última estava `ok`, com zero erros.
- 24 champions/baselines ativos; 3 haviam passado os gates offline.
- 6.195 outcomes prospectivos e 42 oportunidades públicas no corte.
- Um ciclo forçado de aceite percorreu 8 ativos × M5/M15/H1: 66 sinais direcionais foram preservados como baixa qualidade e 6 casos ficaram em `AGUARDAR` porque não existia direção técnica calculável.
- Chamada com JWT público e sem o segredo independente retornou HTTP 403; chamada do worker completo retornou HTTP 200.
- `supabase/tests/security_contract.sql` passou como `anon` e `authenticated`; `causality_contract.sql` passou no ledger vivo.
- 24 módulos JavaScript ativos; 14 testes Edge, 5 verificações causais locais, 8 verificações do ranking, 3 verificações da fila e os contratos SQL de backfill passaram.
- O teste estático de segurança e a varredura por valores de credenciais passaram sem achados.
- O advisor de segurança reportou apenas `INFO` para RLS sem policy nas tabelas privadas. Esse estado é intencionalmente deny-by-default; não houve achado `WARN` ou `ERROR`.

## Critérios antes de considerar um modelo forte

Um modelo deve, no mínimo:

1. passar a validação cronológica offline com amostra suficiente e melhora de Brier acima da margem baseada em erro-padrão;
2. competir em shadow independente contra champion e heurística na mesma oportunidade neutra;
3. acumular 500 oportunidades futuras únicas, 20 dias distintos e ao menos 100 operações próprias;
4. apresentar limite inferior de 95% da melhora de EV acima de zero contra ambos;
5. não piorar Brier, manter cobertura mínima e drawdown controlado;
6. usar custos e política de payout versionados na comparação.

Até esses critérios serem satisfeitos, o sistema pode continuar mostrando a direção técnica, mas deve rotulá-la como baixa qualidade ou amostra insuficiente.

## Monitoramento contínuo recomendado

- Conferir se a coleta avança mesmo com o site fechado.
- Revisar logs dos dois crons e das quatro Edge Functions.
- Acompanhar a idade do último candle por ativo/timeframe e falhas de provedor.
- Comparar EV líquido, Brier, drawdown e tamanho da amostra por modo; não usar somente taxa de acerto.
- Monitorar crescimento do banco e cotas do plano gratuito.
- Manter segredos exclusivamente no ambiente privado/Vault. Este documento e o frontend não contêm valores de chaves.

## Conclusão

A infraestrutura de validação contínua, a autenticação dos workers e os dois agendamentos estão operacionais. A integridade causal foi confirmada no banco e em um ciclo real da release. O sistema já mede modelos e sinais de forma honesta, mas os resultados paper atuais ainda não demonstram vantagem líquida. Portanto, esta implantação é adequada para **paper trading, estudo e acumulação de evidência**, não para promessa de lucro nem execução automática em corretora.
