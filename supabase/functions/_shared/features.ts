import { candleProgress, signalClock } from "./time.ts";
import type { AssessmentFamily, AssessmentStatus, Candle, DecisionAssessment, DecisionAssessmentCheck, FeatureRow, MarketDecision, MarketRegime, ModelPrediction, StoredModel, Timeframe } from "./types.ts";

export const FEATURE_SCHEMA_VERSION = "signal-atlas-cloud-core-v1";
export const VALIDATION_POLICY_VERSION = 3;
export const ENGINE_POLICY_VERSION = 1;
export const INDEPENDENT_DECISION_POLICY_VERSION = 2;
export const MIN_WARMUP = 210;

export const FEATURE_NAMES = Object.freeze([
  "ema_alignment",
  "price_minus_ema21_atr",
  "ema9_minus_ema21_atr",
  "ema21_minus_ema50_atr",
  "price_minus_ema200_atr",
  "rsi_centered",
  "rsi_slope",
  "macd_histogram_atr",
  "atr_percent_price",
  "relative_volume",
  "body_ratio",
  "range_atr",
  "bollinger_percent_b",
  "momentum_5_atr",
]);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const safe = (value: number | null | undefined, fallback = 0) => Number.isFinite(value) ? Number(value) : fallback;

function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const output = new Array<number>(values.length);
  output[0] = values[0];
  for (let index = 1; index < values.length; index++) output[index] = values[index] * alpha + output[index - 1] * (1 - alpha);
  return output;
}

function rsi(values: number[], period = 14): Array<number | null> {
  const output = new Array<number | null>(values.length).fill(null);
  if (values.length <= period) return output;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index++) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  output[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let index = period + 1; index < values.length; index++) {
    const change = values[index] - values[index - 1];
    gain = (gain * (period - 1) + Math.max(0, change)) / period;
    loss = (loss * (period - 1) + Math.max(0, -change)) / period;
    output[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return output;
}

function atr(candles: Candle[], period = 14): Array<number | null> {
  const output = new Array<number | null>(candles.length).fill(null);
  if (candles.length <= period) return output;
  const trueRanges = candles.map((candle, index) => {
    if (!index) return candle.high - candle.low;
    const priorClose = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - priorClose), Math.abs(candle.low - priorClose));
  });
  let value = trueRanges.slice(1, period + 1).reduce((sum, item) => sum + item, 0) / period;
  output[period] = value;
  for (let index = period + 1; index < candles.length; index++) {
    value = (value * (period - 1) + trueRanges[index]) / period;
    output[index] = value;
  }
  return output;
}

function rollingMean(values: number[], period: number, excludeCurrent = false): Array<number | null> {
  const output = new Array<number | null>(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index++) {
    if (excludeCurrent) {
      if (index > 0) sum += values[index - 1];
      if (index > period) sum -= values[index - 1 - period];
      if (index >= period) output[index] = sum / period;
    } else {
      sum += values[index];
      if (index >= period) sum -= values[index - period];
      if (index >= period - 1) output[index] = sum / period;
    }
  }
  return output;
}

function rollingStd(values: number[], period: number, means: Array<number | null>): Array<number | null> {
  const output = new Array<number | null>(values.length).fill(null);
  for (let index = period - 1; index < values.length; index++) {
    const mean = means[index];
    if (mean === null) continue;
    let variance = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor++) variance += Math.pow(values[cursor] - mean, 2) / period;
    output[index] = Math.sqrt(variance);
  }
  return output;
}

function sortedCandles(candles: Candle[]): Candle[] {
  return candles.slice().sort((a, b) => a.openTime - b.openTime);
}

function percentileRank(values: Array<number | null>, index: number, lookback = 100): number | null {
  const current = values[index];
  if (current === null || !Number.isFinite(current)) return null;
  const sample = values.slice(Math.max(0, index - lookback + 1), index + 1)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (sample.length < 20) return null;
  return 100 * sample.filter((value) => value <= current).length / sample.length;
}

function trendEfficiency(candles: Candle[], index: number, period = 20): number {
  const start = Math.max(0, index - period);
  let travelled = 0;
  for (let cursor = start + 1; cursor <= index; cursor++) {
    travelled += Math.abs(candles[cursor].close - candles[cursor - 1].close);
  }
  return travelled > 0 ? Math.abs(candles[index].close - candles[start].close) / travelled : 0;
}

function structureDirection(candles: Candle[], index: number, lookback = 80): number {
  const slice = candles.slice(Math.max(0, index - lookback + 1), index + 1);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let cursor = 2; cursor < slice.length - 2; cursor++) {
    let isHigh = true;
    let isLow = true;
    for (let offset = cursor - 2; offset <= cursor + 2; offset++) {
      if (offset === cursor) continue;
      if (slice[offset].high >= slice[cursor].high) isHigh = false;
      if (slice[offset].low <= slice[cursor].low) isLow = false;
    }
    if (isHigh) highs.push(slice[cursor].high);
    if (isLow) lows.push(slice[cursor].low);
  }
  const risingHigh = highs.length >= 2 && highs.at(-1)! > highs.at(-2)!;
  const risingLow = lows.length >= 2 && lows.at(-1)! > lows.at(-2)!;
  const fallingHigh = highs.length >= 2 && highs.at(-1)! < highs.at(-2)!;
  const fallingLow = lows.length >= 2 && lows.at(-1)! < lows.at(-2)!;
  if (risingHigh && risingLow) return 2;
  if (fallingHigh && fallingLow) return -2;
  if (risingLow && !fallingHigh) return 1;
  if (fallingHigh && !risingLow) return -1;
  return 0;
}

export function classifyMarketRegime(input: {
  emaAlignment: number;
  adxLike: number;
  atrPercentile: number | null;
  bbBandwidth: number;
  bbBwPercentile: number | null;
  structureDir: number;
}): MarketRegime {
  if (input.atrPercentile !== null && input.atrPercentile > 88) return "alta volatilidade";
  if (input.bbBwPercentile !== null && input.bbBwPercentile < 12) return "baixa volatilidade (squeeze)";
  if (Math.abs(input.emaAlignment) === 3 && Math.abs(input.structureDir) >= 1 && input.adxLike > 0.55) {
    return input.emaAlignment > 0 ? "tendência forte de alta" : "tendência forte de baixa";
  }
  if (Math.abs(input.emaAlignment) >= 2 && input.adxLike > 0.3) {
    return input.emaAlignment > 0 ? "tendência fraca de alta" : "tendência fraca de baixa";
  }
  if (Math.abs(input.emaAlignment) <= 1 && input.adxLike < 0.3) return "consolidação";
  return "indefinido";
}

export function buildFeatureRows(rawCandles: Candle[]): FeatureRow[] {
  const candles = sortedCandles(rawCandles);
  if (candles.length < MIN_WARMUP) return [];
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => Math.max(0, candle.volume));
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, index) => ema12[index] - ema26[index]);
  const macdSignal = ema(macdLine, 9);
  const rsiSeries = rsi(closes, 14);
  const atrSeries = atr(candles, 14);
  const volumeMean = rollingMean(volumes, 20, true);
  const closeMean = rollingMean(closes, 20);
  const closeStd = rollingStd(closes, 20, closeMean);
  const bbBandwidthSeries = closes.map((_, index) => {
    const mean = closeMean[index];
    const deviation = closeStd[index];
    return mean !== null && deviation !== null && mean > 0 ? 4 * deviation / mean : null;
  });
  const rows: FeatureRow[] = [];

  for (let index = MIN_WARMUP - 1; index < candles.length; index++) {
    const candle = candles[index];
    const atrValue = safe(atrSeries[index]);
    if (!(atrValue > 0)) continue;
    const range = Math.max(1e-12, candle.high - candle.low);
    const rsiValue = safe(rsiSeries[index], 50);
    const priorRsi = safe(rsiSeries[Math.max(0, index - 3)], rsiValue);
    const averageVolume = safe(volumeMean[index]);
    const relativeVolume = averageVolume > 0 ? candle.volume / averageVolume : null;
    const mean = safe(closeMean[index], candle.close);
    const deviation = safe(closeStd[index]);
    const lower = mean - 2 * deviation;
    const upper = mean + 2 * deviation;
    const percentB = upper > lower ? (candle.close - lower) / (upper - lower) : 0.5;
    const alignment = ema9[index] > ema21[index] && ema21[index] > ema50[index] ? 1 :
      ema9[index] < ema21[index] && ema21[index] < ema50[index] ? -1 : 0;
    const emaAlignment = (ema9[index] > ema21[index] ? 1 : -1) +
      (ema21[index] > ema50[index] ? 1 : -1) +
      (ema50[index] > ema200[index] ? 1 : -1);
    const regimeInputs = {
      emaAlignment,
      adxLike: trendEfficiency(candles, index),
      atrPercentile: percentileRank(atrSeries, index),
      bbBandwidth: safe(bbBandwidthSeries[index]),
      bbBwPercentile: percentileRank(bbBandwidthSeries, index),
      structureDir: structureDirection(candles, index),
    };
    const bodyRatio = (candle.close - candle.open) / range;
    const momentum = candle.close - candles[Math.max(0, index - 5)].close;
    const macdHistogram = macdLine[index] - macdSignal[index];
    const vector = [
      alignment,
      clamp((candle.close - ema21[index]) / atrValue, -4, 4),
      clamp((ema9[index] - ema21[index]) / atrValue, -4, 4),
      clamp((ema21[index] - ema50[index]) / atrValue, -4, 4),
      clamp((candle.close - ema200[index]) / atrValue, -6, 6),
      clamp((rsiValue - 50) / 25, -2, 2),
      clamp((rsiValue - priorRsi) / 15, -2, 2),
      clamp(macdHistogram / atrValue, -3, 3),
      clamp((atrValue / candle.close) * 100, 0, 10),
      relativeVolume === null ? 0 : clamp(relativeVolume, 0, 4),
      clamp(bodyRatio, -1, 1),
      clamp(range / atrValue, 0, 5),
      clamp((percentB - 0.5) * 2, -3, 3),
      clamp(momentum / atrValue, -5, 5),
    ];
    rows.push({
      index,
      openTime: candle.openTime,
      vector,
      ema9: ema9[index], ema21: ema21[index], ema50: ema50[index], ema200: ema200[index],
      rsi: rsiValue,
      atr: atrValue,
      macdHistogram,
      relativeVolume,
      bodyRatio,
      rangeAtr: range / atrValue,
      bollingerPercentB: percentB,
      momentumAtr: momentum / atrValue,
      regime: classifyMarketRegime(regimeInputs),
      regimeInputs,
    });
  }
  return rows;
}

export function predictModel(model: StoredModel, vector: number[]): number | null {
  const artifact = model.artifact;
  // The very first production model is allowed to act as an explicitly marked
  // baseline even when it did not beat the naive rate offline.  It is useful
  // only to start a prospective ledger; challengers still need every strict
  // gate before they can enter shadow/promotion.
  if (!artifact || artifact.featureSchemaVersion !== FEATURE_SCHEMA_VERSION || (!artifact.usable && model.status !== "production")) return null;
  if (artifact.weights.length !== vector.length || artifact.mean.length !== vector.length || artifact.std.length !== vector.length) return null;
  let value = artifact.bias;
  for (let index = 0; index < vector.length; index++) {
    value += artifact.weights[index] * ((vector[index] - artifact.mean[index]) / (artifact.std[index] || 1));
  }
  return 1 / (1 + Math.exp(-clamp(value, -30, 30)));
}

export function gradeDecisionAssessment(assessmentScore: number): MarketDecision["grade"] {
  if (assessmentScore >= 85) return "A+";
  if (assessmentScore >= 72) return "A";
  if (assessmentScore >= 58) return "B";
  if (assessmentScore >= 42) return "C";
  return "D";
}

function check(
  id: string,
  label: string,
  family: AssessmentFamily,
  weight: number,
  status: AssessmentStatus,
  detail: string,
): DecisionAssessmentCheck {
  const factor = status === "pass" ? 1 : status === "partial" ? 0.5 : 0;
  return { id, label, family, weight, status, earned: weight * factor, detail };
}

/**
 * Eight transparent technical checks grouped into five evidence families.
 * Correlated confirmations receive diminishing weights inside trend and
 * momentum, so one clean trend cannot impersonate eight independent proofs.
 * Operational blockers remain outside this score.
 */
export function buildDecisionAssessment(input: {
  direction: "buy" | "sell" | null;
  directionalScore: number;
  alignment: number;
  emaFast: number;
  emaSlow: number;
  rsiCentered: number;
  macd: number;
  momentum: number;
  relativeVolume: number | null;
  wickRatio: number | null;
}): DecisionAssessment {
  const sign = input.direction === "buy" ? 1 : input.direction === "sell" ? -1 : 0;
  const signed = (value: number) => Math.sign(value) === sign;
  const neutral = (value: number, tolerance: number) => Math.abs(value) <= tolerance;
  const checks: DecisionAssessmentCheck[] = [
    check("direction", "Força direcional", "trend", 15,
      !sign || input.directionalScore < 56 ? "fail" : input.directionalScore >= 68 ? "pass" : "partial",
      `força ${input.directionalScore.toFixed(1)}/100`),
    check("ema_alignment", "Alinhamento das EMAs", "trend", 9,
      !sign ? "fail" : input.alignment === sign ? "pass" : input.alignment === 0 ? "partial" : "fail",
      input.alignment === sign ? "estrutura alinhada à direção" : input.alignment === 0 ? "estrutura ainda mista" : "estrutura contrária"),
    check("ema_structure", "Estrutura EMA 9/21/50", "trend", 6,
      !sign ? "fail" : signed(input.emaFast) && signed(input.emaSlow) ? "pass" :
        signed(input.emaFast) || signed(input.emaSlow) ? "partial" : "fail",
      "inclinação curta e intermediária"),
    check("rsi", "Contexto do RSI", "rsi", 12,
      !sign ? "fail" : signed(input.rsiCentered) ? "pass" : neutral(input.rsiCentered, 0.20) ? "partial" : "fail",
      `posição normalizada ${input.rsiCentered.toFixed(2)}`),
    check("macd", "Impulso MACD", "momentum", 12,
      !sign ? "fail" : signed(input.macd) ? "pass" : neutral(input.macd, 0.05) ? "partial" : "fail",
      `histograma ${input.macd.toFixed(2)} ATR`),
    check("momentum", "Momentum recente", "momentum", 8,
      !sign ? "fail" : signed(input.momentum) ? "pass" : neutral(input.momentum, 0.08) ? "partial" : "fail",
      `${input.momentum.toFixed(2)} ATR`),
    check("volume", "Confirmação por volume", "volume", 20,
      input.relativeVolume === null ? "partial" : input.relativeVolume >= 0.8 ? "pass" : input.relativeVolume >= 0.55 ? "partial" : "fail",
      input.relativeVolume === null ? "volume real indisponível" : `${input.relativeVolume.toFixed(2)}x da média`),
    check("wick", "Pavios e rejeição", "price_action", 18,
      input.wickRatio === null ? "partial" : input.wickRatio <= 0.28 ? "pass" : input.wickRatio <= 0.40 ? "partial" : "fail",
      input.wickRatio === null ? "sem leitura de pavio" : `${(input.wickRatio * 100).toFixed(0)}% de rejeição oposta`),
  ];
  const score = checks.reduce((sum, item) => sum + item.earned, 0);
  const familyDefinitions: Array<{ id: AssessmentFamily; label: string; cap: number }> = [
    { id: "trend", label: "Tendência", cap: 30 },
    { id: "momentum", label: "Momentum", cap: 20 },
    { id: "rsi", label: "RSI", cap: 12 },
    { id: "volume", label: "Volume", cap: 20 },
    { id: "price_action", label: "Price action", cap: 18 },
  ];
  return {
    score: Math.round(score * 10) / 10,
    passed: checks.filter((item) => item.status === "pass").length,
    partial: checks.filter((item) => item.status === "partial").length,
    failed: checks.filter((item) => item.status === "fail").length,
    total: checks.length,
    checks,
    families: familyDefinitions.map((family) => ({
      ...family,
      earned: Math.round(checks.filter((item) => item.family === family.id)
        .reduce((sum, item) => sum + item.earned, 0) * 10) / 10,
    })),
  };
}

function opposingWickRatio(candles: Candle[], direction: "buy" | "sell"): number {
  const recent = candles.slice(-3);
  let wick = 0;
  let range = 0;
  for (const candle of recent) {
    const size = Math.max(1e-12, candle.high - candle.low);
    const upper = candle.high - Math.max(candle.open, candle.close);
    const lower = Math.min(candle.open, candle.close) - candle.low;
    wick += direction === "buy" ? upper : lower;
    range += size;
  }
  return range > 0 ? wick / range : 0;
}

export interface DecisionOptions {
  now: number;
  timeframe: Timeframe;
  models: StoredModel[];
  payout?: number;
  operationCost?: number;
  tiePolicy?: "loss" | "refund" | "win";
  minScore?: number;
  minConfluence?: number;
  minLiveProgress?: number;
  requireRealVolume?: boolean;
  externalBlockers?: string[];
}

export interface IndependentModelDecision {
  action: "buy" | "sell" | "wait";
  direction: "buy" | "sell" | null;
  winProbability: number;
  expectedEv: number;
}

export interface DirectionalEconomics {
  winProbability: number;
  lossProbability: number;
  tieProbability: number;
  expectedEv: number;
}

/**
 * Canonical expected value for a directional probability conditioned on a
 * non-tie outcome. This mirrors signal_atlas.expected_trade_ev() in Postgres.
 */
export function directionalEconomics(
  directionalProbability: number,
  tieProbability: number,
  payout = 0.85,
  operationCost = 0.02,
  tiePolicy: "loss" | "refund" | "win" = "loss",
): DirectionalEconomics {
  const directional = clamp(Number(directionalProbability), 0, 1);
  const tie = clamp(Number(tieProbability), 0, 1);
  const winProbability = directional * (1 - tie);
  const lossProbability = (1 - directional) * (1 - tie);
  const safePayout = Math.max(0, Number(payout) || 0);
  const safeCost = Math.max(0, Number(operationCost) || 0);
  const policy = ["loss", "refund", "win"].includes(tiePolicy) ? tiePolicy : "loss";
  const netWin = safePayout - safeCost;
  const netLoss = -1 - safeCost;
  const netTie = policy === "win" ? netWin : policy === "refund" ? -safeCost : netLoss;
  const expectedEv = winProbability * netWin + lossProbability * netLoss + tie * netTie;
  return { winProbability, lossProbability, tieProbability: tie, expectedEv };
}

/**
 * Turns an up/down probability into an economically independent action.
 * The model is allowed to disagree with the technical heuristic and to wait.
 * WAIT has zero PnL per opportunity in the prospective promotion ledger.
 */
export function independentModelDecision(
  probabilityUp: number,
  tieProbability: number,
  payout = 0.85,
  operationCost = 0.02,
  tiePolicy: "loss" | "refund" | "win" = "loss",
): IndependentModelDecision {
  const up = clamp(Number(probabilityUp), 0, 1);
  const direction: "buy" | "sell" = up >= 0.5 ? "buy" : "sell";
  const directionalProbability = direction === "buy" ? up : 1 - up;
  const economics = directionalEconomics(
    directionalProbability,
    tieProbability,
    payout,
    operationCost,
    tiePolicy,
  );
  const { winProbability, expectedEv } = economics;
  return expectedEv > 0
    ? { action: direction, direction, winProbability, expectedEv }
    : { action: "wait", direction: null, winProbability, expectedEv };
}

export function computeMarketDecision(candles: Candle[], live: Candle | null, options: DecisionOptions): MarketDecision {
  const closed = sortedCandles(candles.filter((candle) => candle.isClosed));
  const input = live ? [...closed.filter((candle) => candle.openTime < live.openTime), live] : closed;
  const rows = buildFeatureRows(input);
  const latest = rows[rows.length - 1];
  const observed = live?.openTime ?? closed[closed.length - 1]?.openTime ?? 0;
  const clock = signalClock(observed, options.timeframe, 1);
  const blockers = [...(options.externalBlockers || [])];
  const reasons: string[] = [];

  if (!latest || closed.length < MIN_WARMUP) blockers.push(`histórico fechado insuficiente: ${closed.length}/${MIN_WARMUP}`);
  if (!live) blockers.push("vela atual em formação indisponível");
  const progress = live ? candleProgress(options.now, live.openTime, options.timeframe) : 0;
  if (live && progress < (options.minLiveProgress ?? 0.65)) blockers.push(`vela atual cedo demais: ${(progress * 100).toFixed(0)}% formada`);

  const vector = latest?.vector || new Array(FEATURE_NAMES.length).fill(0);
  const alignment = latest ? vector[0] : 0;
  const bias = latest ?
    alignment * 1.7 + clamp(vector[1], -2, 2) * 0.45 + clamp(vector[2] + vector[3], -3, 3) * 0.35 +
    clamp(vector[7], -2, 2) * 0.75 + clamp(vector[13], -2, 2) * 0.55 + clamp(vector[5], -1.5, 1.5) * 0.25 : 0;
  const technicalDirection: "buy" | "sell" | null = Math.abs(bias) < 0.8 ? null : bias > 0 ? "buy" : "sell";
  let direction = technicalDirection;
  const payout = Math.max(0, Number(options.payout ?? 0.85));
  const cost = Math.max(0, Number(options.operationCost ?? 0.02));

  const predictions: ModelPrediction[] = [];
  let champion: StoredModel | null = null;
  for (const model of options.models) {
    const probabilityUp = predictModel(model, vector);
    if (probabilityUp === null) continue;
    const role = model.status === "production" ? "champion" : "shadow";
    if (role === "champion") champion = model;
    const tieProbability = clamp(Number(model.artifact.tieRate) || 0, 0, 1);
    const policy = independentModelDecision(
      probabilityUp,
      tieProbability,
      payout,
      cost,
      options.tiePolicy,
    );
    predictions.push({
      modelId: model.id,
      role,
      probabilityUp,
      tieProbability,
      policyAction: policy.action,
      policyDirection: policy.direction,
      winProbability: policy.winProbability,
      expectedEv: policy.expectedEv,
      decisionPolicyVersion: Number(model.artifact.decisionPolicyVersion) || 1,
      featureSchemaVersion: model.artifact.featureSchemaVersion,
    });
  }
  const championPrediction = predictions.find((prediction) => prediction.role === "champion") || null;
  const championUsesIndependentDirection = !!champion &&
    Number(champion.artifact.decisionPolicyVersion) >= INDEPENDENT_DECISION_POLICY_VERSION;
  if (championUsesIndependentDirection && championPrediction) {
    if (championPrediction.policyDirection) {
      direction = championPrediction.policyDirection;
      reasons.push(`modelo direcional v${INDEPENDENT_DECISION_POLICY_VERSION}: ${direction === "buy" ? "COMPRA" : "VENDA"}`);
    } else {
      blockers.push(`modelo direcional v${INDEPENDENT_DECISION_POLICY_VERSION} recomenda AGUARDAR`);
    }
  }
  const sign = direction === "buy" ? 1 : direction === "sell" ? -1 : 0;
  const score = direction
    ? championUsesIndependentDirection && championPrediction
      ? clamp(50 + Math.abs(championPrediction.probabilityUp - 0.5) * 100, 0, 100)
      : clamp(50 + Math.abs(bias) * 10, 0, 100)
    : 50;
  let confluence = 0;
  if (direction && alignment === sign) confluence++;
  if (direction && Math.sign(vector[1]) === sign) confluence++;
  if (direction && Math.sign(vector[7]) === sign) confluence++;
  if (direction && Math.sign(vector[13]) === sign) confluence++;
  if (direction && Math.sign(vector[10]) === sign) confluence++;
  if (!direction) blockers.push("viés técnico neutro");

  let pacedVolume: number | null = null;
  let wickRatio: number | null = null;
  if (latest && direction) {
    pacedVolume = latest.relativeVolume === null ? null : latest.relativeVolume / Math.max(0.2, progress || 1);
    if ((options.requireRealVolume ?? true) && pacedVolume === null) blockers.push("volume real indisponível para confirmar VSA");
    else if (pacedVolume !== null && pacedVolume < 0.8) blockers.push(`volume relativo baixo: ${pacedVolume.toFixed(2)}x`);
    wickRatio = opposingWickRatio(input, direction);
    if (wickRatio > 0.40) blockers.push(`rejeição por pavios opostos: ${(wickRatio * 100).toFixed(0)}%`);
    reasons.push(`EMAs ${alignment === sign ? "alinhadas" : "sem alinhamento completo"}`);
    reasons.push(`RSI ${latest.rsi.toFixed(1)} · momentum ${latest.momentumAtr.toFixed(2)} ATR`);
  }

  let confidence: number | null = null;
  let evNet: number | null = null;
  if (!champion || !championPrediction) {
    blockers.push("modelo champion causal ainda não disponível para este ativo/timeframe");
  } else if (!direction) {
    blockers.push("modelo disponível, mas a vela atual ainda não definiu direção técnica");
  } else {
    if (!champion.artifact.usable) blockers.push("champion inicial em calibração prospectiva; confiança ainda é avaliação baixa");
    const conditional = direction === "buy" ? championPrediction.probabilityUp : 1 - championPrediction.probabilityUp;
    const economics = directionalEconomics(
      conditional,
      championPrediction.tieProbability,
      payout,
      cost,
      options.tiePolicy,
    );
    confidence = economics.winProbability;
    evNet = economics.expectedEv;
    if (evNet <= 0) blockers.push(`EV líquido não positivo: ${evNet.toFixed(4)}`);
  }
  if (score < (options.minScore ?? 68)) blockers.push(`score ${score.toFixed(1)} abaixo do mínimo ${options.minScore ?? 68}`);
  if (confluence < (options.minConfluence ?? 3)) blockers.push(`confluência ${confluence} abaixo do mínimo ${options.minConfluence ?? 3}`);

  const uniqueBlockers = [...new Set(blockers)];
  const blocked = uniqueBlockers.length > 0;
  const assessment = buildDecisionAssessment({
    direction,
    directionalScore: score,
    alignment,
    emaFast: latest ? vector[2] : 0,
    emaSlow: latest ? vector[3] : 0,
    rsiCentered: latest ? vector[5] : 0,
    macd: latest ? vector[7] : 0,
    momentum: latest ? vector[13] : 0,
    relativeVolume: pacedVolume,
    wickRatio,
  });
  const assessmentReasons = assessment.checks.map((item) => {
    const label = item.status === "pass" ? "APROVADO" : item.status === "partial" ? "PARCIAL" : "REPROVADO";
    const family = assessment.families.find((entry) => entry.id === item.family)?.label || item.family;
    return `${label} — ${item.label} · família ${family} (${item.earned.toFixed(1)}/${item.weight}): ${item.detail}`;
  });
  const familySummary = assessment.families
    .map((family) => `${family.label} ${family.earned.toFixed(1)}/${family.cap}`)
    .join(" · ");
  reasons.unshift(
    `Avaliação técnica ponderada: ${assessment.score.toFixed(1)}/100 · ${assessment.passed}/${assessment.total} aprovadas · ${assessment.partial} parciais · ${assessment.failed} reprovadas`,
    `Famílias de evidência com retorno decrescente: ${familySummary}`,
    ...assessmentReasons,
  );
  return {
    symbol: live?.symbol || closed[closed.length - 1]?.symbol || "",
    timeframe: options.timeframe,
    observedCandleOpen: clock.observedCandleOpen,
    entryCandleOpen: clock.entryCandleOpen,
    targetCandleOpen: clock.targetCandleOpen,
    resolveAfter: clock.resolveAfter,
    direction,
    status: blocked ? "wait" : "signal",
    score,
    grade: gradeDecisionAssessment(assessment.score),
    regime: latest?.regime || "indefinido",
    assessment,
    confluence,
    confidence,
    evNet,
    expiration: "E1",
    referencePrice: live?.close || closed[closed.length - 1]?.close || 0,
    usedLiveCandle: !!live,
    blockers: uniqueBlockers,
    reasons,
    featureVector: vector,
    predictions,
    championModelId: champion?.id || null,
  };
}

export function policySignature(settings: Record<string, unknown> = {}): string {
  const ordered = Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ enginePolicyVersion: ENGINE_POLICY_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION, settings: ordered });
}
