# Metodologia de calibração por ativo e tempo gráfico

## Regra de segurança

O aplicativo nunca escolhe um limiar olhando o mesmo trecho que usa para confirmar o resultado. A varredura divide cronologicamente as velas: os 70% mais antigos escolhem a candidata; os 30% mais recentes apenas confirmam ou rejeitam essa escolha. Uma configuração só é salva para `ATIVO|TF|E1`, `ATIVO|TF|E2` ou `ATIVO|TF|E3` quando há pelo menos 20 sinais em cada parte e expectativa líquida positiva na validação recente. Há ainda embargo de 1, 2 ou 3 velas entre a seleção e o holdout, conforme a expiração.

O limiar salvo só pode tornar a política única mais exigente. Por exemplo, uma calibração em BTC/M5 nunca reduz o mínimo de score definido pela política-base.

## Hipótese econômica vigente

A política única usa stake unitário, payout configurado pelo motor, custo adicional zero e a mesma regra de empate no backtest, no benchmark e no paper trading. Não existe mais um campo de custo na interface. Isso não afirma que uma corretora real seja isenta de spread ou slippage; apenas mantém a simulação atual coerente com a forma de uso informada. Políticas antigas com custo diferente continuam preservadas e não são reescritas.

## Empates / dojis

Empates não são removidos da amostra. O usuário informa se sua corretora considera empate como perda, reembolso ou acerto. A expectativa passa a considerar as três possibilidades (vitória, perda e empate), e a taxa de acerto mantém o empate no denominador. Isso evita que dojis sejam omitidos para elevar artificialmente a taxa e o EV.

## Assinatura da política

Um limiar salvo só é reutilizado se a assinatura da política coincidir. Ela inclui política-base, score, confluência, análogos, pesos/toggles, payout, stake, custo fixado em zero, regra de empate, histórico consultado e todas as travas de pavio, zona M15/H1, VSA, expiração, notícia e sessão. Mudar qualquer uma dessas regras pausa o limiar até um novo backtest.

## Parâmetros que exigem contexto

| Parâmetro | Papel | Política atual |
| --- | --- | --- |
| `scoreB0` / `scoreB1` | Transformam a confluência técnica em score. | São mantidos no processo de calibração já existente. |
| `maxDistance` | Limite de similaridade dos análogos históricos. | Não recebe ajuste global automático; deve ser comparado por `ATIVO|TF` em validação cronológica antes de qualquer alteração. |
| `minZoneAtr` | Tamanho mínimo de zona de suporte/resistência em ATR. | É uma proteção de qualidade de zona, não uma promessa de acerto; qualquer alteração deve ser testada por `ATIVO|TF`. |
| Limiar de score | Mínimo para emitir sinal. | É calibrado automaticamente pelo backtest walk-forward e salvo por `ATIVO|TF|E#` apenas após a validação recente. |

## Como revisar uma combinação

1. Escolha o ativo e o tempo gráfico que você realmente opera.
2. Rode o backtest do ativo.
3. Leia o resultado da validação recente, não apenas o desempenho do período antigo.
4. Só use o limiar que aparecer como confirmado. Se o sistema disser que não aplicou, mantenha a política-base e aumente a amostra antes de concluir algo.

Para pares Forex com filtro de notícias ligado, a agenda atual não é aplicada retroativamente ao passado. Sem uma agenda histórica versionada, o backtest permanece referência educativa e não transfere o limiar ao vivo.

Quando a política exige zonas fechadas de M15/H1, o relatório também mede a cobertura temporal desse contexto. O limiar só é transferível se pelo menos 95% das barras direcionais com resultado observável tiverem esse contexto disponível. Isso impede, por exemplo, que um backtest H4 com histórico menor de M15/H1 calibre o presente usando apenas o trecho final coberto.

O ranking de sinais reais e a referência de backtest permanecem separados para evitar que dados vistos somente depois influenciem uma decisão presente.

## Validação contínua na nuvem

A calibração do navegador e o laboratório cloud são sistemas separados. O frontend nunca importa estatísticas da nuvem como se fossem histórico local.

O backend atual treina somente o horizonte E1. Features são calculadas com candles disponíveis até `t`; o rótulo compara abertura e fechamento da vela seguinte. A divisão é cronológica, reserva no mínimo 300 observações recentes e purga uma observação na fronteira. O gate offline exige ganho pareado de Brier maior que `1,5 × erro-padrão` e diferença máxima de 8 pontos percentuais entre acurácia de treino e validação.

O primeiro artefato com amostra suficiente pode iniciar como baseline para tornar possível a medição futura. Se não vencer o baseline ingênuo, ele permanece explicitamente como avaliação baixa. Na comparação v2, heurística, champion e challenger escolhem independentemente `COMPRA`, `VENDA` ou `AGUARDAR`; não é permitido copiar a direção técnica para todos os modelos. A promoção exige 500 oportunidades únicas do modo neutro, 20 dias distintos, 100 operações do challenger e limite inferior de 95% do ΔEV por oportunidade positivo contra champion e heurística. O Brier não pode piorar e o drawdown permanece limitado a 1,20× a referência, com piso técnico para referência de drawdown zero.

E2 e E3 continuam disponíveis na análise local, mas não reutilizam a probabilidade cloud de E1. Cada horizonte precisará de rótulo, artefato, shadow e promoção próprios antes de ser habilitado no backend.
