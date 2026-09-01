// zones.js — zonas de suporte e resistência (faixas de preço, não linhas).
// Agrupa pivôs de swing + extremos recentes + números redondos em bandas com força e largura.
import { pivots } from './structure.js';

function roundNumbers(price) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(price) || 1)) - 1);
  const step = mag * 5;
  const base = Math.round(price / step) * step;
  return [base - step, base, base + step, base - step * 2, base + step * 2];
}

/**
 * @returns { supports, resistances, nearestSupport, nearestResistance, price, atr, rangePos }
 * Cada zona: { low, high, mid, width, widthPct, touches, strength(1-5), ageBars, volume,
 *              round, distPct, distAtr, kind }
 */
export function buildZones(candles, atrValue, upTo = candles.length, { lookback = 240, maxZones = 5 } = {}) {
  const from = Math.max(0, upTo - lookback);
  const slice = candles.slice(from, upTo);
  if (slice.length < 20 || !atrValue) return { supports: [], resistances: [], nearestSupport: null, nearestResistance: null, price: slice.length ? slice[slice.length - 1].c : null, atr: atrValue, rangePos: 0.5, all: [] };
  const price = slice[slice.length - 1].c;
  const tol = atrValue * 0.5;                       // largura base da zona
  const { highs, lows } = pivots(slice, 2, 2, slice.length);

  const seeds = [];
  for (const p of highs) seeds.push({ price: p.price, i: p.i, kind: 'pivot-alta' });
  for (const p of lows) seeds.push({ price: p.price, i: p.i, kind: 'pivot-baixa' });
  const hiIdx = slice.reduce((m, k, i) => k.h > slice[m].h ? i : m, 0);
  const loIdx = slice.reduce((m, k, i) => k.l < slice[m].l ? i : m, 0);
  seeds.push({ price: slice[hiIdx].h, i: hiIdx, kind: 'máxima do período' });
  seeds.push({ price: slice[loIdx].l, i: loIdx, kind: 'mínima do período' });
  for (const rn of roundNumbers(price)) seeds.push({ price: rn, i: slice.length - 1, kind: 'número redondo', round: true });

  seeds.sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const s of seeds) {
    const c = clusters[clusters.length - 1];
    if (c && s.price - c.high <= tol) {
      c.low = Math.min(c.low, s.price - tol * 0.25);
      c.high = Math.max(c.high, s.price + tol * 0.25);
      c.seeds.push(s);
      if (s.round) c.round = true;
    } else {
      clusters.push({ low: s.price - tol * 0.25, high: s.price + tol * 0.25, seeds: [s], round: !!s.round });
    }
  }

  const nBars = slice.length;
  for (const c of clusters) {
    c.mid = (c.low + c.high) / 2;
    c.width = c.high - c.low;
    c.widthPct = (c.width / price) * 100;
    let touches = 0, lastTouch = -1, vol = 0;
    for (let i = 0; i < nBars; i++) {
      const k = slice[i];
      if (k.l <= c.high && k.h >= c.low) { touches++; lastTouch = i; vol += (k.v || 0); }
    }
    c.touches = touches;
    c.ageBars = lastTouch >= 0 ? nBars - 1 - lastTouch : nBars;
    c.volume = vol;
    const seedScore = c.seeds.filter(s => s.kind.startsWith('pivot')).length;
    const raw = seedScore * 1.2 + Math.min(6, touches) * 0.5 + (c.round ? 1 : 0) + (c.seeds.some(s => s.kind.includes('período')) ? 1 : 0);
    c.strength = Math.max(1, Math.min(5, Math.round(raw / 1.6)));
    c.distPct = (Math.abs(c.mid - price) / price) * 100;
    // distância até a BORDA da zona (o que realmente atrapalha a entrada)
    const edge = price < c.low ? c.low - price : price > c.high ? price - c.high : 0;
    c.distEdgeAtr = edge / atrValue;
    c.distAtr = Math.abs(c.mid - price) / atrValue;
    c.inside = price >= c.low && price <= c.high;
    c.labels = [...new Set(c.seeds.map(s => s.kind))];
  }

  const resistances = clusters.filter(c => c.mid > price).sort((a, b) => a.mid - b.mid).slice(0, maxZones).map(z => ({ ...z, kind: 'resistência' }));
  const supports = clusters.filter(c => c.mid <= price).sort((a, b) => b.mid - a.mid).slice(0, maxZones).map(z => ({ ...z, kind: 'suporte' }));
  const hi = Math.max(...slice.map(k => k.h)), lo = Math.min(...slice.map(k => k.l));
  const rangePos = hi > lo ? (price - lo) / (hi - lo) : 0.5;

  return {
    supports, resistances,
    nearestSupport: supports[0] || null,
    nearestResistance: resistances[0] || null,
    price, atr: atrValue, rangePos,
    rangeHigh: hi, rangeLow: lo,
    all: supports.concat(resistances)
  };
}

/**
 * Avalia se a direção pretendida está bloqueada por uma zona colada.
 * @param dir 1 = CALL, -1 = PUT
 * @param cfg { minZoneAtr } distância mínima (em ATR) até a zona contrária
 */
export function zoneClearance(zones, dir, cfg = {}) {
  const minAtr = cfg.minZoneAtr ?? 0.35;
  const target = dir > 0 ? zones.nearestResistance : zones.nearestSupport;
  const behind = dir > 0 ? zones.nearestSupport : zones.nearestResistance;
  if (!target) return { ok: true, blocked: false, distAtr: null, penalty: 0, reason: 'nenhuma zona contrária mapeada à frente' };
  const dist = target.distEdgeAtr;
  const strong = target.strength >= 3;
  const blocked = dist < minAtr && strong;
  // penalidade proporcional: colado e forte pesa mais
  const proximity = Math.max(0, Math.min(1, (1.6 - dist) / 1.6));
  const penalty = Math.round(proximity * (4 + target.strength * 2));
  return {
    ok: !blocked, blocked, distAtr: dist, distPct: target.distPct, strength: target.strength,
    penalty, target, behind,
    reason: blocked
      ? `${dir > 0 ? 'resistência' : 'suporte'} de força ${target.strength} a apenas ${dist.toFixed(2)} ATR (mínimo ${minAtr} ATR)`
      : `${dir > 0 ? 'resistência' : 'suporte'} mais próximo a ${dist.toFixed(2)} ATR (força ${target.strength})`
  };
}
