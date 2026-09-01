import { performance } from 'node:perf_hooks';
import { ASSETS } from '../js/assets.js';
import { analyzeAsset, DEFAULT_SETTINGS } from '../js/analyze.js';
import { clearCache } from '../js/data.js';

const assets = ASSETS.filter(asset => asset.group === 'Cripto').slice(0, 2);
const tfKey = process.argv[2] || 'M5';
const historyTarget = Math.max(1500, Number(process.argv[3]) || 3000);

clearCache();
const startedAt = performance.now();
const rows = await Promise.all(assets.map(asset => analyzeAsset(asset, tfKey, {
  ...DEFAULT_SETTINGS,
  deepCandles: 10000,
  newsFilter: false
}, {
  light: false,
  historyTarget,
  includeLive: true
})));
const elapsedMs = performance.now() - startedAt;

console.log(JSON.stringify({
  assets: rows.map(row => ({
    id: row.asset.id,
    candles: row.totalCandles,
    analyzed: row.candleCount,
    verdict: row.verdict,
    source: row.sources?.[tfKey]?.source || null,
    dataError: !!row.dataError
  })),
  timeframe: tfKey,
  historyTarget,
  elapsedMs: Math.round(elapsedMs),
  averageMsPerAsset: Math.round(elapsedMs / Math.max(1, rows.length))
}, null, 2));
