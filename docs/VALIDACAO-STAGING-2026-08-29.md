# Validação do Market Analyzer em ambiente gratuito de teste

Data: 29/08/2026  
Ambiente: projeto Supabase gratuito isolado (`market-analyzer-teste`)  
Produção: não alterada

## Resultado executivo

O esquema, os contratos SQL e as três Edge Functions foram implantados e exercitados em um projeto de teste vazio. Os controles de causalidade, economia, lacunas e segurança passaram. O treinamento percorreu o fluxo completo, criou um artefato challenger e recusou corretamente sua utilização porque a melhora estatística não superou a margem mínima exigida.

Isso valida o funcionamento técnico do pipeline e das travas. Não demonstra vantagem estatística, lucro futuro ou adequação para operação real. O sistema continua sendo uma ferramenta de análise e paper trading.

## Cinco verificações P0

1. **Reconstrução limpa do banco:** as 19 migrations, de `202608260001` a `202608280019`, foram aplicadas em ordem num banco novo sem tocar a produção.
2. **Causalidade:** `causality_contract.sql` passou depois da carga de dados; o verificador local passou 5/5 testes e os testes Edge confirmaram que features antigas não mudam com candles futuros.
3. **Economia canônica:** `economic_contract.sql` retornou `economic contract v3: OK`; empate permanece no denominador e a política econômica é centralizada.
4. **Lacunas e abandono:** `gap_backfill_contract.sql` passou; a busca usa o candle exato, sem interpolar nem substituir pelo candle seguinte.
5. **Segurança deny-by-default:** `security_contract.sql` passou; os testes estáticos confirmaram que tabelas e RPCs privados não ficam disponíveis a `anon` ou `authenticated`.

## Testes locais

| Conjunto | Resultado |
| --- | ---: |
| Edge unitários | 18/18 |
| Causalidade local | 5/5 |
| Liquidação do histórico | 8/8 |
| Política do histórico | 11/11 |
| Snapshot do ranking | 8/8 |
| Fila do scanner | 3/3 |
| Contrato estático de segurança | OK |
| Calibração do score | 8/8 |

## Validação operacional das Edge Functions

- `bootstrap-data`, `market-cycle` e `train-challenger` foram implantadas com verificação de JWT ativa.
- Requisições internas exigiram simultaneamente papel de worker permitido e segredo dedicado; o segredo não foi incluído em arquivos, relatórios ou pacote de revisão.
- O Yahoo forneceu 2.500 candles AUD/USD M5, 2.178 M15 e 2.500 H1.
- O banco de teste terminou com 11.678 candles, 3 execuções do scanner, 6 registros de espera e 1 artefato de modelo.
- O `market-cycle` respondeu com `WAIT` durante mercado fechado/fim de semana. Isso é o comportamento seguro esperado, não falha do scanner.
- Não foram criadas decisões nem outcomes artificiais no teste apenas para produzir números favoráveis.

## Resultado do treinamento controlado

Escopo: AUD/USD, M5, 2.500 candles.

- Amostras rotuladas: 2.290
- Amostras direcionais: 1.754
- Empates: 536 (23,43%)
- Treino: 1.227 amostras, acurácia 53,14%, Brier 0,249037
- Validação temporal: 526 amostras, acurácia 54,56%, Brier 0,248749
- Brier base: 0,249565
- Melhora pareada: 0,000816
- Melhora exigida: 0,001388 (`1,5 × erro-padrão`)
- Resultado: `candidateUsable=false`

O candidato foi preservado como artefato não utilizável e não foi promovido. A trava de validação fez exatamente o que deveria: recusou uma melhora pequena demais para ser distinguida do ruído.

## Achados operacionais

### Binance bloqueada na região do teste

Chamadas da Edge Function para Binance retornaram HTTP 451 em todas as rotas tentadas. Forex via Yahoo funcionou. Antes de depender do backend para cripto, é necessário implementar e validar um provedor alternativo de servidor (por exemplo, Coinbase/Kraken quando o ativo permitir) ou executar o coletor numa região aceita pelo provedor. Não se deve transformar essa falha em candle sintético.

### Agendamentos não ativados

Os jobs recorrentes foram mantidos inativos no ambiente de teste porque a ativação requer valores no Vault e deve ser uma etapa operacional separada. As Functions e o banco estão validados; nenhum segredo foi colocado no repositório. Isso também evita consumir a cota gratuita continuamente durante a auditoria.

### Advisors

O Advisor de segurança mostra apenas avisos informativos `rls_enabled_no_policy`. Neste projeto isso é intencional: as tabelas privadas usam RLS sem policy para negar acesso direto, e o contrato automatizado confirmou a negação para `anon` e `authenticated`.

O Advisor de desempenho marca índices sem uso. Como o banco de teste acabou de ser criado e tem pouca atividade, esses avisos não justificam remover índices usados pelo desenho de produção.

## Limites da validação

- O teste confirma integridade técnica, não edge financeiro.
- Mercado fechado não permite observar sinais reais no ciclo online.
- Não houve 500 oportunidades independentes resolvidas para comparar challenger, champion e heurística.
- O filtro histórico de notícias continua limitado pela disponibilidade de calendário econômico causal.
- A produção não recebeu as migrations nem as Functions desta validação.

## Próxima decisão recomendada

Preservar o candidato recusado e coletar paper trades causais. Só considerar promoção quando ele superar simultaneamente champion e heurística em oportunidades independentes, depois de custos, com intervalo de confiança e drawdown aceitáveis. Não afrouxar as travas para obter um resultado visualmente melhor.
