import assert from 'node:assert/strict';
import { readCandlePage } from '../supabase/functions/_shared/candle-reader.ts';
let calls = 0;
const params = [];
const client = { rpc: async (name, args) => {
  assert.equal(name, 'worker_closed_candles'); params.push(args);
  return ++calls === 1 ? { error: { code: '57014', message: 'statement timeout' } }
    : { data: [{ open_time: '2026-09-01T00:00:00Z' }] };
}};
assert.equal((await readCandlePage(client, 'BTCUSDT', 'M5', 320, 1000, '2026-09-02T00:00:00Z')).length, 1);
assert.equal(calls, 2); assert.deepEqual(params[0], params[1]);
calls = 0;
await assert.rejects(readCandlePage({rpc: async () => { calls++; return {error:{code:'42501',message:'permission denied'}}; }}, 'X', 'M5', 1));
assert.equal(calls, 1, 'Authorization errors must not retry');
calls = 0;
await assert.rejects(readCandlePage({rpc: async () => { calls++; return {error:{code:'57014',message:'timeout'}}; }}, 'X', 'M5', 1));
assert.equal(calls, 2, 'Transient retries must remain bounded');
console.log('Candle reader: retry bounds, unchanged page arguments and authorization handling passed');
