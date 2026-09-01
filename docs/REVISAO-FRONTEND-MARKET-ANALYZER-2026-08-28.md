# Revisão de frontend — Market Analyzer — 28/08/2026

## Escopo entregue

- A identidade visível foi alterada de **Signal Atlas** para **Market Analyzer** sem renomear as chaves internas de IndexedDB/localStorage. Essa preservação é intencional para não apagar modelos, preferências e histórico existentes.
- A interface ganhou uma camada visual final em `market-analyzer.css`: paleta mais neutra, hierarquia mais simples, cartões menos carregados, estados de resultado claros e responsividade validada em 390 px sem rolagem horizontal.
- O texto inicial passou a descrever diretamente o produto, sem promessa de desempenho: sinais explicados, ranking progressivo e histórico verificável.

## Scanner progressivo

- O Worker continua usando o motor completo e até três análises concorrentes.
- Cada ativo concluído aparece imediatamente na lista; os ativos restantes permanecem como linhas “Processando”.
- Cada linha registra seu próprio `scanCompletedAt` e mostra a hora da última análise.
- A melhor oportunidade disponível até aquele momento é promovida automaticamente para o cartão de sinal atual usando a mesma fotografia já ranqueada, sem novo fetch e sem divergência entre lista e análise aberta.
- O sinal é congelado prospectivamente no instante em que a linha é publicada, não apenas ao fim da varredura completa.

## Histórico e último resultado

- “Último resultado” agora significa o último desfecho realmente resolvido. Um sinal novo ainda pendente não substitui visualmente o último acerto/erro/neutro já conhecido.
- O resultado ganhou selo, horário da resolução e contagem de pendências separada.
- A antiga propriedade `dueAt`, que apontava para a abertura da vela-alvo, é migrada para o fechamento real (`expiresAt`).
- Uma rotina automática roda após a abertura e a cada 45 segundos. Ela agrupa pendências vencidas por ativo/timeframe, busca candles fechados e resolve somente quando encontra exatamente a vela de entrada e a vela de expiração.
- Nunca há interpolação, uso da vela seguinte ou reescrita de resultado final existente. Falha de fonte mantém o registro pendente para nova tentativa.

## Verificações executadas

- Sintaxe JavaScript: aprovada.
- Contrato novo de resolução do histórico: 8/8.
- Scanner: 3/3.
- Identidade do snapshot do ranking: 8/8.
- Causalidade local: 5/5.
- Contrato estático de segurança: aprovado.
- Testes das Edge Functions: 14/14.
- Navegador: nenhuma exceção no console; scanner progressivo e promoção automática observados; layout desktop e 390 px sem overflow horizontal.
