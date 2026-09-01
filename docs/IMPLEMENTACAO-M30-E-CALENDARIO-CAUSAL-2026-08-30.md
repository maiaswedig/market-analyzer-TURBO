# Implementação M30 e calendário econômico causal — 30/08/2026

## Resultado

O pipeline cloud agora reconhece `M5`, `M15`, `M30` e `H1`. M15 e H1 já existiam; M30 foi acrescentado prospectivamente, sem alterar registros antigos e sem atribuir desempenho histórico inexistente ao novo segmento.

O calendário econômico passou a ser arquivado a partir da implantação. A entrega usa a via segura: registra o que estava disponível e quando ficou disponível, mas não tenta prever direção, sentimento ou surpresa de manchete.

## Alterações aplicadas

- Migration `020`: adiciona `M30` ao enum em uma migration isolada, conforme a exigência do PostgreSQL para valores novos de enum.
- Migration `021`: registra 1.800 segundos para M30 e cria as tabelas privadas `economic_calendar_events`, `economic_calendar_observations` e `economic_calendar_fetches`.
- Migration `022`: garante que consultas históricas usem título/categoria da observação conhecida no instante consultado, e não uma classificação posterior.
- `TIMEFRAMES`, Binance, OKX e Yahoo agora têm intervalo M30 nativo no backend.
- O bootstrap padrão inclui M30. No Yahoo, o bootstrap M30 solicita um mês real de dados; não pede dois anos incompatíveis e não inventa candles.
- O `market-cycle` arquiva o snapshot antes de ele influenciar uma decisão Forex.
- Eventos de alto impacto são categorizados deterministicamente em juros, inflação, emprego, crescimento, banco central ou outros. A categoria possui versão explícita.
- Previsão, valor anterior e valor realizado ficam em observações append-only. Um valor realizado publicado depois não aparece em uma leitura `as of` anterior.
- Snapshots iguais não geram observações duplicadas. Falhas do provedor também ficam auditadas.
- As tabelas permanecem privadas, com RLS forçado, sem policy de leitura e sem privilégios diretos para `anon`, `authenticated` ou `service_role`. A gravação ocorre apenas pelo RPC de serviço.

## Validação executada

- 23/23 testes unitários Edge passaram, incluindo relógio M30, Yahoo M30, categorização e ausência de direção/sentimento inventado.
- 48/48 verificações locais adicionais passaram: causalidade, liquidação do histórico, política de histórico, ranking, fila do scanner, segurança e calibração.
- No Supabase de teste `market-analyzer-teste`, passaram os contratos SQL de causalidade, economia, recuperação de lacunas, segurança e calendário causal.
- O contrato do calendário confirmou idempotência, bloqueio de look-ahead para `actual` e bloqueio de reclassificação retroativa da categoria.
- Edge Functions publicadas no teste: `market-cycle` v5, `bootstrap-data` v5 e `train-challenger` v4, todas com `verify_jwt=true`.
- Produção não foi alterada.

## Situação operacional pendente

O projeto de teste já possui o secret protegido da Edge Function, mas o Vault do banco ainda não possui `signal_atlas_project_url`, `signal_atlas_cron_jwt` e `signal_atlas_cron_secret`. Por isso os jobs de minuto/hora continuam desativados e o arquivo real de notícias ainda não começou a acumular dados.

Para ativar sem reduzir a segurança, é necessário substituir o secret da Edge Function por um valor novo e registrar o mesmo valor no Vault, junto da URL do projeto e de um JWT público de cron. Depois disso, executar `signal_atlas.activate_schedules()` e rodar o bootstrap M30 uma vez.

## Limites que continuam valendo

- M30 começa sem estatística própria. Nenhum resultado de M5/M15/H1 é transferido para ele.
- Um modelo M30 só pode ganhar confiança após amostra prospectiva e os mesmos gates fora da amostra/shadow já exigidos pelo projeto.
- O arquivo de notícias começa na data de ativação; ele não cria calendário confiável para períodos anteriores.
- O filtro de notícia continua sendo proteção, não previsão direcional.
- A calibração ampliada deve esperar dados suficientes e usar pelo menos três janelas walk-forward. O holdout de 30/08 não deve ser reutilizado para escolher pesos.
- Com quatro timeframes, oito ativos contínuos podem gerar aproximadamente 3.648 candles fechados/dia. É necessário acompanhar o uso do banco no plano gratuito.
