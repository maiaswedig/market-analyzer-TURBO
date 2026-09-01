# Ativação do backend gratuito de teste — 30/08/2026

## Limite do trabalho

Somente o projeto Supabase de teste `market-analyzer-teste` foi alterado. O
projeto de produção não foi tocado.

Nenhuma credencial está neste documento ou no pacote de revisão. O segredo do
worker foi rotacionado e existe apenas nos cofres do Supabase:

- Edge Function Secret: `SIGNAL_ATLAS_CRON_SECRET`;
- Vault: `signal_atlas_project_url`;
- Vault: `signal_atlas_cron_jwt`;
- Vault: `signal_atlas_cron_secret`.

O JWT do cron usa o papel público `anon`, mas não autoriza o worker sozinho. As
funções exigem também o segredo independente enviado no cabeçalho interno.

## Agendamentos ativos

| Job | Agenda | Estado |
|---|---:|---|
| `signal-atlas-market-cycle` | a cada minuto | ativo |
| `signal-atlas-train-challenger` | minuto 7 de cada hora | ativo |

As quatro primeiras execuções registradas pelo `pg_cron` terminaram como
`succeeded`. Os ciclos correspondentes gravaram `status = ok` no ledger do
scanner e zero erros.

## Bootstrap real

O bootstrap foi executado para os 8 ativos ativos e para M5, M15, M30 e H1,
sem sintetizar candles.

Resumo observado depois da carga:

| Timeframe | Candles no banco | Ativos cobertos |
|---|---:|---:|
| M5 | 13.004 | 8 |
| M15 | 12.682 | 8 |
| M30 | 10.358 | 8 |
| H1 | 13.000 | 8 |

O Yahoo devolveu cerca de 1.087–1.089 candles M30 por par Forex dentro da
janela pública disponível; os quatro criptoativos receberam 1.500. Essa
diferença foi preservada e reportada, não preenchida por interpolação.

## Calendário causal

Um ciclo automático de 17:34 UTC arquivou com sucesso uma fotografia do
calendário antes da análise:

- 5 eventos recebidos;
- 5 eventos inseridos;
- 5 observações versionadas inseridas;
- zero erro no ciclo.

O arquivo histórico passa a crescer a partir desta data. O sistema continua
sem projetar notícias atuais sobre backtests anteriores à primeira coleta.

## Teste real do treinador

Depois do bootstrap, o treinador processou `BNBUSDT|H1`:

- 1.500 candles reais;
- 1.290 amostras rotuladas;
- 1.286 amostras direcionais;
- 385 amostras na validação;
- gate de tamanho: passou (`385 >= 300`);
- gate de overfit: passou;
- gate de melhora pareada de Brier: falhou;
- candidato marcado como `usable = false`;
- nenhuma promoção.

Isso confirma execução do treino e, principalmente, confirma que o sistema não
promove um modelo apenas por ter sido treinado. O resultado ainda não comprova
vantagem estatística nem melhora futura.

## Advisors

O advisor de segurança mostrou somente avisos informativos de RLS sem policy
nas tabelas privadas. Esse desenho é intencional: RLS ligada e nenhuma policy
mantêm negação por padrão; as leituras públicas usam contratos explícitos.

O advisor de performance mostrou índices ainda não usados. O banco de teste é
novo e tem pouco tráfego; índices de integridade e consulta prospectiva não
foram removidos por causa desse aviso inicial.

## Custo e operação

A ativação usa o projeto que já está no plano gratuito. Não foi criado recurso
pago. A continuidade depende dos limites vigentes do plano gratuito; caso o
provedor altere cotas ou o volume cresça, o painel do Supabase deve ser
monitorado antes de qualquer upgrade.

