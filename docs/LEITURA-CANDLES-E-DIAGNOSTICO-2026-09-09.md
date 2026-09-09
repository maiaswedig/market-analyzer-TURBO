# Leitura de candles e diagnóstico de relógio

A consulta anterior filtrava `timeframe::text`, dificultando o aproveitamento do
índice composto. A RPC privada `worker_closed_candles` converte o parâmetro para
o enum e filtra diretamente ativo/timeframe, com ordem e limite no banco.
O endpoint é acessível somente por service_role e limita páginas a 1.000 linhas.

Scanner, treino e bootstrap usam essa leitura. A paginação mantém o limite
superior da primeira página, para novas velas não deslocarem as páginas seguintes.
Uma falha transitória de leitura pode repetir a mesma página uma vez após 250 ms.
Erros de autorização e de contrato não são repetidos. Escritas não são repetidas.

A rejeição de timestamp futuro conserva sua condição original. Agora os detalhes
mostram horário de abertura, horário observado, horário do banco e diferenças em
milissegundos. Isso permite distinguir vela futura de divergência de relógios.
Nenhum timestamp foi ajustado nem a proteção de causalidade enfraquecida.

Verificações: 32 testes Edge aprovados; teste do leitor confirma limite de retry
e ausência de retry em erro de permissão. Contrato SQL compara 320 timestamps com
a leitura anterior e verifica restrições de acesso e tamanho de página.
A leitura direta de 320 candles em produção levou 4,923 ms em uma medição; esse
valor não inclui rede e não garante a mesma latência sob qualquer carga.

Implantação: migration 20260909143128; market-cycle v15, train-challenger v8,
bootstrap-data v7. Ainda é necessário observar timeouts de recuperação de lacunas
e dados dos provedores: estas mudanças não garantem ausência de falhas externas.
