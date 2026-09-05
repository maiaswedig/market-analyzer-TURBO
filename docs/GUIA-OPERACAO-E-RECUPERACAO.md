# Guia de operação, publicação e recuperação

Este guia separa três coisas que podem parecer iguais na tela, mas têm responsabilidades diferentes:

1. **Site estático na Vercel:** mantém o link principal acessível; a configuração Netlify é apenas uma alternativa de recuperação.
2. **Motor local:** analisa, treina e guarda dados no navegador enquanto a página está aberta.
3. **Monitoramento Supabase:** coleta e mede sinais prospectivos com a página fechada, desde que funções e agendamentos estejam saudáveis.

O link continuar online não prova que o scanner cloud está funcionando. Confirme sempre o horário da última coleta no painel.

## 1. Publicação do frontend

1. Mantenha `index.html`, os arquivos CSS, `js/`, `favicon.svg`, `vercel.json` e a configuração pública cloud na mesma estrutura.
2. O projeto Vercel `market-analyzer-ia` acompanha a branch `main` do repositório `maiaswedig/market-analyzer-TURBO`; um push nessa branch inicia o deploy estático da raiz, sem comando de build.
3. Aguarde o deploy de produção terminar e abra `https://market-analyzer-ia.vercel.app/` em uma janela anônima para confirmar que os módulos, fontes e gráficos carregam sem depender do seu computador.
4. Em uma publicação somente local, deixe a configuração cloud vazia. A interface exibirá **Modo local** e continuará funcionando.
5. Para conectar a nuvem, use a estrutura de `cloud-config.example.js` e informe somente a URL do projeto e a chave pública/publicável. Chaves administrativas, service role, JWT de agendamento e credenciais de banco nunca pertencem ao frontend.

Um deploy da Vercel é uma fotografia do commit. Mudanças locais só chegam ao link depois de commit, push e conclusão do novo deploy de produção.

## 2. Ativação do backend Supabase

Use um projeto Supabase separado para produção e siga esta ordem:

1. Gere fora do repositório um segredo aleatório independente com pelo menos 32 caracteres.
2. Configure-o no ambiente das Edge Functions como `SIGNAL_ATLAS_CRON_SECRET` e salve o mesmo valor no Vault como `signal_atlas_cron_secret`. Não imprima nem copie o valor para arquivos publicados.
3. Confirme no Vault `signal_atlas_project_url` e `signal_atlas_cron_jwt`; use o JWT público com claim superior `anon`, conforme o padrão oficial de agendamento, e não coloque `service_role` no Vault. O segredo de cron não pode ser igual ao JWT.
4. Em banco novo, aplique todas as migrations `001`–`032` na ordem numérica. Em projeto antigo já agendado, aplique primeiro a `011` para pausar os jobs, depois as migrations ainda ausentes, e só reative após o deploy das Functions.
5. Implante `bootstrap-data`, `market-cycle`, `train-challenger` e `calendar-replay`; o `supabase/config.toml` versionado mantém a autenticação exigida para cada função.
6. Execute `bootstrap-data` manualmente em lotes controlados, enviando um Bearer JWT aceito pelo gateway (`anon` é suficiente) e `X-Signal-Atlas-Cron-Secret`. Ele importa somente candles fechados e é idempotente; o JWT público sem o segundo segredo deve receber 403.
7. Execute `supabase/tests/security_contract.sql`, `supabase/tests/causality_contract.sql`, `supabase/tests/gap_backfill_contract.sql` e `supabase/tests/economic_contract.sql`. As sete `cloud_*` devem abrir sob `anon` e `authenticated`; todas as tabelas privadas e APIs legadas devem ser negadas.
8. Como `postgres`, execute `select * from signal_atlas.activate_schedules();` e confirme que `signal-atlas-market-cycle` roda a cada minuto e `signal-atlas-train-challenger` no minuto 7 de cada hora.
9. Só então conecte o frontend às visões públicas cloud.

Ativos iniciais: `BTCUSDT`, `ETHUSDT`, `BNBUSDT`, `SOLUSDT`, `EURUSD=X`, `GBPUSD=X`, `USDJPY=X` e `AUDUSD=X`, em M5, M15, M30 e H1. Cripto usa Binance com fallback real; Forex usa Yahoo Finance.

As migrations `006` a `019` completam métricas, causalidade, segurança, backfill de lacunas e economia canônica. `020` adiciona M30; `021`–`023` arquivam e reproduzem calendário econômico sem conhecimento futuro; `024`–`027` consolidam a nota técnica, a confirmação estatística e a política operacional única. `028` corrige a reconciliação concorrente de lacunas. `029`–`030` criam o laboratório prospectivo de estratégias sem alterar o motor em produção. `031` persiste o regime causal e publica diagnósticos de baseline e nota com Wilson. `032` compara estratégias seletivas contra um benchmark aleatório com a mesma cobertura. Não pule nenhuma delas ao reconstruir o backend.

## 3. Teste de aceite após publicar

### Frontend local

- O site abre por HTTPS e não exige o computador original ligado.
- Selecionar ativo, rolar e trocar timeframe continua responsivo durante scanner/treino.
- O indicador do scanner mostra ativo atual, posição da fila e última atualização.
- Ao fechar e reabrir o mesmo navegador, histórico e modelo local continuam disponíveis.
- Em largura de 390 px, oportunidades e histórico aparecem como cartões, sem rolagem horizontal.
- O CSV operacional abre somente com A/A+ e inclui ativo, timeframe, expiração, sinal, classificação, qualidade, resultado e métricas visíveis; o ledger interno continua contendo todos os níveis.

### Monitoramento cloud

- O selo muda para **Nuvem conectada** e exibe horário recente de coleta.
- `cloud_system_health` informa a última execução; `cloud_latest_decisions` e `cloud_opportunities` respondem apenas para leitura.
- Uma decisão repetida no mesmo ativo, timeframe, vela e modo não cria duplicata.
- Nenhum resultado é resolvido antes da expiração ou sem o candle exato de entrada/saída fechado.
- O paper EV e drawdown da nuvem não aparecem somados ao histórico local.
- Confirmado, técnico e baixo aparecem em curvas separadas; classe sem amostra mostra “Sem amostra”, nunca 0%.
- A política operacional é única. Os modos antigos continuam disponíveis apenas no ledger histórico, sem serem misturados à curva vigente.
- A taxa de acerto aparece junto do benchmark aleatório de 50% e do EV desse benchmark sob o mesmo payout e custo adicional zero da política vigente.
- Com a página fechada por alguns minutos, a última coleta continua avançando. Se não avançar, o problema está no backend/agendamento, não na Vercel.

### Estado verificado em 27/08/2026

- Os dois agendamentos estavam executando e o ciclo de mercado seguia atualizando decisões sem erro recente na janela verificada.
- Os 24 escopos iniciais (8 ativos × M5/M15/H1) possuíam baseline ativo. Isso garante continuidade da medição, não força estatística: somente os modelos aprovados pelos gates offline são classificados como fortes; os demais permanecem como baixa qualidade enquanto acumulam evidência prospectiva.
- A auditoria causal não encontrou decisão não prospectiva, resultado antecipado, sinal novo sem vela live nem sinal Yahoo acima do limite de idade na amostra verificada.
- O paper EV líquido estava negativo nos três modos no snapshot. Esse resultado deve permanecer visível: não se promovem modelos nem se aumenta a nota para esconder desempenho desfavorável.

Os números mudam com novos candles. Consulte [STATUS-IMPLANTACAO.md](STATUS-IMPLANTACAO.md) para o registro consolidado e use as visões de saúde para confirmar o estado atual, em vez de assumir que um snapshot histórico continua válido.

## 4. Rotina operacional

### A cada uso

- Confira o selo cloud e o horário da última coleta.
- Compare a idade do dado com o timeframe. Um dado antigo não deve ser tratado como oportunidade atual, mesmo que a linha ainda esteja visível em cache.
- Confirme preço, payout, spread, slippage e horário diretamente na corretora antes de qualquer decisão.
- Leia os motivos de baixa qualidade. Eles são informação de risco, não uma autorização automática para operar. Uma direção tecnicamente calculável continua visível mesmo quando falha em filtros; **AGUARDAR** fica reservado para ausência real de direção, dado atual ou estado mínimo necessário.

### Uma vez por semana

- Veja logs das três Edge Functions e execuções recentes dos dois crons.
- Procure falhas repetidas por provedor, tempo excedido, ausência de vela live ou calendário indisponível.
- Confira crescimento do banco, quantidade de candles por ativo/timeframe e idade da última coleta.
- Exporte o histórico local visível em CSV para auditoria.
- Registre alterações de política, payout e custo; comparar períodos com regras diferentes sem segmentação produz métricas enganosas.

### Uma vez por mês

- Exporte ou faça backup do banco pelos meios disponíveis no plano usado.
- Guarde uma cópia versionada desta pasta e das migrations.
- Revise consumo de banco, invocações, duração/CPU das funções e tráfego da hospedagem.
- Verifique se challengers estão acumulando previsões shadow e se promoções, quando existirem, possuem pelo menos 300 pares futuros.

## 5. O que “aprender sozinho” significa

### No navegador

- A vela atual pode participar da inferência, nunca do rótulo de treino enquanto estiver aberta.
- Após o fechamento, o resultado fica elegível para histórico e um novo treino posterior.
- Treino, inferência pesada e backtest rodam em Worker.
- O modelo fica no IndexedDB daquele perfil. Outro computador começa com outro modelo e outro histórico local.
- Um candidato só substitui o modelo local aceito se passar a validação cronológica configurada; uma taxa de acerto maior no mesmo trecho usado para treinar não é suficiente.

### Na nuvem

- O ciclo por minuto coleta apenas janelas necessárias, mantém a vela live separada e registra a decisão antes da entrada.
- O treino horário escolhe um escopo por vez e usa apenas candles fechados. Com 8 ativos e 4 timeframes, uma rotação completa leva aproximadamente 32 horas.
- O rótulo atual é E1: abertura da próxima vela contra o fechamento dessa mesma vela.
- Existe um baseline por cada um dos 32 escopos iniciais. O modelo precisa passar validação cronológica e três janelas walk-forward; falhar em qualquer janela impede que seja considerado utilizável.
- Um challenger aprovado offline só observa em shadow. A promoção exige pelo menos 500 resultados futuros pareados e 20 dias, melhora de EV com limite inferior de 95% positivo, Brier não pior e drawdown controlado.
- Decisões, previsões, outcomes e promoções são registros imutáveis. Uma correção adiciona um evento separado; não apaga o passado.
- A política cloud vigente simula stake unitário, payout de 0,85, custo adicional zero e empate como perda. As políticas antigas com custo de 0,02 permanecem preservadas no ledger e não são reescritas.
- Métricas, oportunidades e curva paper vigentes usam somente a política única. A referência aleatória de 50% usa o mesmo payout e custo adicional zero, permitindo comparar também o EV — não apenas a porcentagem de acerto.

O sistema melhora somente quando os dados sustentam a mudança. Ele também pode permanecer igual ou emitir **AGUARDAR/avaliação baixa** por longos períodos.

## 6. Limites do plano gratuito

Estimativa da configuração padrão, sem chamadas manuais ou repetições:

| Consumo | Estimativa |
| --- | ---: |
| Ciclo a cada minuto | ~43.200 invocações/mês |
| Treino uma vez por hora | ~720 invocações/mês |
| Candles máximos por dia, 8 ativos × M5/M15/M30/H1 | ~3.648 |

Em agosto de 2026, a documentação do Supabase informava 500 MB de banco no plano gratuito, 500.000 invocações de Edge Functions por mês, até 2 segundos de CPU e 150 segundos de duração por requisição. Verifique a documentação atual antes de dimensionar: cotas podem mudar sem alteração neste repositório. Referências oficiais: [faturamento e cotas](https://supabase.com/docs/guides/platform/billing-on-supabase), [limites das Edge Functions](https://supabase.com/docs/guides/functions/limits) e [Cron](https://supabase.com/docs/guides/cron).

Pontos de atenção:

- O armazenamento tende a ser o primeiro limite, porque não há rotina automática de retenção nesta versão.
- Candles fechados são imutáveis no ledger atual. Não tente “limpar” o banco manualmente; uma futura retenção precisa arquivar dados de forma auditável e preservar decisões, outcomes e linhagem.
- Treinos com 3.500 candles podem exceder CPU em momentos de carga. A função limita um escopo por hora justamente para reduzir esse risco.
- Yahoo Finance e Binance podem limitar ou alterar o serviço. O plano gratuito não oferece garantia 24/7 de terceiros.
- A Vercel serve o frontend estático; seu limite de banda/deploy é independente do Supabase.

## 7. Recuperação

### Site indisponível, backend saudável

1. Abra o histórico de deploys da Vercel e promova o último deploy conhecido como estável. Se a Vercel estiver indisponível, o `netlify.toml` preservado permite publicar a mesma raiz como espelho temporário.
2. Abra o site em janela anônima.
3. Confirme o selo cloud e a última coleta. Reverter o frontend não altera o ledger do Supabase.

### Backend indisponível, site saudável

1. A interface continuará em modo local ou mostrará o último cache cloud com horário antigo.
2. Verifique primeiro cron, logs das Edge Functions, limites do projeto e disponibilidade dos provedores.
3. Não recalcule nem edite resultados antigos para preencher lacunas. Retome a coleta e deixe a ausência de dados registrada.
4. Depois da correção, confirme novas execuções e novos candles antes de confiar na atualização do painel.

### Perda do projeto Supabase

1. Crie um projeto substituto.
2. Aplique as migrations na ordem numérica.
3. Restaure a exportação do banco, se existir.
4. Reimplante as funções e reconfigure os segredos e o Vault.
5. Reative os crons e valide uma execução manual controlada.
6. Atualize a configuração pública do frontend e publique um novo deploy.

Se não houver backup do banco, `bootstrap-data` pode repor parte dos candles públicos e permitir novos modelos. Ele **não** recupera decisões prospectivas, paper trades, correções ou promoções perdidas; as métricas devem recomeçar, sem tentar reconstruir previsões depois do resultado.

### Perda dos dados do navegador

- Fechar a aba normalmente não apaga o IndexedDB.
- Limpar dados do site, trocar de perfil/navegador ou usar outro computador perde o estado local daquele perfil.
- O CSV é uma evidência externa do histórico visível, mas esta versão não oferece restauração completa de modelos, calibrações e preferências.
- O backend cloud permanece separado e pode continuar disponível, porém não deve ser importado como se fosse histórico local.

## 8. Segurança e privacidade

- O frontend usa somente configuração pública para consultar visões cloud explicitamente liberadas para leitura.
- Pesos completos, tabelas privadas, credenciais administrativas e dados de serviço não são expostos nessas visões.
- RPCs de escrita são usados internamente pelo cliente administrativo das Edge Functions. A borda exige POST, JWT validado pelo gateway com papel `anon` ou `service_role`, recusa sessões `authenticated` e sempre exige o segredo independente de cron. O padrão operacional usa `anon`, sem guardar `service_role` no Vault.
- `anon` e `authenticated` não recebem `SELECT` nas tabelas privadas. As visões `cloud_*` chamam projeções privadas, sem parâmetros, com colunas explícitas e `search_path` fixo.
- Não há login de usuário nem armazenamento de senha de corretora nesta entrega.
- Nunca adicione credenciais de corretora, chave administrativa do Supabase ou JWT de cron a `cloud-config.js`, ao ZIP publicado ou ao controle de versão.

## 9. Disclaimer operacional

Market Analyzer não é consultoria, recomendação financeira nem robô executor. Mercado real pode apresentar atraso, gap, spread, slippage, payout variável, rejeição de ordem e regras de empate diferentes do paper trading. Cripto, Forex e opções binárias têm risco elevado; uma sequência curta de acertos ou um backtest forte não prova vantagem futura. Use as métricas para avaliar evidência e risco, nunca como promessa de retorno.
