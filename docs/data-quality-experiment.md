# Experimento de qualidade de dados — versão 2

Ativado em 24/09/2026 às 23:37 UTC, exclusivamente em simulação. Primeiro par congelado às 23:39 UTC. Não houve preenchimento retroativo nem alteração da estratégia oficial.

Em cada nova decisão champion no modo neutro, registrar duas alternativas: `quality_control` segue a direção atual; `quality_filtered` segue a mesma direção somente se passar pelos critérios abaixo. As duas recebem o mesmo instante de registro, antes da entrada. Decisões recebidas após a entrada não entram no experimento.

Critérios fixados antes da coleta: idade desde o recebimento de até 30 segundos; latência da fonte de até 10 segundos; três velas fechadas consecutivas já recebidas até o corte de dados; última vela fechada com atraso máximo de um período mais 90 segundos; rejeitar três velas consecutivas sem amplitude. Não tratar volume zero no Forex como erro: essa fonte não oferece volume centralizado. A vela atual em formação continua sendo parte da estratégia original; a verificação de completude aplica-se às três velas fechadas de apoio.

Cada par guarda as velas consultadas, limites e motivos de espera. `data_age_ms` mede o tempo desde o recebimento, não a idade original da cotação no provedor; o teste de continuidade e a idade das velas complementam essa limitação.

Revisar somente após pelo menos 20 dias distintos, 500 oportunidades resolvidas e 100 operações filtradas. Consultar `tools/review-data-quality-experiment.sql`: comparação pareada com a estratégia atual, incluindo espera como resultado zero, e incerteza por dia. Exigir retorno líquido positivo e melhora conservadora frente ao controle; superar o acaso, sozinho, não prova rentabilidade. Os limites de amostra não garantem significância. Não ajustar parâmetros usando essa mesma amostra; qualquer alteração exige uma nova versão e coleta futura. Nenhuma promoção é automática.

## Diagnóstico dos empates

Na consulta de 22/09, EURUSD M5 teve 4.510 velas fechadas desde 01/09 na fonte Yahoo: 1.815 com abertura igual ao fechamento (40,24%) e 881 sem amplitude (19,53%). Em 2.248 resultados E1 verificados, 914 empataram; 456 desses vieram de velas sem amplitude. Nenhum dos resultados divergiu da abertura/fechamento armazenados. A origem imediata está nos dados recebidos, e não em diferença entre os preços armazenados e a liquidação. Arredondamento ou baixa atualização no provedor continuam hipóteses não confirmadas.

## Operação

Resumos históricos e o histórico usado pelo ranking são recalculados a cada 15 minutos, em horários distribuídos. Sinais e elegibilidade de entrada continuam consultados ao vivo. O painel informa a faixa de horários de cálculo dos resumos e alerta após 20 minutos. Os jobs de atualização devem continuar sendo verificados no Supabase.

O verificador de segurança retornou apenas informações sobre tabelas privadas com RLS e sem políticas: o bloqueio direto é intencional; as consultas públicas seguem funções restritas. Referência: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
