import { rankedOpportunitySnapshot } from '../js/opportunity-selection.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = {
  asset: { id: 'BTCUSDT', name: 'BTC/USDT' },
  result: {
    tfKey: 'M5',
    at: 1_787_800_000_000,
    verdict: 'CALL',
    score: { score: 90, direction: 1 },
    grade: { grade: 'A' },
    snapshot: { t: 1_787_799_700_000, price: 100 },
    decision: { verdict: 'AGUARDAR', blocked: true }
  }
};

const opened = rankedOpportunitySnapshot([source], 'BTCUSDT', 'M5', 99);
assert(opened && opened.rank === 1, 'posição do ranking não foi preservada');
assert(opened.result.verdict === 'CALL', 'direção exibida no ranking foi trocada');
assert(opened.result.score.score === 90, 'força foi recalculada ao abrir');
assert(opened.result.grade.grade === 'A', 'nota foi recalculada ao abrir');
assert(opened.result.snapshot.t === source.result.snapshot.t, 'fotografia temporal foi trocada');
assert(opened.result.openedFromScanner === true, 'origem do ranking não foi identificada');
assert(opened.result.scannerSnapshotAt === source.result.at, 'horário original não foi preservado');
assert(rankedOpportunitySnapshot([source], 'ETHUSDT', 'M5') === null, 'ativo ausente deveria exigir nova análise');

console.log('Ranking snapshot contract: 8/8 passed');
