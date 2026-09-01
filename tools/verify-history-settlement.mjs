import assert from 'node:assert/strict';
import { latestResolvedRecord, settlePendingRecords, settlementTimes } from '../js/history-settlement.js';

const tfMs = 300_000;
const entryAt = Date.UTC(2026, 7, 28, 12, 0, 0);
const records = [{
  id: 'BTCUSDT|M5|test', asset: 'BTCUSDT', tf: 'M5', expiryCandles: 2,
  entryCandleAt: entryAt, direction: 1, outcome: 'PENDENTE', createdAt: entryAt - 10_000
}];
const times = settlementTimes(records[0], tfMs);
assert.equal(times.targetCandleAt, entryAt + tfMs);
assert.equal(times.expiresAt, entryAt + 2 * tfMs);

const candles = [
  { t: entryAt, o: 100, c: 99, live: false },
  { t: entryAt + tfMs, o: 99, c: 104, live: false }
];
assert.equal(settlePendingRecords(records, { assetId: 'BTCUSDT', tfKey: 'M5', timeframeMs: tfMs, candles, now: times.expiresAt - 1 }).length, 0, 'não pode resolver antes da expiração');
const changed = settlePendingRecords(records, { assetId: 'BTCUSDT', tfKey: 'M5', timeframeMs: tfMs, candles, now: times.expiresAt, source: 'teste' });
assert.equal(changed.length, 1);
assert.equal(records[0].outcome, 'ACERTO');
assert.equal(records[0].resolutionMethod, 'exact-closed-candles');
assert.equal(settlePendingRecords(records, { assetId: 'BTCUSDT', tfKey: 'M5', timeframeMs: tfMs, candles, now: times.expiresAt + tfMs }).length, 0, 'resultado final não pode ser reescrito');

const missingExact = [{ asset: 'EURUSD', tf: 'M5', expiryCandles: 1, entryCandleAt: entryAt, direction: -1, outcome: 'PENDENTE' }];
assert.equal(settlePendingRecords(missingExact, {
  assetId: 'EURUSD', tfKey: 'M5', timeframeMs: tfMs,
  candles: [{ t: entryAt + tfMs, o: 100, c: 90, live: false }], now: entryAt + 2 * tfMs
}).length, 0, 'não pode substituir a vela exata por uma posterior');

const history = [
  { outcome: 'ERRO', resolvedAt: 10 },
  { outcome: 'PENDENTE', createdAt: 30 },
  { outcome: 'ACERTO', resolvedAt: 20 }
];
assert.equal(latestResolvedRecord(history).outcome, 'ACERTO', 'último resultado deve ignorar o sinal ainda pendente');

console.log('History settlement: 8/8 verificações passaram.');
