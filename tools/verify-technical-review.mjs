import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTechnicalReview } from './generate-technical-review.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'technical-review-runtime-snapshot.json'), 'utf8'));
const actual = fs.readFileSync(path.join(root, 'PERPLEXITY-REVIEW.md'), 'utf8');
const expected = buildTechnicalReview();
const migrations = fs.readdirSync(path.join(root, 'supabase', 'migrations')).filter((name) => name.endsWith('.sql')).sort();
const confirmedContract = path.join(root, 'supabase', 'tests', 'confirmed_quality_contract.sql');
const singlePolicyContract = path.join(root, 'supabase', 'tests', 'single_policy_contract.sql');

assert.equal(actual, expected, 'PERPLEXITY-REVIEW.md está diferente do gerador');
assert.equal(snapshot.migrationsApplied, migrations.length, 'snapshot declara quantidade errada de migrations');
assert.equal(migrations.at(-1), '202609010027_single_policy_zero_cost.sql', 'migration da política única deixou de ser a última esperada');
assert.ok(fs.existsSync(confirmedContract), 'contrato SQL da qualidade v4 não foi encontrado');
assert.ok(fs.existsSync(singlePolicyContract), 'contrato SQL da política única não foi encontrado');
assert.match(actual, /oito de oito pontos aprovados/i);
assert.match(actual, /Nenhum caminho transforma A\/A\+ em `confirmed`/);
assert.match(actual, /ainda não comprovou vantagem líquida sobre o benchmark/i);
assert.match(actual, /custo adicional zero/i);
assert.doesNotMatch(actual, /Lista só até a migration `013`/i);

console.log(`Technical review contract: OK (${migrations.length} migrations, snapshot ${snapshot.verifiedAt})`);
