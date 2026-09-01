# Interface arquivada

Os arquivos em `legacy/js/` pertencem à interface anterior e **não fazem parte do runtime atual**.

- entrada ativa do navegador: `index.html` → `js/signal-ai.js`;
- arquivos arquivados: `app.js`, `history.js`, `broker.js`, `alerts.js`, `backend-status.js`, `chart.js` e `tv.js`;
- o conteúdo foi mantido somente para consulta histórica;
- esta pasta não é carregada, testada nem considerada executável em produção;
- uma correção do produto atual nunca deve ser feita aqui.

Decisão registrada em 27/08/2026: arquivar em vez de apagar para preservar o histórico de implementação sem confundir o código em produção.
