import assert from 'node:assert/strict';
import { buildReplayContext, replayWithConfig, runBacktest } from '../js/backtest.js';
import { DEFAULT_SETTINGS } from '../js/analyze.js';

const start = Date.UTC(2025, 0, 1);
const candles = Array.from({ length: 1_100 }, (_, index) => {
  const base = 100 + index * 0.012 + Math.sin(index / 11) * 1.8;
  const open = base + Math.sin(index / 5) * 0.18;
  const close = base + Math.cos(index / 7) * 0.22;
  return {
    t: start + index * 300_000,
    o: open,
    h: Math.max(open, close) + 0.35,
    l: Math.min(open, close) - 0.35,
    c: close,
    v: 900 + (index % 31) * 17,
  };
});
const asset = { id: 'TESTUSDT', symbol: 'TEST/USDT', group: 'Cripto', kind: 'binance' };
const dataOverride = {
  candles,
  hasVolume: true,
  source: 'deterministic-test',
  aggregatedFrom: null,
};
const settings = {
  ...DEFAULT_SETTINGS,
  deepCandles: candles.length,
  newsFilter: false,
  minSetupSamples: Number.MAX_SAFE_INTEGER,
};
const opts = { maxTests: 260, dataOverride };
const withoutPresentationTimestamps = value => {
  if (Array.isArray(value)) return value.map(withoutPresentationTimestamps);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = key === 'equity' && Array.isArray(item)
      ? item.map(point => ({ ...point, t: 0 }))
      : withoutPresentationTimestamps(item);
  }
  return out;
};

const context = await buildReplayContext(asset, 'M5', settings, opts);
assert(Object.isFrozen(context), 'o contexto superior deve ser imutável');
assert(Object.isFrozen(context.contexts), 'os contextos causais devem ser imutáveis');

const first = replayWithConfig(context);
const second = replayWithConfig(context);
assert.deepEqual(withoutPresentationTimestamps(second), withoutPresentationTimestamps(first),
  'replays repetidos no mesmo contexto não podem carregar ponteiros mutáveis');

const composed = await runBacktest(asset, 'M5', settings, opts);
assert.deepEqual(withoutPresentationTimestamps(composed), withoutPresentationTimestamps(first),
  'runBacktest deve continuar equivalente à composição buildReplayContext + replayWithConfig');

const precomputedContext = await buildReplayContext(asset, 'M5', settings, { ...opts, precomputeHistorical: true });
assert.equal(precomputedContext.historicalConfig.precomputed, true, 'o modo de calibração deve pré-calcular E1/E2/E3 uma vez');
const precomputed = replayWithConfig(precomputedContext);
assert.deepEqual(withoutPresentationTimestamps(precomputed), withoutPresentationTimestamps(first),
  'a analogia histórica pré-calculada deve ser idêntica ao cálculo normal');

const midpoint = context.replayTimes[Math.floor(context.replayTimes.length / 2)];
const older = replayWithConfig(context, {}, { endT: midpoint });
const newer = replayWithConfig(context, {}, { startT: midpoint + 1 });
assert(older.bars.every(bar => bar.t <= midpoint), 'endT deve manter o holdout fechado');
assert(newer.bars.every(bar => bar.t > midpoint), 'startT deve isolar uma janela independente');

const forexAsset = { id: 'EURUSD', symbol: 'EUR/USD', group: 'Forex', kind: 'yahoo' };
const forexSettings = {
  ...settings,
  newsFilter: true,
  newsBlockBeforeMin: 5,
  newsBlockAfterMin: 5,
  higherTfZoneFilter: false,
};
const completeCalendar = async points => ({
  requested: points.length,
  covered: points.length,
  errors: [],
  snapshots: points.map((point, index) => ({
    key: point.key,
    knownAt: point.knownAt,
    fetchedAt: point.knownAt - 60_000,
    source: 'causal-test',
    status: 'ready',
    events: index === 0 ? [{
      at: point.from + 5 * 60_000,
      currency: 'USD',
      title: 'High impact fixture',
      impact: 'high',
      source: 'causal-test',
    }] : [],
  })),
});
const completeContext = await buildReplayContext(forexAsset, 'M5', forexSettings, {
  ...opts,
  historicalCalendarOverride: completeCalendar,
});
const completeReplay = replayWithConfig(completeContext);
assert.equal(completeReplay.meta.newsHistoricalUnavailable, false,
  'cobertura completa deve habilitar o filtro histórico causal');
assert.equal(completeReplay.meta.newsCoverage.ratio, 1,
  'cobertura histórica completa deve ser reportada como 100%');
assert(completeReplay.bars.some(bar => bar.newsBlocked && bar.newsSnapshotAt !== null),
  'evento conhecido no instante da decisão deve bloquear a janela correspondente');

const incompleteContext = await buildReplayContext(forexAsset, 'M5', forexSettings, {
  ...opts,
  historicalCalendarOverride: async points => {
    const loaded = await completeCalendar(points);
    loaded.snapshots.pop();
    loaded.covered--;
    return loaded;
  },
});
const incompleteReplay = replayWithConfig(incompleteContext);
assert.equal(incompleteReplay.meta.newsHistoricalUnavailable, true,
  'uma única lacuna deve impedir a mistura de políticas no replay');
assert(incompleteReplay.bars.every(bar => !bar.newsBlocked && bar.newsSnapshotAt === null),
  'snapshots parciais devem ser descartados, não aplicados seletivamente');

console.log('Backtest replay contract: 14 verificações passaram.');
