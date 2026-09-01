# Entrega — GitHub conectado à Vercel

Data de corte: 01/09/2026.

## Estado publicado

- Aplicação: `https://market-analyzer-ia.vercel.app/`
- Repositório: `https://github.com/maiaswedig/market-analyzer-TURBO`
- Branch de produção: `main`
- Projeto Vercel: `market-analyzer-ia`
- Primeiro deploy conectado: commit `078f735`, estado `Ready`, produção, duração informada de 2 segundos.

## Integridade da entrega

- O repositório contém 161 arquivos do projeto.
- Não foram incluídos `.env`, `node_modules`, metadados `.git` da origem nem segredos administrativos.
- Uma cópia limpa do repositório foi clonada novamente e comparada com a entrega local. Após normalizar exclusivamente finais de linha Windows/Unix, a comparação encontrou zero divergências.
- Estão presentes frontend, documentação, motor local, Edge Functions, 27 migrations, contratos SQL e ferramentas de calibração/verificação.

## Publicação e SEO

- Vercel é a hospedagem e o domínio canônico vigentes.
- `canonical` e `og:url` usam `https://market-analyzer-ia.vercel.app/`.
- `robots.txt`, `sitemap.xml` e `llms.txt` usam o domínio Vercel.
- `vercel.json` define os cabeçalhos da publicação principal.
- `netlify.toml` foi preservado somente como alternativa de recuperação; sua presença não indica deploy dual ativo nem canonical Netlify.

## Aceite no navegador

- A página carregou o sinal oficial congelado pelo backend Supabase.
- Não existem seletor conservador/neutro/agressivo nem campo de custo adicional.
- Não houve rolagem horizontal na verificação desktop.
- O console não apresentou erro originado pelo site; os únicos avisos observados pertenciam a uma extensão do navegador.
- `llms.txt` publicado contém o domínio Vercel e não contém o antigo domínio Netlify.

## Limites desta entrega

Esta publicação não altera o motor estatístico, não promove modelo, não recalcula histórico e não comprova vantagem econômica. Os snapshots de ledger são fotografias datadas; devem ser regenerados para uma auditoria futura, porque o backend continua acumulando decisões e resultados.
