# Signal Atlas — funções Supabase Edge

Backend centralizado, dimensionado inicialmente para o plano gratuito, com coleta incremental, paper trading causal e disputa **champion/challenger**. Estas funções não enviam ordens a corretoras e não transformam taxa histórica em garantia de resultado.

Para cripto, Binance é a fonte preferencial e OKX é um fallback independente. Um HTTP 451, timeout, payload inválido ou lote vazio da Binance aciona a OKX; cada candle preserva em `source` o provedor que realmente o entregou. A troca nunca cria, interpola ou copia candle sintético. Forex continua usando Yahoo com redundância entre hosts do próprio provedor.

## Funções

- `market-cycle`: deve ser chamado a cada minuto. Coleta somente janelas relevantes de M5/M15/M30/H1, mantém a vela live separada, registra decisões idempotentes e grava um laboratório causal em que heurística, champion e challengers escolhem independentemente `BUY`, `SELL` ou `WAIT` na mesma oportunidade neutra. Antes de usar o calendário em Forex, arquiva o snapshot observado com `fetched_at`; depois da resolução normal, reclama no máximo seis lacunas com lease, reconsulta provedores com concorrência três e repete a resolução somente quando o banco confirma o candle exato.
- `bootstrap-data`: execução manual e limitada para preencher candles fechados. Nunca usa a vela live como amostra de treino.
- `train-challenger`: recomendado uma vez por hora. Escolhe um único escopo quando nenhum é informado, prepara exemplos E1 cronológicos, reserva pelo menos 300 observações recentes, aplica gate de Brier pareado `ganho > 1,5 × SE` e cria um artefato imutável.

Todas as funções aceitam somente `POST` interno. O arquivo versionado `supabase/config.toml` mantém `verify_jwt=true`; depois da validação criptográfica do gateway, o handler aceita somente o papel de worker `anon` (padrão público documentado para cron) ou `service_role` e exige simultaneamente `X-Signal-Atlas-Cron-Secret`. Um JWT de sessão de usuário (`authenticated`) é recusado. O JWT público `anon` sozinho também nunca autoriza coleta, bootstrap ou treino.

## Segredos obrigatórios

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEYS`: uma chave secreta, uma lista separada por vírgulas ou um JSON com `service_role`, `primary` ou `key`.
- `SIGNAL_ATLAS_CRON_SECRET`: segredo aleatório independente, com 32–512 caracteres, compartilhado somente entre os segredos das Edge Functions e a entrada Vault `signal_atlas_cron_secret`.

Nenhum segredo possui valor padrão e nenhuma chave deve ser enviada ao navegador.

O pg_cron também requer as entradas Vault `signal_atlas_project_url` e `signal_atlas_cron_jwt`. Use na última o token JWT público/anon recomendado pela documentação de agendamento; não mova `service_role` para o Vault. `verify_jwt=true` não aceita uma chave opaca `sb_publishable_...` no cabeçalho Bearer, então confirme que o token armazenado realmente possui três partes JWT e claim `anon`. Antes do encerramento das chaves JWT públicas legadas, migre o worker para o mecanismo oficial que as substituir e mantenha a segunda camada `SIGNAL_ATLAS_CRON_SECRET`.

## Contratos SQL necessários

O código falha de forma explícita quando um contrato não existe. As migrations devem fornecer:

### `ingest_candles`

Parâmetros: `p_symbol`, `p_timeframe`, `p_source`, `p_closed_candles`, `p_live_candle`, `p_run_id`, `p_received_at`.

Regras obrigatórias:

1. Candle fechado é inserido por chave única `(symbol,timeframe,open_time)`.
2. Conflito contra candle já fechado não pode atualizar OHLCV.
3. Vela live fica em tabela/estado separado e pode ser atualizada somente enquanto live.
4. A promoção live → fechado insere o snapshot final fechado e aposenta a linha live numa transação.
5. Repetir o mesmo lote/run deve ser idempotente.

### `register_market_decision`

Parâmetro: `p_decision jsonb`.

Deve congelar o primeiro evento para a chave causal global, inclusive quando for `wait`. A tabela `decision_slots` impede que um `AGUARDAR` e uma decisão coexistam como primeiros eventos do mesmo `ativo|timeframe|modo|vela`. `predictions` deve ser anexado a uma tabela imutável com unicidade `(decision_id,model_id)`. O RPC não pode substituir direção, nota, modelo, tempos ou feature vector após a emissão.

### `resolve_due_outcomes`

Parâmetros: `p_as_of`, `p_run_id`.

Deve resolver somente quando existirem candles **fechados com timestamp exato** para:

- preço de entrada: `open` do `entry_candle_open`;
- preço final: `close` do `target_candle_open`.

O resultado entra em tabela separada com `UNIQUE(signal_id)`. Nunca comparar contra o preço parcial da emissão e nunca escolher o candle “mais próximo”.

### `list_due_candle_gaps` e `reconcile_candle_gaps`

São RPCs exclusivos de `service_role`. A primeira descobre e reclama trabalho por `ativo|timeframe|tipo|horário` com lease; a segunda confere novamente no banco se o candle exato foi inserido. Tentativas usam backoff de 5, 10, 20 minutos até o teto de 360. Após oito tentativas ou 12 horas, a lacuna e as decisões afetadas recebem registros append-only de abandono. Não há interpolação, substituição pelo candle seguinte nem atualização do evento de decisão imutável.

### `create_model_artifact`

Parâmetro: `p_artifact jsonb`.

Deve inserir por `idempotency_key`. Pesos, normalização, janelas, métricas, gates e política são imutáveis; `UPDATE/DELETE` deve ser recusado até para rotinas administrativas comuns.

### `review_and_promote_challengers`

Parâmetros usados: `p_as_of`, `p_min_resolved`, `p_z_margin` e, opcionalmente, `p_symbol`, `p_timeframe`.

A promoção precisa ser transacional. Desde a comparação v2, a direção do challenger não é copiada da heurística: heurística, champion e challenger tomam ações independentes no mesmo `asset|timeframe|entry_at`, usando apenas o modo neutro como oportunidade canônica. `WAIT` vale zero por oportunidade. O challenger não pode ser promovido por backtest retrospectivo.

Quando ainda não existir champion, a migration `202608260005_baseline_bootstrap.sql` registra como baseline o primeiro artefato com pelo menos 300 observações de validação. Se ele não passou os gates offline, continua marcado como não usável. Depois disso, toda troca exige um challenger treinado para a política de decisão v2 e comparação v2 com no mínimo 500 oportunidades únicas, 20 dias distintos e 100 operações do challenger; o limite inferior de 95% do ΔEV precisa superar zero tanto contra o champion quanto contra a heurística. Artefatos v1 continuam consultáveis, mas não podem ser promovidos pelo guard novo.

## Tabelas/views esperadas

- `assets_watchlist`: `symbol`, `provider_symbol` opcional, `market`, `source` preferencial (`binance`/`yahoo`), `active`. Candles cripto podem registrar `source=okx` quando o fallback for usado.
- `candles`: histórico fechado consultável pelos campos usados em `_shared/storage.ts`.
- `model_artifacts`: `id`, `symbol`, `timeframe`, `status`, `artifact`, `created_at`.

Índices mínimos: candles por `(symbol,timeframe,is_closed,open_time desc)`, artefatos por `(symbol,timeframe,status,created_at desc)` e decisões por `idempotency_key`.

## Implantação e ativação segura do agendamento

A migration `202608270011_security_release_hardening.sql` pausa qualquer job legado e não o recria automaticamente. Em uma instalação já ativa, use esta ordem para evitar ciclos parcialmente implantados:

1. Gere um segredo aleatório de pelo menos 32 caracteres fora do repositório.
2. Salve o mesmo valor como segredo de Edge Function `SIGNAL_ATLAS_CRON_SECRET` e como entrada Vault `signal_atlas_cron_secret`.
3. Confirme no Vault `signal_atlas_project_url` e um JWT público válido com claim superior `anon` em `signal_atlas_cron_jwt`; não imprima os valores em logs ou consultas de diagnóstico e não armazene `service_role` no Vault.
4. Aplique primeiro a `011` para pausar os jobs antigos; aplique então as migrations ainda ausentes até a `019`. Em banco novo, aplique `001`–`019` na ordem numérica, pois a `003` não ativa jobs sozinha.
5. Implante `market-cycle`, `train-challenger` e `bootstrap-data` usando o `supabase/config.toml` versionado.
6. Como `postgres`, execute `select * from signal_atlas.activate_schedules();`.
7. Execute `supabase/tests/security_contract.sql`, `supabase/tests/causality_contract.sql` e `supabase/tests/gap_backfill_contract.sql`; teste que o JWT público sem o segundo segredo recebe 403 e confirme nos logs que chamadas do cron retornam sucesso. Para pausar com recuperação simples, use `select signal_atlas.deactivate_schedules();`.

Agendamentos ativados pela função:

- `market-cycle`: `* * * * *`
- `train-challenger`: `7 * * * *`
- `bootstrap-data`: somente manual

O `market-cycle` não recalcula todos os timeframes a cada minuto: `cyclePhase()` coleta logo após fechamentos e analisa apenas no trecho final da vela. O padrão é 8 ativos, o teto por chamada é 12 e a concorrência normal é 4. O reparo de lacunas fica separado, limitado a 6 itens e concorrência 3 para não transformar um provedor lento em sobreposição de crons. Para ampliar, primeiro meça CPU, duração, egress e tamanho do banco.

## Orçamento gratuito considerado

Em agosto de 2026, a documentação oficial do Supabase informa 500 MB de banco por projeto gratuito, 500.000 invocações de Edge Functions por mês, até 2 s de CPU e 150 s de duração por requisição. Um cron por minuto consome cerca de 43.200 invocações/mês; o treino horário adiciona cerca de 720. Links: [billing](https://supabase.com/docs/guides/platform/billing-on-supabase), [limites das Edge Functions](https://supabase.com/docs/guides/functions/limits) e [Cron](https://supabase.com/docs/guides/cron).

O banco é o limite mais provável. Oito ativos em M5/M15/M30/H1 geram aproximadamente 3.648 candles fechados por dia. **Esta entrega ainda não implementa retenção automática**, e os candles fechados são imutáveis pela política atual. Antes de se aproximar de 500 MB, crie uma migration de arquivamento auditável que preserve pelo menos a janela usada no treino e toda a linhagem exigida por sinais, outcomes, modelos e promoções. Também convém limitar challengers shadow ativos por escopo. Não apague o ledger de sinais para “melhorar” estatísticas.

## Integridade estatística

- Treino usa somente candles fechados.
- Feature em `t` recebe rótulo da próxima vela: abertura em `t+1` versus fechamento da mesma vela E1.
- Holdout é o bloco cronológico mais recente, com uma observação purgada na fronteira.
- Baseline usa somente a taxa do treino.
- O Brier é comparado de forma pareada e precisa superar `1,5 × erro-padrão`.
- Candidato offline aprovado inicia shadow; não substitui automaticamente o champion.
- Empates são estimados à parte e permanecem no cálculo de probabilidade/EV.
- Resoluções e revisões usam um `as_of` congelado; o worker pede promoção com o limite de 95% (`z=1,96`) e a revisão automática só considera outcomes que já existiam naquele corte.

## Verificação local

Com Deno instalado, a partir desta pasta:

```sh
deno task check
deno task test
```

Os testes puros verificam relógio E1, alinhamento de timeframes, invariância das features diante de candles futuros e o gate estatístico do challenger.

Sem Deno, o fallback offline para os mesmos testes puros é:

```sh
node --experimental-strip-types --experimental-transform-types tools/run-edge-tests-node.mjs
```

O import npm está fixado em versão exata. Este ambiente offline não possuía o executável/cache do Deno, portanto não foi seguro inventar um `deno.lock`. Antes do próximo deploy de dependências, rode `deno install --frozen=false` nesta pasta, revise e versione o `deno.lock`; depois configure `"lock":{"path":"./deno.lock","frozen":true}` no `deno.json` e use `deno ci` no pipeline. Nunca publique um lockfile manual ou sem hashes verificados.
