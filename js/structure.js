// structure.js — estrutura de mercado, pivôs, suportes/resistências, regime
export function pivots(candles, left = 2, right = 2, upTo = candles.length) {
  const highs = [], lows = [];
  for (let i = left; i < upTo - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isH = false;
      if (candles[j].l <= candles[i].l) isL = false;
    }
    if (isH) highs.push({ i, price: candles[i].h, t: candles[i].t });
    if (isL) lows.push({ i, price: candles[i].l, t: candles[i].t });
  }
  return { highs, lows };
}

/**
 * Classifica a estrutura: topos/fundos ascendentes (alta), descendentes (baixa) ou consolidação.
 */
export function marketStructure(candles, upTo = candles.length, lookback = 80) {
  const from = Math.max(0, upTo - lookback);
  const slice = candles.slice(from, upTo);
  const { highs, lows } = pivots(slice, 2, 2, slice.length);
  const hh = highs.slice(-3), ll = lows.slice(-3);
  let label = 'consolidação', dir = 0, score = 0;
  const risingH = hh.length >= 2 && hh[hh.length - 1].price > hh[hh.length - 2].price;
  const risingL = ll.length >= 2 && ll[ll.length - 1].price > ll[ll.length - 2].price;
  const fallingH = hh.length >= 2 && hh[hh.length - 1].price < hh[hh.length - 2].price;
  const fallingL = ll.length >= 2 && ll[ll.length - 1].price < ll[ll.length - 2].price;
  if (risingH && risingL) { label = 'tendência de alta'; dir = 1; score = 2; }
  else if (fallingH && fallingL) { label = 'tendência de baixa'; dir = -1; score = -2; }
  else if (risingL && !fallingH) { label = 'alta em formação'; dir = 1; score = 1; }
  else if (fallingH && !risingL) { label = 'baixa em formação'; dir = -1; score = -1; }

  // rompimentos e falsos rompimentos do último pivô
  const last = slice[slice.length - 1];
  const prevHigh = hh.length ? hh[hh.length - 1].price : null;
  const prevLow = ll.length ? ll[ll.length - 1].price : null;
  let event = 'nenhum';
  if (prevHigh && last.c > prevHigh) event = 'rompimento de topo';
  else if (prevLow && last.c < prevLow) event = 'rompimento de fundo';
  else if (prevHigh && last.h > prevHigh && last.c < prevHigh) event = 'falso rompimento de topo';
  else if (prevLow && last.l < prevLow && last.c > prevLow) event = 'falso rompimento de fundo';

  // impulso vs correção: tamanho do corpo médio dos 3 últimos vs 20
  const body = k => Math.abs(k.c - k.o);
  const avg = (arr, f) => arr.reduce((s, x) => s + f(x), 0) / (arr.length || 1);
  const recent = avg(slice.slice(-3), body);
  const base = avg(slice.slice(-20), body) || 1e-9;
  const phase = recent > base * 1.35 ? 'impulso' : recent < base * 0.7 ? 'correção' : 'normal';

  return { label, dir, score, event, phase, swingHigh: prevHigh, swingLow: prevLow, pivotHighs: hh, pivotLows: ll };
}

function roundNumbers(price) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(price) || 1)) - 1);
  const step = mag * 5;
  const base = Math.round(price / step) * step;
  return [base - step, base, base + step];
}

/**
 * Suportes e resistências por aglomeração de pivôs + extremos recentes + números redondos.
 * Força = número de toques. Distância medida em múltiplos de ATR.
 */
export function supportResistance(candles, atrValue, upTo = candles.length, lookback = 150) {
  const from = Math.max(0, upTo - lookback);
  const slice = candles.slice(from, upTo);
  if (slice.length < 10) return { supports: [], resistances: [], nearest: null };
  const price = slice[slice.length - 1].c;
  const tol = (atrValue || price * 0.002) * 0.6;
  const { highs, lows } = pivots(slice, 2, 2, slice.length);
  const raw = highs.map(p => ({ price: p.price, kind: 'r' })).concat(lows.map(p => ({ price: p.price, kind: 's' })));
  raw.push({ price: Math.max(...slice.map(k => k.h)), kind: 'r' });
  raw.push({ price: Math.min(...slice.map(k => k.l)), kind: 's' });
  for (const rn of roundNumbers(price)) raw.push({ price: rn, kind: 'round' });

  const clusters = [];
  for (const lvl of raw.sort((a, b) => a.price - b.price)) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(lvl.price - c.price) <= tol) {
      c.touches += 1;
      c.price = (c.price * (c.touches - 1) + lvl.price) / c.touches;
      if (lvl.kind === 'round') c.round = true;
    } else {
      clusters.push({ price: lvl.price, touches: 1, round: lvl.kind === 'round' });
    }
  }
  // conta toques reais no histórico
  for (const c of clusters) {
    let t = 0;
    for (const k of slice) if (k.l - tol <= c.price && k.h + tol >= c.price) t++;
    c.touches = Math.max(c.touches, Math.min(12, t));
    c.strength = Math.min(5, Math.round(c.touches / 2) + (c.round ? 1 : 0));
    c.distAtr = atrValue ? Math.abs(c.price - price) / atrValue : null;
  }
  const supports = clusters.filter(c => c.price < price).sort((a, b) => b.price - a.price).slice(0, 4);
  const resistances = clusters.filter(c => c.price > price).sort((a, b) => a.price - b.price).slice(0, 4);
  const nearestS = supports[0] || null, nearestR = resistances[0] || null;
  return { supports, resistances, nearestSupport: nearestS, nearestResistance: nearestR, price };
}

/**
 * Regime de mercado a partir de EMAs, ATR percentil e largura das Bandas.
 */
export function regime({ emaAlignment, adxLike, atrPercentile, bbBandwidth, bbBwPercentile, structureDir }) {
  if (atrPercentile !== null && atrPercentile > 88) return 'alta volatilidade';
  if (bbBwPercentile !== null && bbBwPercentile < 12) return 'baixa volatilidade (squeeze)';
  if (Math.abs(emaAlignment) === 3 && Math.abs(structureDir) >= 1 && adxLike > 0.55) return emaAlignment > 0 ? 'tendência forte de alta' : 'tendência forte de baixa';
  if (Math.abs(emaAlignment) >= 2 && adxLike > 0.3) return emaAlignment > 0 ? 'tendência fraca de alta' : 'tendência fraca de baixa';
  if (Math.abs(emaAlignment) <= 1 && adxLike < 0.3) return 'consolidação';
  return 'indefinido';
}
