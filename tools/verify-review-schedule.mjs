import assert from 'node:assert/strict';
import { reviewScope } from '../supabase/functions/_shared/review-schedule.ts';
import { TIMEFRAMES } from '../supabase/functions/_shared/types.ts';
const assets = ['ZZZ', 'AAA', 'BBB'].map(symbol => ({ symbol }));
const n = assets.length * Object.keys(TIMEFRAMES).length;
const seen = new Set();
for (let i = 0; i < n; i++) {
  const now = (1000 + i) * 300000;
  const a = reviewScope(assets, now);
  assert.deepEqual(a, reviewScope([...assets].reverse(), now + 299999));
  seen.add(`${a.asset.symbol}|${a.timeframe}`);
}
assert.equal(seen.size, n, 'Every active asset/timeframe must be reviewed');
assert.equal(reviewScope([], Date.now()), null);
assert.deepEqual(reviewScope(assets, 0), reviewScope(assets, n * 300000));
console.log('Review rotation: coverage, order independence, boundaries and empty list passed');
