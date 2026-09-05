import { FEATURE_SCHEMA_VERSION, VALIDATION_POLICY_VERSION } from "./features.ts";
import type { LogisticArtifact } from "./types.ts";

export interface TrainingSample {
  at: number;
  vector: number[];
  label: 0 | 1;
}

export interface TrainingOptions {
  minValidation?: number;
  epochs?: number;
  learningRate?: number;
  l2?: number;
  zMargin?: number;
  tieRate?: number;
}

export interface TrainingResult {
  ok: boolean;
  reason?: string;
  artifact?: LogisticArtifact;
  gates?: Array<{ ok: boolean; name: string; detail: string }>;
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

function moments(rows: number[][]) {
  const width = rows[0]?.length || 0;
  const mean = new Array<number>(width).fill(0);
  const std = new Array<number>(width).fill(0);
  for (const row of rows) for (let index = 0; index < width; index++) mean[index] += row[index] / rows.length;
  for (const row of rows) for (let index = 0; index < width; index++) std[index] += Math.pow(row[index] - mean[index], 2) / rows.length;
  for (let index = 0; index < width; index++) std[index] = Math.sqrt(std[index]) || 1;
  return { mean, std };
}

function standardize(row: number[], mean: number[], std: number[]): number[] {
  return row.map((value, index) => (value - mean[index]) / (std[index] || 1));
}

function probability(row: number[], weights: number[], bias: number): number {
  let value = bias;
  for (let index = 0; index < weights.length; index++) value += weights[index] * row[index];
  return sigmoid(value);
}

function metrics(rows: number[][], labels: number[], weights: number[], bias: number) {
  let correct = 0;
  let brier = 0;
  let logloss = 0;
  const predictions: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    const predicted = probability(rows[index], weights, bias);
    const label = labels[index];
    predictions.push(predicted);
    if ((predicted >= 0.5 ? 1 : 0) === label) correct++;
    brier += Math.pow(predicted - label, 2);
    logloss -= label * Math.log(Math.max(1e-12, predicted)) + (1 - label) * Math.log(Math.max(1e-12, 1 - predicted));
  }
  return {
    n: rows.length,
    accuracy: rows.length ? correct / rows.length : null,
    brier: rows.length ? brier / rows.length : null,
    logloss: rows.length ? logloss / rows.length : null,
    predictions,
  };
}

function fitWindow(train: TrainingSample[], validation: TrainingSample[], options: TrainingOptions) {
  const width = train[0].vector.length;
  const { mean, std } = moments(train.map((sample) => sample.vector));
  const trainRows = train.map((sample) => standardize(sample.vector, mean, std));
  const validationRows = validation.map((sample) => standardize(sample.vector, mean, std));
  const trainLabels = train.map((sample) => sample.label);
  const validationLabels = validation.map((sample) => sample.label);
  const weights = new Array<number>(width).fill(0);
  let bias = 0;
  const epochs = Math.max(20, Math.min(160, Math.round(options.epochs || 80)));
  const learningRate = Math.max(0.005, Math.min(0.5, Number(options.learningRate ?? 0.08)));
  const l2 = Math.max(0, Math.min(0.1, Number(options.l2 ?? 0.006)));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = new Array<number>(width).fill(0);
    let biasGradient = 0;
    for (let rowIndex = 0; rowIndex < trainRows.length; rowIndex++) {
      const predicted = probability(trainRows[rowIndex], weights, bias);
      const error = predicted - trainLabels[rowIndex];
      for (let column = 0; column < width; column++) gradient[column] += error * trainRows[rowIndex][column];
      biasGradient += error;
    }
    for (let column = 0; column < width; column++) {
      weights[column] -= learningRate * (gradient[column] / trainRows.length + l2 * weights[column]);
    }
    bias -= learningRate * biasGradient / trainRows.length;
  }
  return {
    mean, std, weights, bias,
    trainRows, validationRows, trainLabels, validationLabels,
    trainMetrics: metrics(trainRows, trainLabels, weights, bias),
    validationMetrics: metrics(validationRows, validationLabels, weights, bias),
  };
}

function evaluateWalkForward(samples: TrainingSample[], options: TrainingOptions) {
  const windowCount = 3;
  const minValidation = Math.max(300, Math.round(options.minValidation || 300));
  const windowSamples = Math.max(200, Math.ceil(minValidation * 2 / 3));
  const initialTrain = samples.length - windowCount * windowSamples - 1;
  if (initialTrain < 400) {
    return {
      passed: false,
      reason: `amostras insuficientes para 3 janelas: treino inicial ${Math.max(0, initialTrain)}/400`,
      windowSamples,
      windows: [],
    };
  }
  const payout = 0.85;
  const operationCost = 0;
  const tieRate = Math.max(0, Math.min(1, Number(options.tieRate) || 0));
  const windows = [];
  for (let index = 0; index < windowCount; index++) {
    const validationStart = samples.length - (windowCount - index) * windowSamples;
    const validationEnd = validationStart + windowSamples;
    // One purged observation prevents the last E1 training target from sharing
    // the first validation feature candle.
    const train = samples.slice(0, Math.max(0, validationStart - 1));
    const validation = samples.slice(validationStart, validationEnd);
    const fitted = fitWindow(train, validation, options);
    let pnl = 0;
    let trades = 0;
    let wins = 0;
    for (let row = 0; row < validation.length; row++) {
      const up = fitted.validationMetrics.predictions[row];
      const direction = up >= 0.5 ? 1 : 0;
      const directionalProbability = direction === 1 ? up : 1 - up;
      const winProbability = directionalProbability * (1 - tieRate);
      const expectedEv = winProbability * payout - (1 - winProbability) - operationCost;
      if (expectedEv <= 0) continue;
      trades++;
      const won = validation[row].label === direction;
      if (won) wins++;
      pnl += won ? payout - operationCost : -1 - operationCost;
    }
    const minimumTrades = Math.max(50, Math.ceil(validation.length * 0.10));
    windows.push({
      index: index + 1,
      trainFrom: new Date(train[0].at).toISOString(),
      trainTo: new Date(train.at(-1)!.at).toISOString(),
      validationFrom: new Date(validation[0].at).toISOString(),
      validationTo: new Date(validation.at(-1)!.at).toISOString(),
      trainSamples: train.length,
      validationSamples: validation.length,
      trades,
      minimumTrades,
      coverage: trades / validation.length,
      wins,
      winRate: trades ? wins / trades : null,
      evPerOpportunity: pnl / validation.length,
      evPerTrade: trades ? pnl / trades : null,
      passed: trades >= minimumTrades && pnl / validation.length >= 0,
    });
  }
  return {
    passed: windows.length === windowCount && windows.every((window) => window.passed),
    reason: "requires non-negative EV/opportunity and minimum coverage in all 3 expanding walk-forward windows",
    windowSamples,
    payout,
    operationCost,
    tieRate,
    windows,
  };
}

export function trainChronological(rawSamples: TrainingSample[], options: TrainingOptions = {}): TrainingResult {
  const samples = rawSamples
    .filter((sample) => sample && (sample.label === 0 || sample.label === 1) && sample.vector.length > 0 && sample.vector.every(Number.isFinite))
    .slice()
    .sort((a, b) => a.at - b.at);
  const width = samples[0]?.vector.length || 0;
  if (!width || samples.some((sample) => sample.vector.length !== width)) return { ok: false, reason: "vetores ausentes ou com dimensões diferentes" };

  const minValidation = Math.max(300, Math.round(options.minValidation || 300));
  const minimumTotal = Math.ceil(minValidation / 0.30);
  if (samples.length < minimumTotal) {
    return { ok: false, reason: `amostras direcionais insuficientes: ${samples.length}/${minimumTotal} para reservar ao menos ${minValidation} na validação` };
  }

  const validationCount = Math.max(minValidation, Math.floor(samples.length * 0.30));
  const split = samples.length - validationCount;
  // Purga uma observação na fronteira: o rótulo E1 do último item de treino
  // não pode compartilhar a vela-alvo com a primeira feature de validação.
  const train = samples.slice(0, Math.max(0, split - 1));
  const validation = samples.slice(split);
  if (train.length < 400 || validation.length < minValidation) return { ok: false, reason: "divisão cronológica deixou uma das janelas pequena demais" };

  const fitted = fitWindow(train, validation, options);
  const { mean, std, weights, bias, trainLabels, validationLabels, trainMetrics, validationMetrics } = fitted;
  const baselineProbability = trainLabels.reduce((sum, label) => sum + label, 0) / trainLabels.length;
  const differences: number[] = [];
  let baselineBrier = 0;
  for (let index = 0; index < validationLabels.length; index++) {
    const label = validationLabels[index];
    const modelLoss = Math.pow(validationMetrics.predictions[index] - label, 2);
    const baselineLoss = Math.pow(baselineProbability - label, 2);
    differences.push(modelLoss - baselineLoss);
    baselineBrier += baselineLoss;
  }
  baselineBrier /= validationLabels.length;
  const meanDifference = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const variance = differences.length > 1
    ? differences.reduce((sum, value) => sum + Math.pow(value - meanDifference, 2), 0) / (differences.length - 1)
    : Number.POSITIVE_INFINITY;
  const standardError = Math.sqrt(variance / differences.length);
  const zMargin = Math.max(1.5, Number(options.zMargin ?? 1.5));
  const improvement = -meanDifference;
  const requiredImprovement = zMargin * standardError;
  const overfitGap = Number(trainMetrics.accuracy || 0) - Number(validationMetrics.accuracy || 0);
  const walkForward = evaluateWalkForward(samples, options);
  const gates = [
    { ok: validation.length >= minValidation, name: "validation-size", detail: `${validation.length} >= ${minValidation}` },
    { ok: improvement > requiredImprovement, name: "paired-brier", detail: `ganho ${improvement.toFixed(6)} > ${zMargin.toFixed(2)}*SE ${requiredImprovement.toFixed(6)}` },
    { ok: overfitGap <= 0.08, name: "overfit-gap", detail: `diferença treino-validação ${overfitGap.toFixed(4)} <= 0.0800` },
    { ok: walkForward.passed, name: "walk-forward-3-windows", detail: walkForward.reason },
  ];
  const usable = gates.every((gate) => gate.ok);
  const artifact: LogisticArtifact = {
    algorithm: "logistic-regression",
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    validationPolicyVersion: VALIDATION_POLICY_VERSION,
    decisionPolicyVersion: 2,
    weights,
    bias,
    mean,
    std,
    tieRate: Math.max(0, Math.min(1, Number(options.tieRate) || 0)),
    trainedAt: new Date().toISOString(),
    trainFrom: new Date(train[0].at).toISOString(),
    trainTo: new Date(train[train.length - 1].at).toISOString(),
    validationFrom: new Date(validation[0].at).toISOString(),
    validationTo: new Date(validation[validation.length - 1].at).toISOString(),
    samples: samples.length,
    validationSamples: validation.length,
    metrics: {
      train: { n: trainMetrics.n, accuracy: trainMetrics.accuracy, brier: trainMetrics.brier, logloss: trainMetrics.logloss },
      validation: { n: validationMetrics.n, accuracy: validationMetrics.accuracy, brier: validationMetrics.brier, logloss: validationMetrics.logloss },
      baselineProbability,
      baselineBrier,
      pairedBrierImprovement: improvement,
      pairedBrierSE: standardError,
      requiredImprovement,
      zMargin,
      overfitGap,
      walkForward,
      gates,
    },
    usable,
  };
  return { ok: true, artifact, gates };
}
