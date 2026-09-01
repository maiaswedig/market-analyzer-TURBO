// indicators.js — indicadores técnicos puros (sem bibliotecas)
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast), es = ema(values, slow);
  const line = values.map((_, i) => (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null);
  const compact = line.filter(v => v !== null);
  const sigCompact = ema(compact, signal);
  const sig = new Array(values.length).fill(null);
  let j = 0;
  for (let i = 0; i < values.length; i++) if (line[i] !== null) sig[i] = sigCompact[j++];
  const hist = line.map((v, i) => (v !== null && sig[i] !== null) ? v - sig[i] : null);
  return { line, signal: sig, hist };
}

export function stochastic(highs, lows, closes, kPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rawK = new Array(closes.length).fill(null);
  for (let i = kPeriod - 1; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { hh = Math.max(hh, highs[j]); ll = Math.min(ll, lows[j]); }
    rawK[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const compact = rawK.filter(v => v !== null);
  const kS = sma(compact, kSmooth);
  const dS = sma(kS.filter(v => v !== null), dSmooth);
  const k = new Array(closes.length).fill(null), d = new Array(closes.length).fill(null);
  let a = 0;
  for (let i = 0; i < closes.length; i++) if (rawK[i] !== null) k[i] = kS[a++];
  let b = 0;
  for (let i = 0; i < closes.length; i++) if (k[i] !== null) d[i] = dS[b++];
  return { k, d };
}

export function atr(highs, lows, closes, period = 14) {
  const tr = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i];
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < closes.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// ADX(14) clássico (Wilder) com +DI/-DI
export function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = { adx: new Array(n).fill(null), plusDI: new Array(n).fill(null), minusDI: new Array(n).fill(null) };
  if (n < period * 2 + 2) return out;
  const tr = new Array(n).fill(0), pDM = new Array(n).fill(0), mDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
    pDM[i] = (up > dn && up > 0) ? up : 0;
    mDM[i] = (dn > up && dn > 0) ? dn : 0;
  }
  let atrS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) { atrS += tr[i]; pS += pDM[i]; mS += mDM[i]; }
  const dxs = [];
  let adxPrev = null;
  for (let i = period + 1; i < n; i++) {
    atrS = atrS - atrS / period + tr[i];
    pS = pS - pS / period + pDM[i];
    mS = mS - mS / period + mDM[i];
    const pdi = atrS ? (pS / atrS) * 100 : 0;
    const mdi = atrS ? (mS / atrS) * 100 : 0;
    out.plusDI[i] = pdi; out.minusDI[i] = mdi;
    const dx = (pdi + mdi) ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
    dxs.push(dx);
    if (dxs.length === period) { adxPrev = dxs.reduce((a, b) => a + b, 0) / period; out.adx[i] = adxPrev; }
    else if (dxs.length > period) { adxPrev = (adxPrev * (period - 1) + dx) / period; out.adx[i] = adxPrev; }
  }
  return out;
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  const bw = new Array(values.length).fill(null);
  const pb = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += Math.pow(values[j] - mid[i], 2);
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    bw[i] = mid[i] ? ((upper[i] - lower[i]) / mid[i]) * 100 : null;
    pb[i] = upper[i] === lower[i] ? 0.5 : (values[i] - lower[i]) / (upper[i] - lower[i]);
  }
  return { mid, upper, lower, bandwidth: bw, percentB: pb };
}

export function roc(values, period = 9) {
  return values.map((v, i) => i >= period && values[i - period] ? ((v - values[i - period]) / values[i - period]) * 100 : null);
}

export function percentileRank(arr, value, lookback = 100) {
  const vals = arr.filter(v => v !== null && Number.isFinite(v)).slice(-lookback);
  if (!vals.length) return null;
  const below = vals.filter(v => v <= value).length;
  return (below / vals.length) * 100;
}

export function slopeAngle(series, bars = 5, ref = 1) {
  const n = series.length;
  if (n < bars + 1) return null;
  const a = series[n - 1 - bars], b = series[n - 1];
  if (a === null || b === null || !ref) return null;
  const pct = ((b - a) / ref) * 100 / bars; // variação percentual média por candle
  return Math.atan(pct) * 180 / Math.PI;
}

// Divergência simples entre preço e oscilador nos últimos `look` candles
export function divergence(prices, osc, look = 20) {
  const n = prices.length;
  if (n < look + 2) return 0;
  const seg = (arr, from) => arr.slice(from);
  const p = seg(prices, n - look), o = seg(osc, n - look).map(v => v === null ? NaN : v);
  const idxMax = p.reduce((m, v, i) => v > p[m] ? i : m, 0);
  const idxMin = p.reduce((m, v, i) => v < p[m] ? i : m, 0);
  const last = p.length - 1;
  if (Number.isNaN(o[idxMax]) || Number.isNaN(o[idxMin]) || Number.isNaN(o[last])) return 0;
  // divergência de baixa: preço faz topo mais alto, oscilador não confirma
  if (idxMax < last - 1 && p[last] > p[idxMax] * 0.999 && o[last] < o[idxMax] - 2) return -1;
  if (idxMin < last - 1 && p[last] < p[idxMin] * 1.001 && o[last] > o[idxMin] + 2) return 1;
  return 0;
}

// Bloco completo de indicadores no índice `i` (default: último candle fechado)
export function computeIndicators(candles) {
  const closes = candles.map(k => k.c);
  const highs = candles.map(k => k.h);
  const lows = candles.map(k => k.l);
  const vols = candles.map(k => k.v || 0);
  return {
    closes, highs, lows, vols,
    ema9: ema(closes, 9), ema21: ema(closes, 21), ema50: ema(closes, 50),
    ema100: ema(closes, 100), ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    macd: macd(closes, 12, 26, 9),
    stoch: stochastic(highs, lows, closes, 14, 3, 3),
    atr14: atr(highs, lows, closes, 14),
    bb: bollinger(closes, 20, 2),
    adx14: adx(highs, lows, closes, 14),
    roc9: roc(closes, 9),
    volSma20: sma(vols, 20)
  };
}
