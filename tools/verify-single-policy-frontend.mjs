import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const app = read('js/signal-ai.js');
const api = read('js/cloud-api.js');
const marketCycle = read('supabase/functions/market-cycle/index.ts');
const cssFiles = ['theme.css', 'styles.css', 'enhancements.css', 'ui-accessibility.css', 'market-analyzer.css'].map(read);

assert.doesNotMatch(html, /id="operationModes"|id="operationCost"|modo de operação/i);
assert.match(html, /id="workspaceDetails"/);
assert.match(html, /class="advanced-settings"/);
assert.match(html, /theme\.css/);
assert.equal(cssFiles.reduce((sum, css) => sum + (css.match(/:root\s*\{/g) || []).length, 0), 1, 'tema deve ter um único :root');
assert.match(app, /state\.mode = 'neutro'/);
assert.match(app, /state\.operationCost = 0/);
assert.match(app, /IntersectionObserver/);
assert.match(api, /cloud_single_paper_summary/);
assert.match(api, /cloud_single_quality_paper_summary/);
assert.match(marketCycle, /const MODES:[^\n]+\["neutro"\]/);
assert.match(cssFiles.join('\n'), /@media \(max-width:767px\)[\s\S]*\.responsive-table/);
assert.match(html, /data-empty="true"/);

console.log('Single-policy frontend contract: OK');
