import { clamp } from './util.js';
import { tieNet, normalizeTiePolicy } from './decision.js';
import { DEFAULT_WEIGHTS } from './score.js';
import { replayWithConfig } from './backtest.js';

export const WEIGHT_CATEGORY_ORDER = Object.freeze([
  'tendencia', 'momentum', 'multitf', 'priceaction', 'sr', 'volatilidade', 'volume'
]);
export const WEIGHT_FACTORS = Object.freeze([0.7, 0.85, 1, 1.15, 1.3]);
export const WEIGHT_SELECTION_Z = 2.58;
export const WEIGHT_FINAL_Z = 1.96;

export function scoreFromBias(bias, penalties, b0, b1) {
  const low = Math.max(0, Number(b0) || 0);
  const high = Math.max(low + 1e-6, Number(b1) || 0);
  const strength = clamp((Math.abs(Number(bias) || 0) - low) / (high - low), 0, 1);
  return clamp(50 + 50 * strength - Math.max(0, Number(penalties) || 0), 0, 100);
}

function pnlFor(result, { payout, stake, operationCost, tiePolicy }) {
  if (result === 'ACERTO') return stake * payout - operationCost;
  if (result === 'NEUTRO') return tieNet(payout, stake, operationCost, tiePolicy);
  return -(stake + operationCost);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleSd(values, average) {
  if (values.length < 2 || average === null) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

export function evaluateScoreScale(rows, params, economics) {
  const selected = rows.filter(row =>
    row && row.eligibleWithoutScore && Number.isFinite(Number(row.bias)) && row.result &&
    scoreFromBias(row.bias, row.penalties, params.b0, params.b1) >= params.minScore
  );
  const pnls = selected.map(row => pnlFor(row.result, economics));
  const ev = mean(pnls);
  const sd = sampleSd(pnls, ev);
  const evLb95 = ev === null || sd === null ? null : ev - 1.96 * sd / Math.sqrt(pnls.length);
  const ties = selected.filter(row => row.result === 'NEUTRO').length;
  const tieRate = selected.length ? ties / selected.length : 0;
  const randomWin = (1 - tieRate) / 2;
  const randomLoss = randomWin;
  const benchmarkEv = randomWin * (economics.stake * economics.payout - economics.operationCost)
    + randomLoss * (-(economics.stake + economics.operationCost))
    + tieRate * tieNet(economics.payout, economics.stake, economics.operationCost, economics.tiePolicy);
  return {
    b0: params.b0,
    b1: params.b1,
    minScore: params.minScore,
    signals: selected.length,
    coverage: rows.length ? selected.length / rows.length : 0,
    ties,
    tieRate,
    ev,
    evLb95,
    benchmarkEv,
    edgeVsBenchmark: ev === null ? null : ev - benchmarkEv,
  };
}

function candidates(grid = {}) {
  const b0Values = grid.b0Values || [0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14];
  const b1Values = grid.b1Values || [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65];
  const minScores = grid.minScores || [58, 62, 66, 70, 74];
  const out = [];
  for (const b0 of b0Values) for (const b1 of b1Values) for (const minScore of minScores) {
    if (b1 >= b0 + 0.15) out.push({ b0, b1, minScore });
  }
  return out;
}

/**
 * Selects B0/B1 only on the older calibration window and opens the recent
 * validation window once. The returned candidate is diagnostic and is never
 * written to settings automatically.
 */
export function calibrateScoreScale(rows, options = {}) {
  const chronological = [...rows]
    .filter(row => row && Number.isFinite(Number(row.t)) && row.result)
    .sort((a, b) => a.t - b.t);
  const validationFraction = clamp(Number(options.validationFraction) || 0.35, 0.20, 0.50);
  const purgeBars = Math.max(1, Math.round(Number(options.purgeBars) || 3));
  const split = Math.floor(chronological.length * (1 - validationFraction));
  const calibration = chronological.slice(0, Math.max(0, split - purgeBars));
  const validation = chronological.slice(Math.min(chronological.length, split + purgeBars));
  const economics = {
    payout: Math.max(0, Number(options.payout) || 0.85),
    stake: Math.max(0.000001, Number(options.stake) || 1),
    operationCost: Math.max(0, Number(options.operationCost) || 0),
    tiePolicy: normalizeTiePolicy(options.tiePolicy),
  };
  const minCalibrationSignals = Math.max(30, Math.round(Number(options.minCalibrationSignals) || 100));
  const minValidationSignals = Math.max(30, Math.round(Number(options.minValidationSignals) || 60));
  const ranked = candidates(options.grid)
    .map(params => evaluateScoreScale(calibration, params, economics))
    .filter(item => item.signals >= minCalibrationSignals && item.evLb95 !== null)
    .sort((a, b) =>
      (b.evLb95 - a.evLb95) || (b.edgeVsBenchmark - a.edgeVsBenchmark) || (b.signals - a.signals)
    );
  const selected = ranked[0] || null;
  const validationResult = selected ? evaluateScoreScale(validation, selected, economics) : null;
  const defaultParams = {
    b0: Number(options.defaultB0) || 0.06,
    b1: Number(options.defaultB1) || 0.45,
    minScore: Number(options.defaultMinScore) || 62,
  };
  const defaultValidation = evaluateScoreScale(validation, defaultParams, economics);
  const accepted = !!validationResult
    && validationResult.signals >= minValidationSignals
    && validationResult.evLb95 !== null
    && validationResult.evLb95 > validationResult.benchmarkEv
    && validationResult.ev !== null
    && (defaultValidation.ev === null || validationResult.ev > defaultValidation.ev);
  return {
    methodology: 'chronological calibration/embargo/untouched validation',
    totalRows: chronological.length,
    calibrationRows: calibration.length,
    validationRows: validation.length,
    purgeBars,
    minCalibrationSignals,
    minValidationSignals,
    selectedOnCalibration: selected,
    validation: validationResult,
    defaultValidation,
    accepted,
    deploymentRule: 'diagnostic only; persist per asset|timeframe only after independent review',
    topCalibrationCandidates: ranked.slice(0, 10),
  };
}

function roundedWeight(value) {
  return Math.round(Number(value) * 1e8) / 1e8;
}

export function normalizeCategoryWeight(weights, category, factor) {
  if (!WEIGHT_CATEGORY_ORDER.includes(category)) throw new Error(`categoria de peso desconhecida: ${category}`);
  const base = Object.fromEntries(WEIGHT_CATEGORY_ORDER.map(key => [key, Math.max(0, Number(weights && weights[key]) || 0)]));
  const total = WEIGHT_CATEGORY_ORDER.reduce((sum, key) => sum + base[key], 0);
  if (!(total > 0)) throw new Error('os pesos precisam ter soma positiva');
  for (const key of WEIGHT_CATEGORY_ORDER) base[key] = base[key] / total * 100;

  const fixed = clamp(base[category] * Math.max(0, Number(factor) || 0), 0, 99.999999);
  const otherTotal = 100 - base[category];
  const out = {};
  for (const key of WEIGHT_CATEGORY_ORDER) {
    out[key] = key === category
      ? fixed
      : (otherTotal > 0 ? base[key] * (100 - fixed) / otherTotal : 0);
  }
  for (const key of WEIGHT_CATEGORY_ORDER) out[key] = roundedWeight(out[key]);
  const correctionKey = [...WEIGHT_CATEGORY_ORDER].reverse().find(key => key !== category);
  const correction = roundedWeight(100 - WEIGHT_CATEGORY_ORDER.reduce((sum, key) => sum + out[key], 0));
  out[correctionKey] = roundedWeight(out[correctionKey] + correction);
  return Object.freeze(out);
}

function replayEconomics(bars, economics, z) {
  const selected = bars.filter(bar => bar && bar.verdict !== 'AGUARDAR' && bar.result);
  const pnls = selected.map(row => pnlFor(row.result, economics));
  const ev = mean(pnls);
  const sd = sampleSd(pnls, ev);
  const standardError = sd === null ? null : sd / Math.sqrt(pnls.length);
  const evLowerBound = ev === null || standardError === null ? null : ev - z * standardError;
  const ties = selected.filter(row => row.result === 'NEUTRO').length;
  const tieRate = selected.length ? ties / selected.length : 0;
  const randomWin = (1 - tieRate) / 2;
  const benchmarkEv = randomWin * (economics.stake * economics.payout - economics.operationCost)
    + randomWin * (-(economics.stake + economics.operationCost))
    + tieRate * tieNet(economics.payout, economics.stake, economics.operationCost, economics.tiePolicy);
  return {
    signals: selected.length,
    wins: selected.filter(row => row.result === 'ACERTO').length,
    losses: selected.filter(row => row.result === 'ERRO').length,
    ties,
    tieRate,
    ev,
    sampleSd: sd,
    standardError,
    z,
    confidenceApprox: z === WEIGHT_SELECTION_Z ? 0.99 : z === WEIGHT_FINAL_Z ? 0.95 : null,
    evLowerBound,
    evLb: evLowerBound,
    evLb99: z === WEIGHT_SELECTION_Z ? evLowerBound : null,
    evLb95: z === WEIGHT_FINAL_Z ? evLowerBound : null,
    benchmarkEv,
    edgeVsBenchmark: ev === null ? null : ev - benchmarkEv,
    lowerBoundEdgeVsBenchmark: evLowerBound === null ? null : evLowerBound - benchmarkEv,
  };
}

function buildWeightWindowPlan(context, options) {
  const times = [...(context.replayTimes || [])].filter(Number.isFinite).sort((a, b) => a - b);
  const k = Math.max(4, Math.min(6, Math.round(Number(options.selectionWindows) || 4)));
  const purgeBars = Math.max(1, Math.round(Number(options.purgeBars) || 3));
  const finalFraction = clamp(Number(options.finalHoldoutFraction) || 0.25, 0.15, 0.40);
  if (times.length < k * 2 + purgeBars * k + 2) throw new Error('histórico insuficiente para dividir seleção e holdout final');

  const finalStartIndex = Math.max(1, Math.min(times.length - 1, Math.floor(times.length * (1 - finalFraction))));
  const selectionEndExclusive = Math.max(0, finalStartIndex - purgeBars);
  const gaps = purgeBars * (k - 1);
  const usableSelection = selectionEndExclusive - gaps;
  if (usableSelection < k) throw new Error('histórico insuficiente depois dos embargos entre janelas');
  const baseSize = Math.floor(usableSelection / k);
  let remainder = usableSelection - baseSize * k;
  let cursor = 0;
  const selection = [];
  for (let index = 0; index < k; index++) {
    const size = baseSize + (remainder-- > 0 ? 1 : 0);
    const startIndex = cursor;
    const endIndex = cursor + size - 1;
    selection.push(Object.freeze({
      index: index + 1,
      startT: times[startIndex],
      endT: times[endIndex],
      candidateBars: size,
    }));
    cursor = endIndex + 1 + (index < k - 1 ? purgeBars : 0);
  }
  return Object.freeze({
    selection: Object.freeze(selection),
    final: Object.freeze({
      startT: times[finalStartIndex],
      endT: times[times.length - 1],
      candidateBars: times.length - finalStartIndex,
    }),
    totalBars: times.length,
    selectionWindows: k,
    purgeBars,
    finalHoldoutFraction: finalFraction,
    embargoBeforeFinal: purgeBars,
  });
}

function evaluateWeightsOnWindows(context, weights, windows, economics, z, replay) {
  return windows.map(window => {
    const result = replay(context, { weights }, { startT: window.startT, endT: window.endT, includeSummary: false });
    return {
      ...window,
      ...replayEconomics(result.bars, economics, z),
    };
  });
}

function sameWeights(left, right) {
  return WEIGHT_CATEGORY_ORDER.every(key => Math.abs(Number(left[key]) - Number(right[key])) < 1e-7);
}

function referenceResult(context, weights, window, economics, replay) {
  const result = replay(context, { weights }, { startT: window.startT, endT: window.endT, includeSummary: false });
  return replayEconomics(result.bars, economics, WEIGHT_FINAL_Z);
}

/**
 * Fase A: calibra somente os sete pesos de categoria. A busca usa janelas
 * independentes e z=2,58; o holdout recente é aberto uma única vez, depois da
 * busca, com z=1,96. O resultado é diagnóstico e nunca altera configuração.
 */
export function calibrateCategoryWeights(context, options = {}) {
  if (!context || !Array.isArray(context.replayTimes)) throw new Error('contexto de replay inválido');
  const replay = typeof options.replay === 'function' ? options.replay : replayWithConfig;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const selectionZ = WEIGHT_SELECTION_Z;
  const finalZ = WEIGHT_FINAL_Z;
  const minSelectionSignals = Math.max(200, Math.round(Number(options.minSelectionSignals) || 200));
  const minFinalSignals = Math.max(300, Math.round(Number(options.minFinalSignals) || 300));
  const economics = {
    payout: Math.max(0, Number(options.payout) || 0.85),
    stake: Math.max(0.000001, Number(options.stake) || 1),
    operationCost: Math.max(0, Number(options.operationCost) || 0),
    tiePolicy: normalizeTiePolicy(options.tiePolicy),
  };
  const plan = buildWeightWindowPlan(context, options);
  const initialWeights = normalizeCategoryWeight(options.startWeights || DEFAULT_WEIGHTS, 'tendencia', 1);
  const defaultWeights = normalizeCategoryWeight(DEFAULT_WEIGHTS, 'tendencia', 1);
  const productionWeights = normalizeCategoryWeight(options.productionWeights || context.baseCfg?.weights || DEFAULT_WEIGHTS, 'tendencia', 1);
  let currentWeights = initialWeights;
  let candidatesEvaluated = 0;
  const categoryReports = [];

  for (const category of WEIGHT_CATEGORY_ORDER) {
    const candidateReports = [];
    const orderedFactors = [1, ...WEIGHT_FACTORS.filter(factor => factor !== 1)];
    for (const factor of orderedFactors) {
      const weights = normalizeCategoryWeight(currentWeights, category, factor);
      const windows = evaluateWeightsOnWindows(context, weights, plan.selection, economics, selectionZ, replay);
      candidatesEvaluated++;
      onProgress(candidatesEvaluated / (WEIGHT_CATEGORY_ORDER.length * WEIGHT_FACTORS.length),
        `Avaliando ${category} × ${factor} (${candidatesEvaluated}/${WEIGHT_CATEGORY_ORDER.length * WEIGHT_FACTORS.length})`);
      candidateReports.push({ factor, weights, windows });
    }
    candidateReports.sort((a, b) => WEIGHT_FACTORS.indexOf(a.factor) - WEIGHT_FACTORS.indexOf(b.factor));
    const baseline = candidateReports.find(candidate => candidate.factor === 1);
    const insufficient = candidateReports.some(candidate => candidate.windows.some(window => window.signals < minSelectionSignals));
    for (const candidate of candidateReports) {
      candidate.windowComparisons = candidate.windows.map((window, index) => {
        const baselineWindow = baseline.windows[index];
        const sampleEnough = window.signals >= minSelectionSignals;
        const beatsBenchmark = sampleEnough && window.evLowerBound !== null && window.evLowerBound > window.benchmarkEv;
        const beatsCurrent = sampleEnough && window.ev !== null && baselineWindow.ev !== null && window.ev > baselineWindow.ev;
        return {
          window: window.index,
          sampleEnough,
          beatsBenchmark,
          beatsCurrent,
          evImprovementVsCurrent: window.ev === null || baselineWindow.ev === null ? null : window.ev - baselineWindow.ev,
        };
      });
      candidate.passesAllWindows = candidate.factor !== 1 && !insufficient
        && candidate.windowComparisons.every(item => item.sampleEnough && item.beatsBenchmark && item.beatsCurrent);
      const improvements = candidate.windowComparisons.map(item => item.evImprovementVsCurrent).filter(Number.isFinite);
      candidate.minEvImprovement = improvements.length ? Math.min(...improvements) : null;
      candidate.meanEvImprovement = improvements.length ? mean(improvements) : null;
    }
    const eligible = candidateReports.filter(candidate => candidate.passesAllWindows)
      .sort((a, b) => (b.minEvImprovement - a.minEvImprovement) || (b.meanEvImprovement - a.meanEvImprovement));
    const chosen = eligible[0] || null;
    const before = currentWeights;
    if (chosen) currentWeights = chosen.weights;
    categoryReports.push({
      category,
      priority: WEIGHT_CATEGORY_ORDER.indexOf(category) + 1,
      status: insufficient ? 'skipped_insufficient_sample' : chosen ? 'adopted_for_final_test' : 'kept_current',
      reason: insufficient
        ? `ao menos uma das ${plan.selectionWindows} janelas ficou abaixo de ${minSelectionSignals} sinais; o mínimo não foi reduzido`
        : chosen
          ? `fator ${chosen.factor} venceu benchmark e pesos correntes em todas as janelas`
          : 'nenhum candidato venceu benchmark e pesos correntes em todas as janelas',
      weightsBefore: before,
      weightsAfter: currentWeights,
      chosenFactor: chosen ? chosen.factor : null,
      candidates: candidateReports,
    });
  }

  // Somente agora o período mais recente é aberto. O candidato final é único;
  // defaults e produção são referências, não novos candidatos de busca.
  const finalCandidate = referenceResult(context, currentWeights, plan.final, economics, replay);
  onProgress(1, 'Confirmando o único candidato no holdout final…');
  const finalDefault = referenceResult(context, defaultWeights, plan.final, economics, replay);
  const finalProduction = sameWeights(productionWeights, defaultWeights)
    ? finalDefault
    : referenceResult(context, productionWeights, plan.final, economics, replay);
  const finalFailureReasons = [];
  if (sameWeights(currentWeights, initialWeights)) finalFailureReasons.push('nenhuma categoria superou os gates da camada de seleção');
  if (finalCandidate.signals < minFinalSignals) finalFailureReasons.push(`holdout final tem ${finalCandidate.signals} sinais; mínimo preservado: ${minFinalSignals}`);
  if (finalCandidate.evLowerBound === null || !(finalCandidate.evLowerBound > finalCandidate.benchmarkEv)) {
    finalFailureReasons.push('limite inferior de 95% do EV não supera o benchmark no holdout final');
  }
  if (finalDefault.ev === null || finalCandidate.ev === null || !(finalCandidate.ev > finalDefault.ev)) {
    finalFailureReasons.push('EV do candidato não supera DEFAULT_WEIGHTS no holdout final');
  }
  if (finalProduction.ev === null || finalCandidate.ev === null || !(finalCandidate.ev > finalProduction.ev)) {
    finalFailureReasons.push('EV do candidato não supera os pesos atuais de produção no holdout final');
  }
  const accepted = finalFailureReasons.length === 0;

  return {
    methodology: 'coordinate ascent / independent chronological windows / purge embargo / single untouched final holdout',
    scope: 'Fase A: somente pesos de categoria; coeficientes internos permanecem fixos',
    categoryOrder: [...WEIGHT_CATEGORY_ORDER],
    factors: [...WEIGHT_FACTORS],
    initialWeights,
    candidateWeights: currentWeights,
    defaultWeights,
    productionWeights,
    candidatesEvaluated,
    maxCandidateEvaluations: WEIGHT_CATEGORY_ORDER.length * WEIGHT_FACTORS.length,
    selection: {
      z: selectionZ,
      confidenceApprox: 0.99,
      multipleComparisonProtection: true,
      minSignalsPerWindow: minSelectionSignals,
      windows: plan.selection,
      categoryReports,
    },
    finalHoldout: {
      z: finalZ,
      confidenceApprox: 0.95,
      minSignals: minFinalSignals,
      window: plan.final,
      candidateEvaluations: 1,
      candidate: finalCandidate,
      defaultReference: finalDefault,
      productionReference: finalProduction,
      accepted,
      failureReasons: finalFailureReasons,
      retuningAllowed: false,
    },
    purgeBars: plan.purgeBars,
    selectionWindows: plan.selectionWindows,
    accepted,
    deploymentRule: 'diagnostic only; manual review required; never promote or rewrite defaults automatically',
    notCalibratedHere: ['coeficientes internos de indicadores', 'limiares RSI/ATR/SR', 'modelo ML', 'heurística de direção'],
  };
}
