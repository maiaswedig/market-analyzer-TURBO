import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function migrationRows() {
  return fs.readdirSync(path.join(root, 'supabase', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name, index) => `${index + 1}. \`${name}\``)
    .join('\n');
}

function functionRows(snapshot) {
  return snapshot.edgeFunctions
    .map((item) => `| ${item.name} | ${item.version} | ${item.status} | ${item.verifyJwt ? 'sim' : 'não'} |`)
    .join('\n');
}

function scheduleRows(snapshot) {
  return snapshot.schedules
    .map((item) => `| ${item.name} | \`${item.schedule}\` | ${item.active ? 'ativo' : 'pausado'} |`)
    .join('\n');
}

function paperRows(snapshot) {
  return snapshot.paperSummary
    .map((item) => `| ${item.mode} | ${item.trades} | ${item.evNetPerTrade.toFixed(4)} | ${item.benchmarkEvPerTrade.toFixed(4)} | ${item.edgeVsBenchmark.toFixed(4)} | ${item.maxDrawdown.toFixed(2)} |`)
    .join('\n');
}

export function buildTechnicalReview() {
  const snapshot = readJson('docs/technical-review-runtime-snapshot.json');
  const pkg = readJson('package.json');
  const testCommands = Object.entries(pkg.scripts)
    .filter(([name]) => name.startsWith('test:'))
    .map(([name, command]) => `- \`npm run ${name}\` — \`${command}\``)
    .join('\n');

  return `# Market Analyzer — revisão técnica atual

> Documento gerado por \`tools/generate-technical-review.mjs\`. Não edite números de produção diretamente neste arquivo: atualize primeiro \`docs/technical-review-runtime-snapshot.json\` com consultas somente leitura e execute \`npm run docs:technical-review\`.

Última verificação do ambiente: **${snapshot.verifiedAt}**  
Fonte do snapshot: **${snapshot.source}**  
Contrato de qualidade vigente: **v4 (migration 026)**

## 1. Conclusão executiva

O Market Analyzer é uma ferramenta educacional de análise e paper trading para cripto e Forex. Ele não envia ordens, não acessa saldo e não promete lucro. O sistema coleta dados e treina challengers automaticamente, mas uma melhoria só pode virar champion após validação prospectiva pareada. A nota técnica A/A+ ordena oportunidades; ela não é probabilidade calibrada nem transforma uma decisão em \`confirmed\`.

No snapshot acima, o sistema **ainda não comprovou vantagem líquida sobre o benchmark**. Isso não deve ser escondido nem corrigido ajustando pesos na mesma amostra. O próximo avanço depende de coleta prospectiva, comparação fora da amostra e eventual promoção que passe os gates existentes.

## 2. Estado real verificado

### Backend e agendamentos

| Função | Versão | Estado | JWT verificado |
|---|---:|---|---|
${functionRows(snapshot)}

| Job | Agenda | Estado |
|---|---|---|
${scheduleRows(snapshot)}

O site não precisa permanecer aberto para esses ciclos cloud. O processamento local no navegador continua separado e complementar.

### Ledger e contrato de qualidade v4

- Decisões totais: **${snapshot.decisionLedger.total}**.
- Decisões já emitidas sob o contrato v4: **${snapshot.decisionLedger.qualityContractV4}**.
- Notas A/A+ no contrato v4: **${snapshot.decisionLedger.gradeAOrAboveV4}**.
- Qualidade \`confirmed\` no contrato v4: **${snapshot.decisionLedger.confirmedV4}**.
- Eventos \`bootstrap_champion\`: **${snapshot.deploymentEvents.bootstrapChampion}**.
- Eventos reais \`promote_champion\`: **${snapshot.deploymentEvents.promoteChampion}**.

Ter A/A+ e continuar em avaliação baixa é comportamento intencional: a nota mede qualidade técnica comparativa; \`confirmed\` exige evidência prospectiva independente.

### Paper trading cloud legado (congelado para auditoria)

| Modo | Operações | EV líquido/op. | Benchmark/op. | Diferença | Drawdown máx. |
|---|---:|---:|---:|---:|---:|
${paperRows(snapshot)}

Desde a migration 027, novos ciclos usam somente a política única interna \`neutro\`, com custo adicional zero. A curva atual começa do zero e não mistura os resultados antigos: **${snapshot.currentPaperSummary.trades} operações resolvidas**, benchmark inicial **${snapshot.currentPaperSummary.benchmarkEvPerTrade.toFixed(4)}** por operação. O ledger histórico dos três modos não foi apagado nem recalculado.

O estado de saúde do snapshot era \`${snapshot.systemHealth.status}\`, com **${snapshot.systemHealth.resolvedProspectiveSignals}** sinais prospectivos resolvidos. \`partial\` descreve cobertura/execução incompleta do ciclo, não lucro nem falha estatística por si só.

## 3. Regra atual de nota e qualidade

1. A direção técnica permanece visível quando calculável; filtros rebaixam qualidade e explicam o motivo.
2. A nota usa oito verificações organizadas em cinco famílias com pesos e retorno decrescente para evidência correlacionada. Ela serve para **ordenação técnica**.
3. \`technical\` exige passar o gate da política econômica/estatística única.
4. \`confirmed\` exige, além do gate técnico, um evento real e anterior de \`promote_champion\` para o mesmo ativo, timeframe e artefato; amostra prospectiva pareada mínima; limite inferior de probabilidade; e EV conservador positivo.
5. O banco relê a fonte de verdade. Nenhum campo alegado pelo frontend ou pela Edge Function concede confirmação.
6. Histórico antigo não é reclassificado retroativamente.

## 4. Auditoria externa dos oito pontos da qualidade v4

Revisão externa recebida em 01/09/2026: **oito de oito pontos aprovados**. O registro completo está em \`docs/AUDITORIA-CLAUDE-QUALIDADE-V4-2026-09-01.md\`.

1. A promoção é limitada por ativo, timeframe, artefato e instante efetivo anterior à decisão.
2. \`paired_samples\` vem do shadow prospectivo pareado no mesmo evento, não da validação offline.
3. A seleção pública do champion não ressuscita artefato aposentado nem atribui decisão antiga ao champion atual.
4. Nenhum caminho transforma A/A+ em \`confirmed\`.
5. Na mesclagem do ranking, a fotografia canônica congelada vence campos transitórios da oportunidade.
6. Pesos são apresentados como ordenação técnica; nota e probabilidade permanecem separadas.
7. \`register_market_decision\` relê a qualidade calculada pela autoridade SQL.
8. A view pública é somente leitura e não expõe tabelas privadas.

O contrato automatizado \`supabase/tests/confirmed_quality_contract.sql\` também inspeciona a definição viva da função com \`pg_get_functiondef\` para impedir a volta de atalhos por nota ou \`champion_usable\`.

## 5. Causalidade e integridade

- A decisão é registrada antes da entrada e o resultado somente após a expiração.
- A resolução exige candles exatos; não interpola nem substitui pelo candle seguinte.
- Lacunas entram em fila deduplicada e backfill; após o limite, são abandonadas sem contaminar outcome, aprendizado ou EV.
- Backtest e replay usam cortes temporais, embargo e holdout fora da busca.
- O calendário econômico é arquivado de forma append-only e consultado \`as-of\`; revisões futuras não aparecem no passado.
- Ranking real, ranking de backtest, histórico local e histórico cloud permanecem separados.
- Empates continuam no denominador e seguem uma única política econômica versionada.

## 6. Timeframes, fontes e limites operacionais

O frontend suporta M1, M5, M15, M30, H1 e H4. O cloud opera M5, M15, M30 e H1. M30 foi adicionado sem inventar candles e começa sua própria amostra prospectiva do zero.

Fontes públicas incluem OKX, Binance/Coinbase/Kraken para cripto conforme disponibilidade e Yahoo Finance com proxies/fallbacks para Forex. Não existe SLA. Idade e latência do dado devem permanecer visíveis; volume de Forex é aproximação e não equivale a volume centralizado.

## 7. Segurança

- Edge Functions ativas mantêm \`verify_jwt=true\` e segredo interno separado.
- \`anon\`/\`authenticated\` não recebem acesso direto às tabelas privadas.
- Views públicas são projeções explícitas, somente leitura e \`security_invoker\`.
- Segredos reais não pertencem ao frontend, documentação, pacote de revisão ou repositório.
- RLS sem policy nas tabelas privadas é deny-by-default intencional; mudanças devem manter os contratos de segurança.

## 8. Migrations aplicadas e presentes no código (${snapshot.migrationsApplied})

${migrationRows()}

## 9. Verificações automatizadas disponíveis

${testCommands}

O teste \`test:technical-review\` falha se este documento divergir do gerador, se o snapshot declarar quantidade errada de migrations, se a migration 026 desaparecer ou se o texto voltar a ligar A/A+ a \`confirmed\`.

## 10. Pontos ainda abertos

- Não há evento real de promoção prospectiva no snapshot; portanto, zero confirmações é o resultado correto.
- Os três modos legados produziram decisões e EV praticamente idênticos; por isso foram aposentados para novas emissões. Permanecem apenas como auditoria histórica.
- A política única com custo zero começou uma curva prospectiva separada e ainda precisa acumular resultados antes de qualquer conclusão.
- O EV líquido seguia pior que o benchmark. Mais código não prova edge; somente dados prospectivos e validação fora da amostra podem fazê-lo.
- O arquivo de calendário precisa acumular meses antes de sustentar conclusões históricas fortes.
- Atualize o snapshot com consultas somente leitura antes de publicar uma nova afirmação numérica.

## 11. Arquivos prioritários para nova revisão

- \`supabase/migrations/202608310026_decouple_confirmed_quality.sql\`
- \`supabase/migrations/202609010027_single_policy_zero_cost.sql\`
- \`supabase/tests/confirmed_quality_contract.sql\`
- \`supabase/tests/single_policy_contract.sql\`
- \`supabase/functions/market-cycle/index.ts\`
- \`supabase/functions/_shared/features.ts\`
- \`js/signal-ai.js\`
- \`js/score.js\`
- \`js/backtest.js\`
- \`tools/generate-technical-review.mjs\`
- \`docs/technical-review-runtime-snapshot.json\`

## 12. Uso correto

Trate direção, força, nota, probabilidade e histórico como apoio a paper trading e pesquisa. Mesmo uma nota A+ pode perder. Nenhuma métrica isolada é recomendação financeira ou garantia de acerto.
`;
}

const output = path.join(root, 'PERPLEXITY-REVIEW.md');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(output, buildTechnicalReview(), 'utf8');
  console.log(`Documento atualizado: ${output}`);
}
