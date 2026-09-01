# Market Analyzer — revisão M30 e notícias causais

## Escopo desta rodada

Revise as migrations `202608300020` a `202608300022`, os arquivos cloud alterados e o contrato `supabase/tests/calendar_archive_contract.sql`.

Perguntas principais:

1. O valor M30 é adicionado numa migration isolada e só usado após o commit?
2. Binance, OKX e Yahoo usam intervalos M30 reais, sem resampling ou candle sintético no cloud?
3. O Yahoo M30 evita solicitar uma retenção intraday incompatível?
4. O snapshot do calendário é arquivado antes de influenciar uma decisão?
5. `actual`, categoria e qualquer outra revisão posterior ficam invisíveis em consultas `as of` anteriores ao respectivo `fetched_at`?
6. Snapshots idênticos são idempotentes sem apagar a primeira data de disponibilidade?
7. As tabelas e funções internas continuam inacessíveis a `anon` e `authenticated`?
8. Existe algum caminho que trate categoria da notícia como direção prevista? O comportamento pretendido é não existir.

## Arquivos centrais

- `supabase/migrations/202608300020_add_m30_timeframe_enum.sql`
- `supabase/migrations/202608300021_m30_runtime_and_calendar_archive.sql`
- `supabase/migrations/202608300022_calendar_asof_uses_versioned_observation.sql`
- `supabase/functions/_shared/types.ts`
- `supabase/functions/_shared/providers.ts`
- `supabase/functions/_shared/market-guards.ts`
- `supabase/functions/market-cycle/index.ts`
- `supabase/functions/bootstrap-data/index.ts`
- `supabase/functions/train-challenger/index.ts`
- `supabase/functions/tests/time_test.ts`
- `supabase/functions/tests/provider_clock_test.ts`
- `supabase/functions/tests/market_guards_test.ts`
- `supabase/tests/calendar_archive_contract.sql`
- `supabase/tests/security_contract.sql`
- `docs/IMPLEMENTACAO-M30-E-CALENDARIO-CAUSAL-2026-08-30.md`

## Evidência já obtida

- Testes locais: 71/71 verificações passaram.
- Supabase de teste: contratos de causalidade, economia, lacunas, segurança e calendário passaram.
- Migrations 020–022 aplicadas somente em `market-analyzer-teste`.
- Edge Functions de teste ativas: `market-cycle` v5, `bootstrap-data` v5 e `train-challenger` v4, todas com JWT obrigatório.
- Produção não foi alterada.

## Limitação operacional conhecida

O cron do projeto de teste permanece desativado porque as três entradas do Vault ainda não foram configuradas. O secret equivalente da Edge Function existe, mas não foi copiado/revelado. Portanto, a lógica está publicada e validada, porém o arquivo real começará apenas depois da ativação segura do cron e do bootstrap inicial de M30.

Não trate M30 como validado. Ele começa sem histórico próprio e deve acumular evidência prospectiva sob os mesmos gates dos demais timeframes.
