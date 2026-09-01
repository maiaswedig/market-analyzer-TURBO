import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  calibrateCategoryWeights,
  calibrateScoreScale,
  normalizeCategoryWeight,
  scoreFromBias,
  WEIGHT_CATEGORY_ORDER,
  WEIGHT_FINAL_Z,
  WEIGHT_SELECTION_Z,
} from '../js/score-calibration.js';
import { DEFAULT_WEIGHTS } from '../js/score.js';

assert.equal(scoreFromBias(0.06, 0, 0.06, 0.45), 50);
assert.equal(scoreFromBias(0.45, 0, 0.06, 0.45), 100);
assert.equal(scoreFromBias(-0.45, 10, 0.06, 0.45), 90);

const start = Date.UTC(2026, 0, 1);
const rows = Array.from({ length: 600 }, (_, index) => {
  const bias = index % 5 === 0 ? 0.10 : index % 2 ? 0.52 : -0.52;
  const directional = Math.abs(bias) > 0.3;
  return {
    t: start + index * 300_000,
    bias,
    penalties: 0,
    eligibleWithoutScore: true,
    result: directional ? (index % 7 === 0 ? 'ERRO' : 'ACERTO') : (index % 2 ? 'ACERTO' : 'ERRO'),
  };
});
const report = calibrateScoreScale(rows, {
  payout: 0.85,
  stake: 1,
  operationCost: 0.02,
  tiePolicy: 'loss',
  minCalibrationSignals: 80,
  minValidationSignals: 40,
});
assert.equal(report.methodology, 'chronological calibration/embargo/untouched validation');
assert.equal(report.calibrationRows + report.validationRows + report.purgeBars * 2, report.totalRows);
assert(report.selectedOnCalibration, 'a janela de calibração deveria produzir candidato');
assert(report.validation && report.validation.signals >= 40, 'o holdout deveria ter amostra suficiente');
assert.equal(report.deploymentRule.includes('diagnostic only'), true, 'o calibrador não pode promover automaticamente');

const normalized = normalizeCategoryWeight(DEFAULT_WEIGHTS, 'tendencia', 1.3);
assert(Math.abs(Object.values(normalized).reduce((sum, value) => sum + value, 0) - 100) < 1e-7,
  'cada candidato deve somar exatamente 100');
assert.equal(normalized.tendencia, 28.6, 'a categoria escolhida deve permanecer no valor candidato');

const replayTimes = Array.from({ length: 2_800 }, (_, index) => start + index * 300_000);
const fakeReplay = (_context, _cfg, opts = {}) => ({
  bars: replayTimes
    .filter(t => (opts.startT === undefined || t >= opts.startT) && (opts.endT === undefined || t <= opts.endT))
    .map((t, index) => ({
      t,
      verdict: 'CALL',
      result: index % 5 < 3 ? 'ACERTO' : 'ERRO',
    })),
});
const weightReport = calibrateCategoryWeights({
  replayTimes,
  baseCfg: { weights: DEFAULT_WEIGHTS },
}, {
  replay: fakeReplay,
  payout: 0.85,
  stake: 1,
  operationCost: 0,
  tiePolicy: 'loss',
  selectionWindows: 4,
  purgeBars: 3,
});
assert.equal(weightReport.candidatesEvaluated, 35, 'a contagem deve refletir as 7 × 5 avaliações realmente executadas');
assert.equal(weightReport.maxCandidateEvaluations, 35);
assert.equal(weightReport.selection.z, WEIGHT_SELECTION_Z, 'a busca deve declarar z=2,58');
assert.equal(weightReport.finalHoldout.z, WEIGHT_FINAL_Z, 'o holdout único deve declarar z=1,96');
assert.equal(weightReport.selection.windows.length, 4);
assert.equal(weightReport.selection.categoryReports.map(item => item.category).join(','), WEIGHT_CATEGORY_ORDER.join(','),
  'a ordem de negócio deve ser explícita e auditável');
assert.equal(weightReport.finalHoldout.candidateEvaluations, 1, 'o holdout final recebe um único candidato');
assert.equal(weightReport.finalHoldout.retuningAllowed, false, 'o holdout queimado nunca pode ser reutilizado para ajuste');
assert.equal(weightReport.accepted, false, 'pesos sem melhora sobre o default não podem ser aceitos');
assert(weightReport.finalHoldout.failureReasons.length > 0, 'uma rejeição final precisa explicar os motivos');

const backtestSource = fs.readFileSync(new URL('../js/backtest.js', import.meta.url), 'utf8');
assert.match(backtestSource, /newsHistoricalUnavailable:\s*historicalNewsUnavailable/,
  'o relatório do backtest deve usar a variável causal de indisponibilidade histórica');
assert.doesNotMatch(backtestSource, /^\s*newsHistoricalUnavailable,\s*$/m,
  'o calibrador não pode quebrar ao referenciar um identificador inexistente');
const cliSource = fs.readFileSync(new URL('./calibrate-score.mjs', import.meta.url), 'utf8');
assert.match(cliSource, /result\.meta\.newsHistoricalUnavailable/,
  'a adoção deve ser bloqueada quando o filtro histórico de notícias não puder ser reproduzido');
assert.match(cliSource, /notCalibratedHere/,
  'o relatório deve declarar que não calibra pesos internos');
assert.match(cliSource, /mode === 'weights'/,
  'a CLI deve preservar o modo atual e oferecer a calibração de pesos explicitamente');
assert.match(backtestSource, /export async function buildReplayContext/,
  'o estágio caro precisa ser exportado e reutilizável');
assert.match(backtestSource, /export function replayWithConfig/,
  'o replay barato precisa ser exportado e reutilizável');

console.log('Score calibration contract: 25/25 verificações passaram.');
