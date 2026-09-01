// ml.js — regressão logística CALIBRADA treinada no navegador (sem bibliotecas).
// Padronização + regularização L2 + divisão CRONOLÓGICA (70% antigo / 30% recente, fora da amostra).
// Métricas: acurácia, logloss, Brier score, AUC e curva de calibração (decis).
// TRAVA: a probabilidade só é exibida/usada depois de 500 validações cronológicas
// e de uma melhora estatisticamente significativa sobre a taxa base do TREINO.
import { VECTOR_NAMES } from './features.js';
import { store } from './util.js';

const MODEL_KEY = 'ma_model_v2';
export const VALIDATION_POLICY_VERSION = 3;
export const FEATURE_SCHEMA_VERSION = 2;
export const MIN_VALIDATION_SAMPLES = 500;
const BRIER_Z = 1.645; // teste unilateral de 95%: o modelo precisa ser melhor, não só diferente.

function standardize(X) {
  const n = X.length, d = X[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < d; j++) std[j] += Math.pow(row[j] - mean[j], 2) / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  return { mean, std };
}
function applyStd(row, mean, std) { return row.map((v, j) => (v - mean[j]) / std[j]); }
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function metrics(X, y, w, b) {
  const n = X.length;
  if (!n) return { n: 0, acc: null, logloss: null, auc: null, brier: null, reliability: [] };
  let correct = 0, ll = 0, brier = 0;
  const preds = [];
  for (let i = 0; i < n; i++) {
    let z = b;
    for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
    const p = sigmoid(z);
    preds.push({ p, y: y[i] });
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
    ll += -(y[i] * Math.log(Math.max(1e-9, p)) + (1 - y[i]) * Math.log(Math.max(1e-9, 1 - p)));
    brier += Math.pow(p - y[i], 2);
  }
  // curva de confiabilidade em decis de probabilidade prevista
  const bins = Array.from({ length: 10 }, (_, k) => ({ from: k / 10, to: (k + 1) / 10, n: 0, sumP: 0, hits: 0 }));
  for (const pr of preds) {
    const k = Math.min(9, Math.floor(pr.p * 10));
    bins[k].n++; bins[k].sumP += pr.p; bins[k].hits += pr.y;
  }
  const reliability = bins.map(b2 => ({
    faixa: `${(b2.from * 100).toFixed(0)}–${(b2.to * 100).toFixed(0)}%`,
    n: b2.n, previsto: b2.n ? b2.sumP / b2.n : null, realizado: b2.n ? b2.hits / b2.n : null
  }));
  const sorted = preds.slice().sort((a, b2) => a.p - b2.p);
  const pos = sorted.filter(p => p.y === 1).length, neg = n - pos;
  let rankSum = 0;
  sorted.forEach((p, idx) => { if (p.y === 1) rankSum += idx + 1; });
  const auc = (pos && neg) ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : null;
  return { n, acc: correct / n, logloss: ll / n, auc, brier: brier / n, reliability, baseRate: pos / n };
}

/**
 * @param samples [{vector, label}] em ordem cronológica
 * @param opts { epochs, lr, l2, minValid, onProgress }
 */
export async function trainLogistic(samples, { epochs = 400, lr = 0.15, l2 = 0.006, minValid = MIN_VALIDATION_SAMPLES, onProgress } = {}) {
  const clean = samples.filter(s => s.vector.every(v => Number.isFinite(v)) && (s.label === 0 || s.label === 1));
  // A reserva é sempre os 30% mais recentes. Não reduzimos o mínimo pedido pelo
  // chamador abaixo de 500, pois isso tornaria a regra estatística inconsistente.
  const effectiveMinValid = Math.max(MIN_VALIDATION_SAMPLES, Math.min(500, Math.round(Number(minValid) || MIN_VALIDATION_SAMPLES)));
  const minTotal = Math.ceil(effectiveMinValid / 0.30);
  if (clean.length < minTotal) return {
    ok: false,
    reason: `amostras insuficientes para validação rigorosa (${clean.length}; mínimo ${minTotal} para reservar ${effectiveMinValid} candles recentes)`
  };
  const split = Math.floor(clean.length * 0.7);
  const train = clean.slice(0, split), valid = clean.slice(split);
  const { mean, std } = standardize(train.map(s => s.vector));
  const Xtr = train.map(s => applyStd(s.vector, mean, std)), ytr = train.map(s => s.label);
  const Xva = valid.map(s => applyStd(s.vector, mean, std)), yva = valid.map(s => s.label);
  const d = Xtr[0].length;
  let w = new Array(d).fill(0), b = 0;

  for (let ep = 0; ep < epochs; ep++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < Xtr.length; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Xtr[i][j];
      const err = sigmoid(z) - ytr[i];
      for (let j = 0; j < d; j++) gw[j] += err * Xtr[i][j];
      gb += err;
    }
    const m = Xtr.length;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / m + l2 * w[j]);
    b -= lr * (gb / m);
    // não travar a interface: cede o controle a cada 10 épocas
    if (ep % 10 === 0) {
      if (onProgress) onProgress((ep + 1) / epochs);
      await new Promise(r => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => r()) : setTimeout(r, 0)));
    }
  }

  const trainMetrics = metrics(Xtr, ytr, w, b);
  const validMetrics = metrics(Xva, yva, w, b);
  // A referência é calculada APENAS com a taxa observada no treino. Usar a taxa
  // da própria validação daria ao baseline informação do futuro.
  const baselineProbability = ytr.reduce((sum, y) => sum + y, 0) / ytr.length;
  const brierDiffs = [];
  let baseLoss = 0;
  for (let i = 0; i < Xva.length; i++) {
    let z = b;
    for (let j = 0; j < w.length; j++) z += w[j] * Xva[i][j];
    const p = sigmoid(z);
    const modelLoss = Math.pow(p - yva[i], 2);
    const baselineLoss = Math.pow(baselineProbability - yva[i], 2);
    baseLoss += baselineLoss;
    brierDiffs.push(modelLoss - baselineLoss);
  }
  const baseRate = baselineProbability;
  const baseBrier = brierDiffs.length ? baseLoss / brierDiffs.length : null;
  const brierDelta = brierDiffs.length ? brierDiffs.reduce((sum, value) => sum + value, 0) / brierDiffs.length : null;
  let brierSE = null;
  if (brierDiffs.length > 1 && brierDelta !== null) {
    const variance = brierDiffs.reduce((sum, value) => sum + Math.pow(value - brierDelta, 2), 0) / (brierDiffs.length - 1);
    brierSE = Math.sqrt(variance / brierDiffs.length);
  }
  const brierRequiredMargin = brierSE === null ? null : BRIER_Z * brierSE;
  const weights = w.map((v, j) => ({ name: VECTOR_NAMES[j] || `f${j}`, weight: v })).sort((a, b2) => Math.abs(b2.weight) - Math.abs(a.weight));
  const overfit = trainMetrics.acc !== null && validMetrics.acc !== null && (trainMetrics.acc - validMetrics.acc) > 0.08;

  const gates = [];
  const gEnough = validMetrics.n >= effectiveMinValid;
  gates.push({ ok: gEnough, text: `amostras de validação ${validMetrics.n} ${gEnough ? '≥' : '<'} mínimo ${effectiveMinValid}` });
  const gBrier = brierDelta !== null && brierSE !== null && brierDelta + BRIER_Z * brierSE < 0;
  gates.push({
    ok: gBrier,
    text: `Brier ${validMetrics.brier === null ? '—' : validMetrics.brier.toFixed(4)} vs. base ${baseBrier === null ? '—' : baseBrier.toFixed(4)} · ganho ${brierDelta === null ? '—' : (-brierDelta).toFixed(4)} precisa superar margem estatística ${(brierRequiredMargin ?? 0).toFixed(4)}`
  });
  const usable = gEnough && gBrier;
  const gateReason = usable ? null : gates.filter(g => !g.ok).map(g => g.text).join(' · ');

  const model = {
    ok: true, w, b, mean, std, trainMetrics, validMetrics, weights, overfit,
    baseRate, baselineProbability, baseBrier, brierDelta, brierSE, brierZ: BRIER_Z, brierRequiredMargin,
    validationPolicyVersion: VALIDATION_POLICY_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION, gates, gateReason, usable,
    trainedAt: Date.now(), samples: clean.length, minValid: effectiveMinValid
  };
  if (onProgress) onProgress(1);
  return model;
}

export function predict(model, vector) {
  if (!model || !model.ok) return null;
  let z = model.b;
  const x = vector.map((v, j) => (v - model.mean[j]) / model.std[j]);
  for (let j = 0; j < model.w.length; j++) z += model.w[j] * x[j];
  return sigmoid(z);
}

/**
 * Modelos aprovados por regras antigas são mantidos para auditoria, mas nunca
 * entram numa decisão. Isso força um retreino com a política estatística atual.
 */
export function normalizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  if (model.validationPolicyVersion === VALIDATION_POLICY_VERSION && model.featureSchemaVersion === FEATURE_SCHEMA_VERSION) {
    const hasTieRate = model.tieRate !== null && model.tieRate !== undefined && Number.isFinite(Number(model.tieRate)) && Number(model.tieRate) >= 0 && Number(model.tieRate) <= 1;
    if (model.overfit) return { ...model, usable: false, gateReason: model.gateReason || 'modelo em observação: diferença excessiva entre treino e validação' };
    // Esta versão prevê apenas a direção entre candles não neutros. Sem a taxa
    // de empate do mesmo treino não há como convertê-la para a probabilidade
    // incondicional da operação, portanto o modelo fica só para auditoria.
    if (!hasTieRate) return { ...model, usable: false, gateReason: 'modelo sem taxa de empate do mesmo treino: retreino necessário' };
    return model;
  }
  return {
    ...model,
    usable: false,
    gateReason: 'modelo de versão anterior: retreine para aplicar a validação cronológica e o esquema atual de indicadores',
    validationPolicyVersion: model.validationPolicyVersion || 1,
    featureSchemaVersion: model.featureSchemaVersion || 1
  };
}

export function saveModel(key, model) {
  if (!model || !model.ok) return;
  store.set(MODEL_KEY + '_' + key, {
    ok: true, w: model.w, b: model.b, mean: model.mean, std: model.std,
    trainMetrics: model.trainMetrics, validMetrics: model.validMetrics,
    weights: model.weights.slice(0, 10), overfit: model.overfit, usable: model.usable,
    baseRate: model.baseRate, baselineProbability: model.baselineProbability, baseBrier: model.baseBrier,
    brierDelta: model.brierDelta, brierSE: model.brierSE, brierZ: model.brierZ,
    brierRequiredMargin: model.brierRequiredMargin, validationPolicyVersion: model.validationPolicyVersion, featureSchemaVersion: model.featureSchemaVersion,
    tieRate: model.tieRate, tieSamples: model.tieSamples,
    gates: model.gates, gateReason: model.gateReason, trainedAt: model.trainedAt,
    samples: model.samples, minValid: model.minValid
  });
}
export function loadModel(key) { return normalizeModel(store.get(MODEL_KEY + '_' + key, null)); }
