// features.js — transforma candles em "fotografias" (snapshots) usadas pelas categorias do score,
// pelo matcher histórico, pelo backtest, pelos setups e pelo modelo de regressão logística.
import { computeIndicators, percentileRank, slopeAngle, divergence } from './indicators.js';
import { marketStructure } from './structure.js';
import { detectPatterns } from './patterns.js';
import { buildZones } from './zones.js';
import { analyzePriceAction } from './priceaction.js';

export function buildSeries(candles, { hasVolume = true } = {}) {
  const ind = computeIndicators(candles);
  return { candles, ind, hasVolume };
}

function at(arr, i) { const v = arr && arr[i]; return (v === null || v === undefined || Number.isNaN(v)) ? null : v; }

export const MIN_WARMUP = 210; // EMA200 + ATR + percentis

/**
 * Snapshot no índice i (i = índice do último candle FECHADO considerado).
 * Estritamente causal: nada além de candles[0..i] é lido.
 */
export function snapshotAt(series, i, { zoneLookback = 160, srLookback = null } = {}) {
  const { candles, ind, hasVolume } = series;
  if (i < MIN_WARMUP || i >= candles.length) return null;
  const k = candles[i];
  const price = k.c;
  const atrV = at(ind.atr14, i);
  if (!atrV) return null;

  const e9 = at(ind.ema9, i), e21 = at(ind.ema21, i), e50 = at(ind.ema50, i), e100 = at(ind.ema100, i), e200 = at(ind.ema200, i);
  if (e9 === null || e21 === null || e50 === null) return null;

  let alignment = 0;
  alignment += price > e9 ? 1 : -1;
  alignment += e9 > e21 ? 1 : -1;
  alignment += e21 > e50 ? 1 : -1;
  const aboveLong = e200 !== null ? (price > e200 ? 1 : -1) : (e100 !== null ? (price > e100 ? 1 : -1) : 0);

  const slope9 = slopeAngle(ind.ema9.slice(0, i + 1), 5, atrV);
  const slope50 = slopeAngle(ind.ema50.slice(0, i + 1), 10, atrV);
  const emaSpread = (e9 - e21) / atrV;
  const emaList = [e9, e21, e50].concat(e200 === null ? [] : [e200]);
  const emaCompression = (Math.max(...emaList) - Math.min(...emaList)) / atrV;

  const rsiV = at(ind.rsi14, i);
  const rsiPrev = at(ind.rsi14, i - 3);
  const rsiSlope = (rsiV !== null && rsiPrev !== null) ? rsiV - rsiPrev : 0;
  const rsiDiv = divergence(ind.closes.slice(0, i + 1), ind.rsi14.slice(0, i + 1), 20);

  const macdHist = at(ind.macd.hist, i);
  const macdHistPrev = at(ind.macd.hist, i - 1);
  const macdLine = at(ind.macd.line, i), macdSig = at(ind.macd.signal, i);
  const macdCross = (macdHist !== null && macdHistPrev !== null && Math.sign(macdHist) !== Math.sign(macdHistPrev)) ? Math.sign(macdHist) : 0;

  const stochK = at(ind.stoch.k, i), stochD = at(ind.stoch.d, i);
  const rocV = at(ind.roc9, i);
  const adxV = at(ind.adx14 && ind.adx14.adx, i);
  const plusDI = at(ind.adx14 && ind.adx14.plusDI, i);
  const minusDI = at(ind.adx14 && ind.adx14.minusDI, i);

  const atrPct = percentileRank(ind.atr14.slice(0, i + 1), atrV, 200);
  const bbUp = at(ind.bb.upper, i), bbLo = at(ind.bb.lower, i), bbMid = at(ind.bb.mid, i);
  const pB = at(ind.bb.percentB, i);
  const bw = at(ind.bb.bandwidth, i);
  const bwPct = bw !== null ? percentileRank(ind.bb.bandwidth.slice(0, i + 1), bw, 200) : null;

  const vol = k.v || 0;
  // A referência de volume exclui a própria vela. Em especial na vela em
  // formação, incluir o volume parcial na SMA reduziria artificialmente o
  // volume relativo e enfraqueceria a trava VSA.
  const priorVolumes = candles.slice(Math.max(0, i - 20), i).map(row => Number(row.v) || 0);
  const volAvg = hasVolume && priorVolumes.length ? priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length : 0;
  const relVol = hasVolume && volAvg > 0 ? vol / volAvg : null;
  const volRising = hasVolume && i > 1 ? (k.v || 0) > (candles[i - 1].v || 0) : null;

  const rangeAvg = candles.slice(Math.max(0, i - 20), i + 1).reduce((s, x) => s + (x.h - x.l), 0) / Math.min(21, i + 1);
  const rangeRel = rangeAvg > 0 ? (k.h - k.l) / rangeAvg : 1;
  const gapAtr = i > 0 ? (k.o - candles[i - 1].c) / atrV : 0;

  const struct = marketStructure(candles, i + 1, 80);
  const zones = buildZones(candles, atrV, i + 1, { lookback: srLookback || zoneLookback });
  const pat = detectPatterns(candles, i + 1, rangeAvg);
  const pa = analyzePriceAction(candles, i + 1, { atr: atrV, zones, volumeRel: relVol });

  const distR = zones.nearestResistance ? zones.nearestResistance.distEdgeAtr : null;
  const distS = zones.nearestSupport ? zones.nearestSupport.distEdgeAtr : null;
  const srPos = (distR !== null && distS !== null) ? (distS - distR) : 0; // >0 = mais perto da resistência

  const buckets = {
    trend: alignment >= 2 ? 2 : alignment >= 1 ? 1 : alignment <= -2 ? -2 : alignment <= -1 ? -1 : 0,
    struct: struct.score > 0 ? 1 : struct.score < 0 ? -1 : 0,
    rsi: rsiV === null ? 2 : rsiV < 30 ? 0 : rsiV < 40 ? 1 : rsiV < 50 ? 2 : rsiV < 60 ? 3 : rsiV < 70 ? 4 : 5,
    macd: macdHist === null ? 0 : macdHist > 0 ? 1 : -1,
    bb: pB === null ? 2 : pB < 0.1 ? 0 : pB < 0.35 ? 1 : pB < 0.65 ? 2 : pB < 0.9 ? 3 : 4,
    vol: relVol === null ? -1 : relVol < 0.7 ? 0 : relVol < 1.2 ? 1 : relVol < 2 ? 2 : 3,
    atr: atrPct === null ? 1 : atrPct < 25 ? 0 : atrPct < 60 ? 1 : atrPct < 85 ? 2 : 3,
    adx: adxV === null ? 1 : adxV < 18 ? 0 : adxV < 25 ? 1 : adxV < 35 ? 2 : 3,
    pattern: pat.klass,
    pa: pa.dir,
    sr: srPos > 0.8 ? 2 : srPos > 0.2 ? 1 : srPos < -0.8 ? -2 : srPos < -0.2 ? -1 : 0,
    long: aboveLong
  };

  const vector = [
    alignment / 3,
    (price - e21) / atrV,
    (e9 - e21) / atrV,
    (e21 - e50) / atrV,
    slope9 === null ? 0 : slope9 / 45,
    slope50 === null ? 0 : slope50 / 45,
    rsiV === null ? 0 : (rsiV - 50) / 25,
    rsiSlope / 10,
    macdHist === null || !atrV ? 0 : Math.max(-3, Math.min(3, macdHist / atrV)),
    macdCross,
    stochK === null ? 0 : (stochK - 50) / 30,
    (stochK !== null && stochD !== null) ? Math.max(-2, Math.min(2, (stochK - stochD) / 10)) : 0,
    rocV === null ? 0 : Math.max(-3, Math.min(3, rocV)),
    pB === null ? 0 : (pB - 0.5) * 2,
    bwPct === null ? 0 : (bwPct - 50) / 40,
    atrPct === null ? 0 : (atrPct - 50) / 40,
    relVol === null ? 0 : Math.max(-2, Math.min(3, relVol - 1)),
    rangeRel - 1,
    struct.score / 2,
    pat.net / 2,
    distR === null ? 0 : Math.max(-2, Math.min(3, distR)),
    distS === null ? 0 : Math.max(-2, Math.min(3, distS)),
    aboveLong,
    (k.c - k.o) / Math.max(1e-9, k.h - k.l),
    adxV === null ? 0 : (adxV - 20) / 15,
    (plusDI !== null && minusDI !== null) ? Math.max(-2, Math.min(2, (plusDI - minusDI) / 15)) : 0,
    Math.max(-2, Math.min(2, pa.net / 2)),
    Math.max(-2, Math.min(2, gapAtr)),
    Math.max(0, Math.min(3, emaCompression)),
    (zones.rangePos - 0.5) * 2
  ];

  return {
    i, t: k.t, candle: k, price, atr: atrV,
    ema: { e9, e21, e50, e100, e200 }, alignment, aboveLong, slope9, slope50, emaSpread, emaCompression,
    rsi: rsiV, rsiSlope, rsiDiv,
    macd: { hist: macdHist, line: macdLine, signal: macdSig, cross: macdCross },
    stoch: { k: stochK, d: stochD },
    roc: rocV, adx: adxV, plusDI, minusDI,
    atrPercentile: atrPct,
    bb: { upper: bbUp, lower: bbLo, mid: bbMid, percentB: pB, bandwidth: bw, bwPercentile: bwPct },
    volume: { value: vol, avg: volAvg, rel: relVol, rising: volRising, available: hasVolume && volAvg > 0 },
    rangeRel, rangeAvg, gapAtr,
    structure: struct, zones, patterns: pat, priceAction: pa,
    distR, distS, srPos,
    // Janela curta mantida no próprio snapshot para os filtros de rejeição.
    // Ela termina em i, portanto continua estritamente causal inclusive no backtest.
    recentCandles: candles.slice(Math.max(0, i - 2), i + 1),
    buckets, vector, hasVolume
  };
}

export const VECTOR_NAMES = [
  'Alinhamento EMAs', 'Preço vs EMA21 (ATR)', 'EMA9-EMA21 (ATR)', 'EMA21-EMA50 (ATR)',
  'Inclinação EMA9', 'Inclinação EMA50', 'RSI (centrado)', 'Inclinação RSI',
  'Histograma MACD', 'Cruzamento MACD', 'Estocástico %K', '%K - %D', 'ROC(9)',
  '%B Bollinger', 'Percentil largura BB', 'Percentil ATR', 'Volume relativo',
  'Amplitude vs média', 'Estrutura', 'Padrão de candle', 'Distância resistência (ATR)',
  'Distância suporte (ATR)', 'Preço vs EMA200', 'Corpo/amplitude da vela',
  'ADX(14)', '+DI menos -DI', 'Price action (líquido)', 'Gap de abertura (ATR)',
  'Compressão das EMAs', 'Posição na faixa'
];

export const BUCKET_WEIGHTS = { trend: 3, struct: 2.5, rsi: 2, macd: 2, bb: 1.5, vol: 1, atr: 1, adx: 1.5, pattern: 1, pa: 1.2, sr: 1.5, long: 1 };

export function bucketDistance(a, b) {
  let d = 0;
  for (const key in BUCKET_WEIGHTS) {
    const va = a[key], vb = b[key];
    if (va === undefined || vb === undefined) continue;
    d += BUCKET_WEIGHTS[key] * Math.abs(va - vb);
  }
  return d;
}
