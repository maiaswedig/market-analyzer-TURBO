import assert from 'node:assert/strict';

const targets = [
  ['https://market-analyzer-ia.vercel.app/PERPLEXITY-REVIEW.md', /Contrato de qualidade vigente: \*\*v4/, /oito de oito pontos aprovados/i],
  ['https://market-analyzer-ia.vercel.app/llms.txt', /2026-09-01/, /Nota A\/A\+ ordena qualidade técnica/],
  ['https://market-analyzer-ia.vercel.app/', /Market Analyzer/, /PERPLEXITY-REVIEW\.md/]
];

for (const [url, firstPattern, secondPattern] of targets) {
  const response = await fetch(url, { redirect: 'follow' });
  const body = await response.text();
  assert.equal(response.status, 200, `${url} respondeu ${response.status}`);
  assert.match(body, firstPattern, `${url} não contém a primeira marca da versão atual`);
  assert.match(body, secondPattern, `${url} não contém a segunda marca da versão atual`);
  console.log(`PASS ${url} (${body.length} caracteres)`);
}

console.log('Public documentation contract: OK');
