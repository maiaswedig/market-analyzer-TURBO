# Market Analyzer — análise local + validação contínua na nuvem

Aplicativo web de análise assistida para cripto e Forex. O projeto funciona em duas camadas independentes e identificadas:

- **Motor local no navegador:** faz a análise profunda do ativo escolhido, usa a vela atual em formação junto do histórico, roda scanner/backtest/treino em Web Workers e persiste modelos, preferências e histórico no IndexedDB do dispositivo.
- **Motor oficial 24/7:** usa Supabase Edge Functions, PostgreSQL e agendamentos para coletar candles, congelar decisões prospectivas, resolver paper trades e comparar modelos mesmo quando o site está fechado. O cartão superior e a lista oficial do frontend consultam somente projeções públicas de leitura desse motor.

As métricas das duas camadas nunca são combinadas. A leitura cloud é a referência oficial compartilhada; a análise local continua complementar e não pode alterar a decisão congelada do backend.

> **Aviso:** o Market Analyzer é uma ferramenta educacional de apoio à decisão. Não envia ordens, não se conecta a contas de corretora e não garante acerto, lucro ou disponibilidade dos dados.

Para revisão por outra IA sem usar ZIP, comece por [PERPLEXITY-REVIEW.md](PERPLEXITY-REVIEW.md). Esse documento especifica o comportamento esperado, a arquitetura, as regras estatísticas, o mapa de arquivos, o estado verificado e os pontos abertos sem esconder o EV paper negativo.

## Estado funcional do pacote

| Componente | Estado no código | Observação |
| --- | --- | --- |
| Interface responsiva, gráficos e análise profunda | Pronto | Funciona sem backend próprio enquanto a página estiver aberta. |
| Workers para análise, scanner, treino e backtest | Pronto | Mantém a interface responsiva durante tarefas pesadas. |
| IndexedDB e migração do armazenamento antigo | Pronto | É local ao navegador e não sincroniza automaticamente entre computadores. |
| Histórico local, ranking real e exportação CSV | Pronto | Backtest hipotético permanece separado do ranking ao vivo. |
| Sinal oficial e monitoramento 24/7 | Pronto e implantado | O cartão superior usa a decisão canônica do backend; mostra nota técnica separada da qualidade confirmado/técnico/baixo. |
| Banco causal e ledger imutável | Incluído nas migrations | Decisões, resultados, modelos e promoções são append-only; correções viram novos eventos. |
| Coleta e resolução automática na nuvem | Implantada no projeto verificado | Dois jobs ativos; uma reconstrução em outro projeto ainda exige o procedimento de implantação. |
| Calendário causal no backtest | Pronto no código e validado em teste | Só entra com fotografia histórica exata e cobertura de 100%; períodos anteriores à migration `023` continuam indisponíveis. |
| Baselines e champion/challenger prospectivo | 24 escopos inicializados | Existe um baseline por ativo/timeframe para iniciar a medição; somente os que passam os gates de validação podem ser tratados como fortes. O backend treina E1; E2/E3 continuam disponíveis no motor local, mas ainda não têm treino cloud próprio. |
| Retenção/arquivamento automático do banco | Pendente | O banco cresce continuamente e precisa de monitoramento e de uma futura política auditável de arquivo. |
| Backup completo do estado local | Pendente | O CSV preserva o histórico visível para auditoria, mas não restaura modelos e preferências. |
| Execução em corretora | Não implementada | Paper trading e sinais são intencionalmente separados de qualquer ordem real. |

Esse quadro descreve o que está incluído no pacote; não substitui a verificação do ambiente publicado. Consulte o [estado verificado da implantação](docs/STATUS-IMPLANTACAO.md) e o [guia de operação e recuperação](docs/GUIA-OPERACAO-E-RECUPERACAO.md) antes de considerar o serviço 24/7 ativo.

## Recursos principais

- **Sinal oficial no topo:** a melhor oportunidade congelada pelo backend sobe automaticamente ao cartão principal. Nota A+/A/B/C/D mede a evidência técnica; confirmado/técnico/baixo mede o gate operacional e estatístico. Uma não substitui a outra.
- **Lista oficial 24/7:** confirmados com evidência aparecem primeiro, seguidos de sinais técnicos e avaliações baixas. Filtros não apagam uma direção existente; eles rebaixam a qualidade e exibem o motivo.
- **Scanner progressivo sem trocar a fotografia:** a lista usa até 3.000 candles por ativo, consulta até três ativos em paralelo e publica cada resultado assim que termina. A melhor leitura parcial sobe automaticamente para o sinal atual. Abrir uma linha reutiliza exatamente o resultado ranqueado; “Analisar agora” continua usando todo o histórico profundo configurado.
- **Abertura consistente do ranking:** “Abrir análise” reutiliza a fotografia completa que recebeu direção, força, nota e posição; uma nova coleta só ocorre ao usar “Analisar agora” ou na atualização automática identificada como nova leitura.
- **Explicação do sinal:** detalha confluência, indicadores, filtros, risco e amostra estatística que sustentam compra, venda ou aguardar.
- **Gráficos simultâneos:** TradingView como referência visual e gráfico próprio com candles, EMA 9/21/50 e zonas de suporte/resistência.
- **Política operacional única:** a interface usa uma só política de análise, sem seletor conservador/neutro/agressivo e sem custo adicional configurável. O legado dos três modos permanece imutável para auditoria, mas somente decisões novas da política única alimentam a curva vigente.
- **Vela atual e próxima operação:** a inferência local considera a vela em formação e mostra o horário da próxima vela no fuso do navegador; treino e resultados usam somente candles fechados.
- **Qualidade de mercado:** pavios, VSA/volume disponível, zonas M15/H1, atraso do dado, notícias e transições de sessão entram como evidência e alertas visíveis.
- **Expiração flexível local:** E1, E2 e E3 são acompanhadas separadamente. O backend cloud atual usa E1 para não aplicar probabilidades treinadas em um horizonte a outro.
- **Persistência real:** modelos aceitos, histórico, feedback/calibração e preferências sobrevivem ao fechamento da aba no mesmo navegador.
- **Histórico auditável e visão operacional:** o primeiro sinal publicado na vela é congelado e depois comparado com a expiração registrada. O ledger bruto preserva todos os níveis para treino; a tabela e o CSV mostram todos os A/A+, inclusive os de avaliação baixa, com a qualidade explícita para não inflar a interpretação da nota.
- **Custos e benchmark:** spread/slippage configurado entra no EV; a taxa aparece junto da referência aleatória de 50% e do EV desse benchmark sob a mesma política de payout/custo.
- **Acessibilidade:** onboarding, tooltips, tabelas semânticas e cartões responsivos em telas pequenas.

## Como a aprendizagem realmente funciona

Não há uma “IA que descobre lucro sozinha”. Há recalibração controlada e validação cronológica:

1. O sinal pode ler a vela atual em formação e todas as velas anteriores disponíveis.
2. O treino só cria rótulos depois que a vela-alvo fechou; o futuro nunca entra nas features da decisão.
3. O modelo local reserva pelo menos 500 amostras recentes de validação e só é aceito quando o ganho de Brier supera uma margem baseada no erro-padrão.
4. Na nuvem, um único escopo `ativo|timeframe` é treinado por hora para permanecer dentro do orçamento gratuito. O holdout cronológico reserva pelo menos 300 observações recentes e purga a fronteira treino/validação.
5. O primeiro modelo cloud com amostra suficiente vira uma **baseline inicial** para começar a medição prospectiva. Há 24 baselines, um para cada combinação inicial de 8 ativos × 3 timeframes. Se um deles não passou os gates offline, continua explicitamente como avaliação baixa; baseline não conta como validação forte.
6. Modelos seguintes entram no laboratório shadow independente. Heurística, champion e challenger escolhem separadamente `COMPRA`, `VENDA` ou `AGUARDAR` sobre a mesma oportunidade neutra. Somente challengers treinados com a política de decisão v2 podem ser promovidos; artefatos e revisões v1 permanecem como evidência histórica. Só há substituição após 500 oportunidades futuras únicas, pelo menos 20 dias, 100 operações do challenger, limite inferior de 95% do ganho de EV por oportunidade acima de zero contra **champion e heurística**, Brier não pior e drawdown controlado.
7. A nota cloud é calculada por oito verificações distribuídas em cinco famílias (tendência, momentum, RSI, volume e price action), com pesos decrescentes nos sinais correlacionados. Ela ordena evidência técnica; não é uma probabilidade calibrada.
8. Desde a migration `026`, `CONFIRMED` exige no banco uma promoção prospectiva real, 500 pares avaliados na revisão, limite inferior da probabilidade suficiente e EV conservador positivo. A/A+ sozinho e `usable=true` nunca concedem confirmação.
9. Backtest, sinais locais e referências da nuvem permanecem separados. Nenhum resultado retrospectivo é misturado à pontuação usada no sinal ao vivo.

O objetivo técnico é medir **EV líquido após custos, calibração e drawdown**, não maximizar uma taxa de acerto isolada. O snapshot implantado em 27/08/2026 ainda apresentava EV paper negativo; por isso, o estado atual não sustenta promessa de lucro. Veja o [diagnóstico de EV e modos](docs/DIAGNOSTICO-EV-E-MODOS-2026-08-27.md), a [metodologia de calibração](docs/METODOLOGIA-CALIBRACAO.md) e o [status da implantação](docs/STATUS-IMPLANTACAO.md).

A análise da revisão v11, os resultados das consultas e a correção de velocidade do scanner estão documentados em [Revisão v11 e desempenho](docs/REVISAO-V11-E-DESEMPENHO-2026-08-27.md).

## Manter online gratuitamente

O frontend é estático e pode ser publicado na Netlify com a raiz desta pasta como diretório de publicação. Não há comando de build.

Para funcionar somente no navegador, basta publicar os arquivos. Para continuar coletando com o site fechado, também é necessário aplicar as migrations, implantar as quatro Edge Functions e ativar os agendamentos no Supabase. O arquivo `cloud-config.example.js` mostra a estrutura da configuração pública do frontend; nenhuma chave administrativa pode ser colocada no navegador.

A implantação atual requer todas as migrations `001`–`026` presentes na pasta. Em especial, `006`–`009` adicionam métricas/ranking por modo, índices e visões públicas; a `010` congela o primeiro evento de cada slot, versiona a política real e torna artefatos idempotentes; a `011` aplica autenticação dupla e remove a API pública legada; a `012` congela o instante causal das resoluções e revisões; a `013` publica curvas diagnósticas separadas por modo e qualidade sem reclassificar o histórico; a `014` instala o laboratório prospectivo de decisões independentes; a `015` cobre sua chave estrangeira de política com índice; a `016` recupera lacunas de candles exatos por uma fila privada, limitada e auditável; a `017` encerra como cancelado o trabalho de fila que deixou de ter decisão pendente; a `018` remove trabalho irmão órfão após abandono terminal; a `019` centraliza o EV de `loss`, `refund` e `win`; a `020` adiciona M30 ao tipo cloud; a `021` ativa M30 no runtime e inicia o arquivo prospectivo do calendário; a `022` fixa a leitura `as-of` na observação versionada; a `023` cria fotografias completas por coleta e a ponte de replay causal; a `024` publica o histórico cloud A/A+; a `025` expõe as explicações públicas das decisões; e a `026` desacopla a nota técnica da confirmação prospectiva e cria a fonte canônica do navegador. Uma reconstrução parcial fica incompatível com o frontend atual.

Depois da `011`, os jobs ficam pausados por projeto. Em atualização de uma instalação antiga, aplique primeiro a `011` para pausar os jobs e depois `010`/`012`; em banco novo, aplique os arquivos na ordem numérica. Em ambos os casos, reimplante as Functions antes de ativar os jobs. Não copie JWT, chave secreta ou segredo de cron para `cloud-config.js`, documentação, logs ou navegador.

O passo a passo completo, os testes de saúde e a recuperação estão em [docs/GUIA-OPERACAO-E-RECUPERACAO.md](docs/GUIA-OPERACAO-E-RECUPERACAO.md).

## Limites do uso gratuito

- A estimativa atual do backend é de aproximadamente **43.200 chamadas/mês** para o ciclo a cada minuto, mais cerca de **720 chamadas/mês** para o treino horário, antes de reexecuções manuais. Isso fica abaixo da franquia de 500.000 invocações mensais descrita pelo Supabase em agosto de 2026, mas as regras do provedor podem mudar.
- Oito ativos em M5/M15/M30/H1 podem produzir até cerca de **3.648 candles fechados por dia** em mercados contínuos. O banco, não o frontend, é o limite mais provável do plano gratuito.
- Não existe retenção automática nesta entrega. Candles fechados são imutáveis pelo desenho atual; monitore o tamanho do banco e planeje uma migration de arquivamento antes de se aproximar do limite do plano.
- Binance, Yahoo Finance, calendário econômico, TradingView e proxies públicos não fornecem SLA ao projeto. A migration `016` reconsulta até seis lacunas exatas por ciclo com backoff, mas não inventa preços: após o limite auditável, a decisão fica terminalmente sem resultado e fora das métricas. As migrations `020`–`023` acrescentam M30, arquivam fotografias completas do calendário e habilitam replay causal; isso não cria calendário histórico anterior à implantação.
- Hospedagem gratuita não equivale a disponibilidade garantida. Netlify e Supabase podem alterar cotas, políticas de inatividade ou limites de uso.

## Persistência e recuperação em resumo

- Fechar e reabrir a aba preserva o IndexedDB no mesmo perfil do navegador.
- Limpar dados do site, usar outro navegador ou outro computador inicia um estado local novo. O painel cloud continua compartilhado se apontar para o mesmo backend.
- **Exportar CSV** cria uma cópia auditável do histórico visível, não um backup completo do IndexedDB.
- O frontend pode ser recuperado reenviando esta pasta ou revertendo para um deploy anterior da Netlify.
- Um projeto Supabase novo pode reconstruir a estrutura aplicando as migrations e refazendo o bootstrap de candles. Sem exportação do banco anterior, decisões prospectivas, resultados e histórico de promoções não podem ser recriados honestamente.

## Estrutura da entrega

```text
index.html / styles*.css       frontend estático
js/                            análise local, Workers, persistência e leitura cloud
legacy/js/                     interface antiga arquivada, fora do runtime e dos testes
cloud-config.example.js        modelo sem valores da configuração pública
netlify.toml                   publicação e cabeçalhos básicos
vercel.json                   publicação alternativa gratuita na Vercel
supabase/migrations/           banco causal, política única vigente, legado auditável, índices e agendamentos
supabase/functions/            coleta, bootstrap, treino challenger e replay causal do calendário
docs/                          operação, recuperação e metodologia estatística
```

## Auditoria econômica e calibração

- `tools/validacao-politica-empate.sql` compara, sem escrever no banco, o EV cloud gravado com a fórmula canônica de vitória/derrota/empate.
- `tools/calibrate-score.mjs ATIVO TIMEFRAME CANDLES` mantém como padrão a pesquisa de B0/B1/minScore por segmento.
- `tools/calibrate-score.mjs ATIVO TIMEFRAME CANDLES --mode=weights --windows=4` executa a Fase A dos sete pesos: até 35 candidatos, janelas cronológicas independentes com `z=2,58` e um holdout final intocado com `z=1,96`. O relatório é somente diagnóstico e nunca altera defaults ou produção automaticamente.
- `tools/verify-backtest-replay.mjs` prova que o backtest público continua equivalente à composição do contexto caro com o replay reutilizável e que execuções repetidas não carregam estado mutável.
- `docs/IMPLEMENTACAO-REPLAY-CALENDARIO-CAUSAL-2026-08-30.md` documenta a ponte de replay, o gate de cobertura integral e por que o treino cloud ainda permanece price-only.
- `docs/AUDITORIA-RPCS-EMPATE-CALIBRACAO-2026-08-28.md` documenta os RPCs efetivos, as travas causais e as pendências que exigem staging.
- `supabase/tests/economic_contract.sql` valida no Postgres a política única de empate e os privilégios dos RPCs após a migration `019`.

## Disclaimer

Mercados financeiros, criptoativos, Forex e opções binárias envolvem risco elevado e podem causar perda total do capital. Dados públicos podem atrasar ou divergir da corretora, e custos reais podem eliminar um EV aparente. Taxa histórica, nota, confiança, backtest, paper trading e validação prospectiva não garantem desempenho futuro. Confirme cotação, payout, spread, slippage, regras de empate, horário e gestão de risco antes de qualquer decisão. Nunca opere dinheiro que não pode perder.
