# Auditoria dos RPCs, empates, calibração e relógio — 28/08/2026

## Resultado executivo

A cadeia SQL que não havia sido enviada na primeira revisão foi localizada e auditada no repositório. As travas centrais de causalidade, imutabilidade e acesso estão presentes. Foram encontrados dois pontos confirmáveis: uma inconsistência de EV de empate no laboratório cloud e uma sobra operacional possível na fila de lacunas após abandono terminal.

A sobra da fila foi corrigida pela migration `018`. O cálculo do worker foi corrigido e testado para `loss`, `refund` e `win`. A migration `019` acrescenta o contrato econômico canônico no banco sem reescrever o ledger: triggers de inserção tornam a fórmula única para decisões, shadows antigos e laboratório independente, enquanto o RPC público passa a devolver os valores efetivamente congelados na linha.

## 1. RPCs e definições finais verificadas

- `register_market_decision`: definição final atual em `202608270010_integrity_contract.sql`.
- `resolve_due_outcomes`: wrapper determinístico em `202608270012_deterministic_resolution_reviews.sql`; seletor exato final em `202608280016_missing_candle_gap_backfill.sql`.
- `review_and_promote_challengers`: comparação independente final em `202608280014_independent_shadow_policies.sql`.
- `list_due_candle_gaps` e `reconcile_candle_gaps`: `202608280016_missing_candle_gap_backfill.sql`.
- bloqueio de outcome depois de abandono: triggers bidirecionais em `202608280016_missing_candle_gap_backfill.sql`.
- ciclo de cancelamento de trabalho sem referência: `202608280017_candle_gap_lifecycle.sql` e complemento `018`.
- `record_scanner_run`: implementação privada em `202608260001_cloud_validation.sql`, wrapper em `202608260002_edge_contract.sql` e endurecimento de permissões em `202608270011_security_release_hardening.sql`.

As funções públicas de escrita revogam execução de `PUBLIC`, `anon` e `authenticated` e concedem somente ao `service_role`. As tabelas privadas usam RLS forçado e não concedem acesso direto ao navegador. As views públicas usam `security_invoker` e projetores privados de leitura.

## 2. Causalidade e imutabilidade preservadas

- A resolução exige a vela exata de entrada por `open_time = entry_at`.
- A vela de expiração exige `close_time = expiry_at`.
- Candles fechados são imutáveis.
- Outcome não pode ser criado antes da expiração.
- Decisão abandonada não pode receber outcome posterior.
- Decisão resolvida não pode receber abandono posterior.
- Shadows v2 precisam ser congelados antes da entrada.
- Promoção exige oportunidades prospectivas únicas, ao menos 20 dias, 100 trades do challenger e 500 oportunidades, além de limite inferior de EV positivo contra champion e heurística.

## 3. Inconsistência confirmada na política de empate

O modelo binário é treinado sem candles empatados. Portanto, `probability_up` é condicional a uma vela não empatada. O worker já transforma essa probabilidade em probabilidade incondicional de vitória multiplicando por `1 - tieRate`.

O laboratório SQL v2, porém, calculava `expected_ev` como se o empate fosse sempre perda e sem usar a política congelada da operação. O padrão atual `loss` reduz o impacto funcional das diferenças entre políticas, mas ainda permite superestimar a probabilidade incondicional quando `tieRate > 0`.

Mudanças seguras realizadas:

- `independentModelDecision()` agora calcula vitória, derrota e empate separadamente.
- `tiePolicy` passou a ser parte explícita de `DecisionOptions`.
- testes cobrem `loss`, `refund` e `win` com valores econômicos exatos.
- `tools/validacao-politica-empate.sql` mede a divergência real já registrada sem alterar dados.

Mudança preparada para staging:

- `202608280019_canonical_tie_economics.sql` cria `signal_atlas.expected_trade_ev()` como único cálculo econômico para novos inserts.
- o RPC v2 auditado é movido para o schema privado e envolvido por um wrapper público mínimo, exclusivo do `service_role`, que devolve o EV já canônico da linha.
- triggers `BEFORE INSERT` canonizam decisões, shadows e políticas independentes; não existe `UPDATE` dos ledgers históricos na migration.
- `supabase/tests/economic_contract.sql` verifica os valores exatos `-0.021`, `0.079` e `0.164`, os três triggers, o wrapper endurecido e a inacessibilidade da implementação legada.

## 4. Fila de lacunas

A lease de 90 segundos, lote de seis, concorrência de três e backoff de 5 até 360 minutos foram confirmados. O banco verifica novamente a existência do candle exato antes de resolver a lacuna.

Problema adicional encontrado: se uma decisão possuísse lacunas de entrada e expiração e uma delas gerasse abandono antes da outra ser reclamada, a lacuna irmã poderia permanecer com `status = pending`, embora já não fosse elegível para processamento.

A migration `202608280018_abandonment_gap_cleanup.sql` adiciona um trigger direcionado que cancela apenas o trabalho irmão sem decisão elegível. Ela também limpa resíduos anteriores usando a função de ciclo de vida já existente. Nenhum sinal, outcome ou candle é reescrito.

## 5. B0/B1 e risco de overfitting

O comentário antigo em `score.js` apontava para `tools/calibrate.mjs`, arquivo inexistente. O texto foi corrigido: `0.06` e `0.45` são defaults de produto, não evidência de vantagem estatística.

Foi criado `tools/calibrate-score.mjs` com estas regras:

- execução separada por ativo e timeframe;
- seleção apenas na janela cronológica antiga;
- embargo entre calibração e validação;
- abertura única do holdout recente;
- comparação com o default e benchmark aleatório líquido;
- candidato apenas diagnóstico, sem persistência ou promoção automática.

O backtest agora expõe o viés bruto necessário à reprodução da escala. O script desativa a influência do ranking de setups antigo durante essa calibração para reduzir circularidade.

## 6. Relógio do runtime e do provedor

O banco já rejeitava candle fechado antes de `close_time`, o que fornecia uma segunda trava independente do Deno. O provedor agora acrescenta uma proteção conservadora: quando o header HTTP `Date` está disponível, o fechamento usa o menor valor entre o relógio do runtime e o relógio da fonte, com apenas dois segundos para granularidade do header.

Isso impede um runtime adiantado de classificar candle como fechado cedo. Na ausência do header, o comportamento anterior é preservado e a validação do banco continua ativa.

## 7. Histórico operacional sem perda de aprendizagem

O ledger local continua congelando, resolvendo e usando internamente sinais de todos os níveis. A interface operacional, o CSV principal e o ranking prospectivo passam a aceitar somente notas A/A+ cuja qualidade na emissão não seja `BAIXA`. A nota é congelada junto da primeira publicação; uma análise posterior não pode promover retroativamente a mesma vela.

Registros B/C/D, avaliações baixas e legados sem nota congelada permanecem no IndexedDB para auditoria, calibração e retreino. A interface mostra quantos registros ficaram fora da taxa operacional, evitando esconder o tamanho real da coleta.

## 8. Verificações executadas localmente

- Edge unit tests: 18/18.
- política do histórico operacional: 11/11.
- causalidade local: 5/5.
- liquidação do histórico: 8/8.
- snapshot do ranking: 8/8.
- fila do scanner: 3/3.
- calibração de score: 8/8.
- contrato estático de segurança: aprovado.
- sintaxe de todos os arquivos JavaScript: aprovada.

Os testes SQL que dependem de Postgres/Supabase não foram executados localmente porque não há instância Postgres local configurada. As migrations `018` e `019` devem ser aplicadas em staging, seguidas de `gap_backfill_contract.sql`, `economic_contract.sql`, `security_contract.sql` e advisors de segurança/desempenho antes da produção.
