# Signal Atlas — especificação completa para revisão externa

Este arquivo é a porta de entrada para revisar o projeto inteiro sem ZIP. Ele descreve o comportamento esperado, a arquitetura, as regras de integridade, o estado verificado, os arquivos e os pontos que ainda merecem análise. Leia também **README.md**, **docs/METODOLOGIA-CALIBRACAO.md**, **docs/GUIA-OPERACAO-E-RECUPERACAO.md** e **docs/STATUS-IMPLANTACAO.md**.

## 1. Objetivo e limite do produto

O Signal Atlas é uma ferramenta educacional de análise assistida para criptomoedas e Forex. Ele:

- coleta candles reais de fontes públicas;
- analisa a vela atual em formação junto de candles anteriores;
- projeta a direção da próxima vela ou uma expiração de até três velas em cenários de exaustão;
- mostra COMPRA, VENDA ou AGUARDAR, nota, força, confluência, probabilidade quando validada, expectativa líquida e motivos;
- acompanha sinais em paper trading e mede os resultados prospectivamente;
- treina modelos locais no navegador e modelos challenger na nuvem;
- não envia ordens, não acessa saldo e não promete lucro.

O critério principal é expectativa líquida depois de custos, acompanhada de Brier score, drawdown, calibração e tamanho da amostra. Taxa de acerto isolada não é tratada como prova de vantagem.

## 2. Regras de produto que não podem ser quebradas

1. Se existe direção técnica calculável, ela permanece visível. Filtros de pavio, volume, zona, notícia, sessão, latência, score ou EV rebaixam qualidade, nota e prioridade; não apagam COMPRA/VENDA da tela.
2. AGUARDAR é reservado para ausência real de direção, candle atual, dado válido, histórico mínimo ou modelo causal necessário para registrar uma previsão cloud.
3. Uma leitura com dado atrasado pode aparecer como baixa qualidade, mas não entra no histórico elegível nem no aprendizado.
4. A primeira previsão publicada para uma janela fica congelada. Reanálises posteriores não podem reescrever direção, preço, nota, prazo ou resultado.
5. Ranking prospectivo real e backtest hipotético permanecem separados. Backtest nunca bonifica a pontuação ao vivo.
6. Modelo não validado pode servir como baseline explicitamente fraca para iniciar medição futura, mas nunca recebe selo de modelo forte.
7. A vela atual pode participar da inferência. Apenas candles fechados podem virar rótulos de treino.
8. Toda decisão registrada deve ocorrer antes da entrada; todo outcome deve ser resolvido somente depois da expiração.
9. Custos, payout, política de empate, modelo e política usados numa previsão devem permanecer versionados junto do evento.
10. Nenhuma alteração pode ser escolhida olhando apenas o resultado final da mesma amostra usada para avaliá-la.

## 3. Arquitetura

### 3.1 Frontend estático

O frontend roda no navegador e pode ser hospedado gratuitamente no Netlify. O ponto de entrada é **index.html** e o controlador atual é **js/signal-ai.js**.

Responsabilidades:

- seleção de ativo, timeframe e modo;
- análise profunda e scanner;
- TradingView e gráfico próprio com candles, EMAs e zonas;
- próxima entrada e horário de expiração;
- histórico local, benchmark e exportação CSV;
- onboarding, tooltips, acessibilidade e layout móvel;
- leitura opcional das visões públicas do backend;
- persistência local via IndexedDB;
- processamento pesado em Web Workers.

### 3.2 Processamento local

O navegador usa dois workers em **js/market-worker.js**:

- lane interativa para análise selecionada;
- lane de fundo para scanner, treinamento e backtest.

O worker usa o mesmo pipeline causal de análise/backtest. A interface deve continuar responsiva durante treino e varredura.

O modelo local é uma regressão logística calibrada. Ele é salvo por ativo e timeframe no IndexedDB e só substitui o anterior quando passa a política atual de validação.

### 3.3 Backend cloud

O backend usa Supabase/PostgreSQL, Edge Functions, pg_cron e pg_net.

Edge Functions:

- **market-cycle**: coleta, inferência prospectiva, shadow, resolução e saúde;
- **train-challenger**: treino cronológico e revisão de challenger;
- **bootstrap-data**: preenchimento inicial de candles e baseline.

Agendamentos:

- coleta/mercado a cada minuto;
- treino challenger no minuto 7 de cada hora.

O backend continua operando com o site fechado depois da ativação explícita. As três Functions mantêm `verify_jwt=true` no `supabase/config.toml`, recusam JWT de sessão `authenticated` e exigem sempre um segredo independente de cron. O cron usa o JWT público `anon` documentado pelo Supabase; `service_role` não é colocado no Vault, e o token público sozinho recebe 403. A `011` pausa jobs legados; somente `signal_atlas.activate_schedules()` os recria depois que Functions e Vault estiverem prontos. A `010` congela o primeiro evento de cada slot causal e a `012` congela o corte temporal de resolução/revisão.

O frontend acessa apenas sete visões públicas `cloud_*`: as cinco projeções originais e duas curvas por qualidade adicionadas pela migration `013`. Elas permanecem `security_invoker` e chamam projeções sem parâmetros, `SECURITY DEFINER`, isoladas em `signal_atlas`, com `search_path=''` e colunas explícitas. `anon` e `authenticated` não recebem `SELECT` nas tabelas privadas. Credenciais administrativas ficam no Vault/ambiente privado.

## 4. Universo atual

O frontend local contém uma lista ampla de cripto e Forex e permite scanner de subconjuntos.

O backend cloud monitora inicialmente oito ativos em M5, M15 e H1:

- BTCUSDT, ETHUSDT, BNBUSDT e SOLUSDT;
- EURUSD=X, GBPUSD=X, USDJPY=X e AUDUSD=X.

Isso forma 24 segmentos de modelo. Todos possuem baseline. Baseline não significa validação forte.

Fontes do frontend:

- OKX como fonte principal de cripto, com Coinbase e Kraken como reservas compatíveis;
- Yahoo Finance por rotas públicas para Forex;
- TradingView somente como referência visual;
- Forex Factory e Trading Economics guest como calendário econômico público.

Fontes do backend:

- Binance pública para os quatro ativos cripto do cloud;
- Yahoo Finance para os quatro pares Forex.

Nenhuma fonte pública oferece SLA. Forex não possui volume centralizado; o sistema não deve inventar volume.

## 5. Fluxo causal de um sinal

1. O scanner coleta candles e identifica exatamente a vela atual do timeframe.
2. Candles são normalizados, deduplicados e persistidos com timestamps de origem e recebimento.
3. Features históricas usam somente dados existentes até cada instante.
4. A vela atual em formação é acrescentada ao snapshot de inferência, sem virar rótulo.
5. O motor calcula direção, score, confluência, modelo, EV e alertas.
6. A entrada teórica é a abertura da próxima vela. A expiração é o fechamento de E1, E2 ou E3.
7. O evento é gravado antes da entrada e fica append-only.
8. Se houver direção, candle atual e champion, até um resultado rebaixado vira low-signal prospectivo. Falta real desses elementos vira analysis_wait.
9. Depois da expiração, o resolver usa a abertura da vela de entrada e o fechamento exato da vela-alvo.
10. Paper trade, win/loss/tie, PnL e métricas são atualizados sem reescrever o sinal original.

## 6. Indicadores e filtros

O motor local combina:

- EMA 9, 21, 50, 100 e 200;
- RSI 14, inclinação e divergência;
- MACD 12/26/9 e cruzamento;
- Estocástico 14/3/3;
- ROC 9;
- ADX 14, +DI e −DI;
- ATR 14 e percentil de volatilidade;
- Bandas de Bollinger, percentual B e squeeze;
- volume relativo e ritmo de volume da vela atual;
- estrutura de mercado, pivôs, suporte e resistência;
- price action, anatomia de candle e padrões;
- gaps, compressão de EMAs e contexto multi-timeframe.

Filtros de qualidade:

- pavios contrários nas últimas três velas;
- suporte/resistência forte de M15/H1 em até 1 ATR;
- VSA com volume relativo mínimo, ajustado ao progresso da vela atual;
- notícia de alto impacto antes/depois da janela;
- transições de liquidez entre sessões;
- divergência de feed;
- idade, cache e latência do dado;
- expectativa líquida depois de custo;
- expiração flexível E1–E3 em exaustão coerente.

Esses itens precisam continuar explicáveis na interface. Falha técnica rebaixa o sinal; falha de dado pode torná-lo somente visível e não elegível.

## 7. Modos operacionais

Existem três modos:

- conservador: maior exigência e rebaixamento mais forte;
- neutro: equilíbrio recomendado;
- agressivo: tolera mais divergências, sem remover os avisos.

O modo não é uma promessa de risco menor ou lucro maior. Ranking, métricas públicas e paper summary são consultados separadamente pelo modo selecionado.

Observação para revisão: hoje os três modos podem apresentar resultados paper muito semelhantes porque todos registram também low-signals e a direção técnica básica costuma ser a mesma. Avaliar uma futura segmentação por qualidade sem apagar sinais e sem selecionar a regra depois de ver os resultados.

## 8. Qualidade, ranking e métricas

Níveis visuais:

- confirmado: passou segurança, tem estimativa elegível e EV conservador positivo;
- técnico: passou a política operacional, mas estatística ainda é fraca;
- avaliação baixa: existe direção, porém uma ou mais confirmações falharam;
- AGUARDAR: não existe direção/estado mínimo confiável.

O ranking local usa uma força média transparente:

- 55% score técnico;
- 25% nota do setup;
- 20% confluência.

A taxa estatística permanece separada da força para evitar chamar score de probabilidade.

O ranking cloud usa:

- 35% limite inferior da probabilidade;
- 25% score técnico;
- 25% taxa prospectiva com shrinkage Beta(25,25);
- 10% nota;
- 5% qualidade.

Somente resultados prospectivos entram nessa taxa. Backtest não é misturado.

Benchmark:

- taxa aleatória de referência: 50%;
- EV do benchmark usa o mesmo payout e custo;
- com payout 0,85 e custo 0,02, 50% ainda corresponde a EV −0,095 por unidade.

## 9. Treino e promoção

### 9.1 Modelo local

- dados em ordem temporal;
- holdout cronológico;
- mínimo de 300 observações de validação;
- margem de Brier baseada no erro-padrão pareado, não uma constante arbitrária;
- modelo anterior é preservado se o candidato falhar;
- treino e inferência rodam em worker;
- estado fica no IndexedDB e sobrevive ao fechamento do navegador;
- cada nova vela agenda atualização/análise e retreino controlado.

### 9.2 Modelo cloud

- treino usa apenas candles fechados;
- baseline inicia o ledger, mas pode permanecer low;
- challenger válido entra em shadow no mesmo snapshot futuro do champion;
- promoção exige no mínimo 300 outcomes pareados;
- limite inferior de 95% da melhora de EV acima de zero;
- Brier do challenger não pode piorar;
- drawdown do challenger deve ficar em até 1,20 vezes o champion;
- promotion review e deployment event são imutáveis.

## 10. Banco de dados

Schema privado principal: **signal_atlas**.

Tabelas:

- assets;
- candles;
- policy_versions;
- model_artifacts;
- promotion_reviews;
- model_deployment_events;
- decision_events;
- shadow_predictions;
- outcomes;
- paper_trades;
- paper_trade_events;
- correction_events;
- scanner_runs;
- scanner_health_events;
- analysis_waits;
- decision_slots.

Visões públicas de leitura:

- cloud_latest_decisions;
- cloud_opportunities;
- cloud_segment_metrics;
- cloud_paper_summary;
- cloud_system_health.

O acesso anônimo fica limitado às visões públicas. Tabelas de candles, pesos, políticas completas e revisões permanecem privadas. RLS sem policy em algumas tabelas privadas é intencional: deny-by-default.

Migrations exigidas:

1. 202608260001_cloud_validation.sql
2. 202608260002_edge_contract.sql
3. 202608260003_scheduling.sql
4. 202608260004_service_role_read_contract.sql
5. 202608260005_baseline_bootstrap.sql
6. 202608270006_mode_metrics_and_ranking.sql
7. 202608270007_foreign_key_indexes.sql
8. 202608270008_public_mode_views.sql
9. 202608270009_public_health_view.sql
10. 202608270010_integrity_contract.sql
11. 202608270011_security_release_hardening.sql
12. 202608270012_deterministic_resolution_reviews.sql
13. 202608270013_quality_curves_and_security_contract.sql

A `010` cria a unicidade global entre `AGUARDAR` e decisão, políticas reais imutáveis por modo, idempotência concorrente de artefatos e um RPC estreito que valida política, modelo, vela live, timestamp e latência. A `011` declara `pgcrypto`, `pg_net`, `pg_cron` e a dependência do Vault, remove grants públicos legados e instala cinco projeções sanitizadas. A `012` torna resolução e revisão determinísticas pelo `as_of`. A `013` acrescenta duas curvas públicas por qualidade sem alterar o ledger. `security_contract.sql` deve passar sob `anon` e `authenticated`, e `causality_contract.sql` deve passar antes da liberação.

## 11. Persistência local

O IndexedDB guarda:

- modelos;
- registro de modelos;
- histórico de sinais;
- ledger de feedback;
- metadados de retreino;
- calibrações e limiares por ativo, timeframe e expiração;
- configurações;
- snapshot recente do calendário.

LocalStorage é apenas espelho de compatibilidade para migração de versões antigas. Erro de persistência deve aparecer na interface.

## 12. Interface e acessibilidade

Itens implementados:

- lista de oportunidades posicionada perto da análise principal;
- um único fluxo para escolher oportunidade e abrir análise profunda;
- sinal com destaque visual, nota, força, motivos e qualidade;
- gráfico TradingView e gráfico próprio;
- horário exato da próxima entrada e expiração;
- indicador de progresso do scanner e última atualização;
- histórico por ativo/timeframe/expiração/qualidade;
- exportação CSV;
- comparação com benchmark;
- onboarding em quatro passos;
- tooltips de Confiança, Confluência, Modelo local, EMAs, suporte/resistência e backtest;
- captions e scope nos cabeçalhos das tabelas;
- tabelas em cards abaixo de 768 px;
- ausência de rolagem horizontal em 390 px;
- estados vazios distintos;
- disclaimer antes/junto do primeiro sinal.

## 13. Estado verificado em 27/08/2026

Snapshot final de infraestrutura:

- 8 ativos cloud;
- 24 champions/baselines, um por ativo e timeframe;
- 3 champions passaram os gates offline: BTCUSDT M5, USDJPY=X M5 e USDJPY=X M15;
- 1.594 execuções do scanner no corte da auditoria; a última estava `ok` e com zero erros;
- zero decisões não prospectivas encontradas;
- zero outcomes resolvidos antes da expiração;
- zero sinais registrados sem candle ao vivo;
- zero promoções champion sem a evidência futura exigida.
- zero artefatos duplicados por chave de treino;
- zero conflitos causais não corrigidos entre `AGUARDAR` e decisão;
- 2 jobs ativos e 3 Functions ativas com `verify_jwt=true`.

Testes locais:

- sintaxe aprovada nos 24 módulos JavaScript ativos; os 7 arquivos antigos estão isolados em `legacy/js/`;
- sintaxe aprovada em 18 arquivos TypeScript;
- 10 testes Edge, 5 verificações causais locais e 8 verificações de identidade do ranking aprovados;
- contratos SQL de segurança (`anon` e `authenticated`) e causalidade aprovados no banco vivo;
- chamada sem o segundo segredo recusada com HTTP 403;
- ciclo real da nova release respondeu HTTP 200 e registrou política/latência/linhagem completas;
- análise local carregou candles reais;
- nuvem conectou sem erro de console;
- layout de 390 × 844 não apresentou overflow;
- as três tabelas viraram cards no mobile;
- captions, scope, nomes de botões e IDs foram auditados.

Resultado paper mais recente do snapshot:

- 2.038 operações resolvidas por modo;
- EV líquido próximo de −0,1831 por operação;
- benchmark líquido −0,095;
- edge contra benchmark próximo de −0,0881.

Isso é uma evidência desfavorável, não um defeito a esconder. Nenhum modelo ou filtro deve ser promovido só para melhorar a aparência desses números.

## 14. Limitações e pontos de revisão

1. O frontend local e o backend cloud possuem conjuntos de features diferentes. As métricas são separadas de propósito, mas uma futura unificação do schema deve ser avaliada sem apagar o histórico anterior.
2. Proxies públicos Yahoo podem falhar, atrasar ou sofrer bloqueio CORS.
3. Volume de Forex é ausente ou apenas proxy; não tratar como volume centralizado.
4. O calendário econômico atual não oferece arquivo histórico confiável. O backtest declara o filtro histórico como indisponível em vez de aplicar notícias atuais ao passado.
5. Resolvido na migration `013`: o agregado original foi preservado e as novas visões `cloud_quality_segment_metrics` e `cloud_quality_paper_summary` expõem curvas separadas por `confirmed`, `technical` e `low`.
6. Modo local é específico do navegador/dispositivo; backend cloud é compartilhado.
7. Resolvido: os arquivos da interface anterior foram movidos para **legacy/js/**. `legacy/README.md` declara que são arquivo histórico não executável; o runtime ativo continua em `js/signal-ai.js`.
8. Não há integração automática com corretora. Qualquer integração futura deve começar em paper trading e exigir autorização separada.
9. O plano gratuito possui cotas de banco, Edge Functions, banda e provedores externos; monitorar crescimento.

## 15. Mapa dos arquivos ativos

Frontend:

- **index.html**: estrutura e acessibilidade;
- **styles.css**, **enhancements.css**, **ui-accessibility.css**: layout, acabamento e responsividade;
- **cloud-config.js**: URL e chave publicável do Supabase; nunca contém service_role;
- **js/signal-ai.js**: estado, UI, scanner, histórico e automação local;
- **js/market-worker.js**: processamento pesado;
- **js/analyze.js**: pipeline de análise;
- **js/data.js**: candles e provedores;
- **js/features.js**, **js/indicators.js**, **js/structure.js**, **js/patterns.js**, **js/priceaction.js**, **js/zones.js**: features e contexto técnico;
- **js/score.js**, **js/condition.js**, **js/decision.js**, **js/filters.js**, **js/news.js**: decisão explicável e qualidade;
- **js/probability.js**, **js/setups.js**, **js/ml.js**, **js/backtest.js**: estatística, treino e validação;
- **js/persistence.js**: IndexedDB;
- **js/cloud-api.js**: leitura cloud;
- **js/assets.js**, **js/util.js**: catálogo e utilidades.
- **legacy/js/**: interface antiga arquivada; não carregada, não testada e fora do runtime.

Backend:

- **supabase/functions/_shared**: relógio, features, logística, providers, guards, armazenamento e RPC;
- **supabase/functions/market-cycle**;
- **supabase/functions/train-challenger**;
- **supabase/functions/bootstrap-data**;
- **supabase/functions/tests**;
- **supabase/config.toml**: `verify_jwt=true` versionado nas três rotinas internas;
- **supabase/migrations**.
- **supabase/tests/security_contract.sql**: teste automático de todas as tabelas privadas sob `anon` e `authenticated`;
- **supabase/tests/causality_contract.sql**: relógios, candles exatos e resolução somente após expiração;
- **tools/verify-security-release.mjs** e **tools/run-edge-tests-node.mjs**: contratos estáticos e fallback offline dos testes puros.

Operação:

- **netlify.toml**: publicação estática e headers;
- **README.md**;
- **docs/GUIA-OPERACAO-E-RECUPERACAO.md**;
- **docs/METODOLOGIA-CALIBRACAO.md**;
- **docs/STATUS-IMPLANTACAO.md**.

## 16. Instruções para a revisão pelo Perplexity

Revisar o projeto como sistema causal de paper trading, não como gerador de promessas. Para cada problema encontrado:

1. citar o arquivo e a função;
2. explicar impacto em integridade, dados, estatística, UX ou segurança;
3. distinguir bug confirmado de melhoria opcional;
4. propor correção mínima;
5. dizer quais testes impedem regressão;
6. preservar eventos históricos e não recalcular métricas antigas com regras novas;
7. não usar resultados futuros para ajustar limiares avaliados na mesma amostra;
8. não transformar alertas de qualidade em sinais ocultos;
9. nunca mover service_role, JWT de cron ou segredos para o navegador;
10. priorizar EV prospectivo depois de custos, calibração e drawdown.

Perguntas recomendadas:

- Há algum caminho que permita decisão depois da entrada ou outcome antes da expiração?
- Existe vazamento de candle futuro nas features, no threshold sweep ou no treino?
- A separação entre ranking real, backtest, modelo local e cloud está completa?
- Os modos e níveis de qualidade precisam de métricas adicionais sem seleção retrospectiva?
- A política de promoção é estatisticamente suficiente e corretamente pareada?
- Alguma visão pública expõe dado privado ou permite escrita?
- O worker e o IndexedDB tratam falhas, concorrência e migrações corretamente?
- A interface continua mostrando direção baixa sem contaminar a taxa elegível?

## 17. Critério de aceite para qualquer correção futura

Uma correção só pode ser considerada pronta quando:

- preserva causalidade e append-only;
- possui teste proporcional ao risco;
- não introduz segredo no frontend;
- mantém mobile sem overflow;
- mantém direção de baixa qualidade visível;
- separa score, probabilidade e taxa histórica;
- mostra benchmark e custo;
- não promove modelo sem evidência fora da amostra;
- não apresenta lucro, acerto ou precisão que os dados prospectivos não sustentam.
