import { assertNoLookahead } from '../js/backtest.js';
import { historicalProbability } from '../js/probability.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function candles(count) {
  const start = Date.UTC(2026, 0, 1);
  let price = 100;
  return Array.from({ length: count }, (_, index) => {
    const open = price;
    price += Math.sin(index / 9) * 0.35 + 0.025;
    const close = price;
    return {
      t: start + index * 60_000,
      o: open,
      h: Math.max(open, close) + 0.22,
      l: Math.min(open, close) - 0.22,
      c: close,
      v: 100 + index % 23,
      live: false
    };
  });
}

const causal = assertNoLookahead(candles(300), true, [220, 245, 280, 295]);
assert(causal.checks.length === 4, 'a auditoria local não cobriu todos os cortes solicitados');
assert(causal.ok, `feature local mudou após anexar futuro: ${JSON.stringify(causal.checks)}`);

const buckets = { trend: 1, struct: 1, rsi: 1, macd: 1 };
const notYetKnown = { i: 249, buckets, futureDir: { 3: 1 } };
const current = { i: 250, buckets };
const probability = historicalProbability([notYetKnown], current, {
  horizon: 3,
  minSamples: 1,
  maxDistance: 10,
  relax: false
});
assert(probability.samples === 0 && probability.insufficient,
  'analogia histórica consumiu um rótulo cuja expiração ainda não havia fechado');

console.log(`Local causality contract: ${causal.checks.length + 1}/${causal.checks.length + 1} passed`);
