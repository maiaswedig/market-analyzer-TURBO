// setups.js — "impressão digital" legível de cada sinal + aprendizado de setups.
// A digital é discreta para que classes possam ser agregadas e comparadas com amostra real.
import { expectancy } from './decision.js';

// Bandas propositalmente LARGAS: digitais finas geram centenas de classes com 2-3 amostras,
// o que não permite estatística. Aqui a classe é grossa o suficiente para acumular amostra.
function rsiBand(r) {
  if (r === null || r === undefined) return 'RSI n/d';
  if (r < 40) return 'RSI <40';
  if (r < 60) return 'RSI 40–60';
  return 'RSI >60';
}

/**
 * @param snap snapshot
 * @param mtf  [{tf, dir, isMain}]
 * @param dir  direção do sinal (1 CALL / −1 PUT)
 */
export function fingerprint(snap, mtf, dir, expiryCandles = 1) {
  const parts = [];
  parts.push(snap.ema.e9 > snap.ema.e21 ? 'EMA9>EMA21' : 'EMA9<EMA21');
  parts.push(rsiBand(snap.rsi));
  parts.push(snap.macd.hist === null ? 'MACD n/d' : snap.macd.hist > 0 ? 'MACD+' : 'MACD−');
  parts.push(!snap.volume.available ? 'Vol n/d' : snap.volume.rel > 1.2 ? 'Vol>média' : snap.volume.rel < 0.8 ? 'Vol<média' : 'Vol≈média');
  parts.push(snap.priceAction.dir > 0 ? 'PA comprador' : snap.priceAction.dir < 0 ? 'PA vendedor' : 'PA neutro');
  const ctx = mtf.filter(m => !m.isMain && !m.unavailable);
  if (ctx.length) {
    const higher = ctx[ctx.length - 1];
    parts.push(`${higher.tf} ${higher.dir > 0 ? 'alta' : higher.dir < 0 ? 'baixa' : 'neutro'}`);
  }
  parts.push(snap.adx === null ? 'ADX n/d' : snap.adx >= 25 ? 'ADX≥25' : 'ADX<25');
  const horizon = Math.max(1, Math.min(3, Math.round(Number(expiryCandles) || 1)));
  parts.push(`Exp. ${horizon} vela${horizon > 1 ? 's' : ''}`);
  const label = parts.join(' · ');
  return { id: `${dir > 0 ? 'CALL' : 'PUT'}|E${horizon}|${label}`, label, dir, expiryCandles: horizon, parts };
}

/**
 * Agrega resultados por classe de setup.
 * @param records [{setupId, setupLabel, signal, result:'ACERTO'|'ERRO'|'NEUTRO'}]
 * @param opts { minSamples, payout, stake, operationCost, tiePolicy }
 */
export function rankSetups(records, { minSamples = 20, payout = 0.85, stake = 1, operationCost = 0, tiePolicy = 'loss' } = {}) {
  const safeStake = Math.max(0.000001, Number(stake) || 1);
  const map = new Map();
  for (const r of records) {
    if (!r.setupId || !['ACERTO', 'ERRO', 'NEUTRO'].includes(r.result)) continue;
    if (!map.has(r.setupId)) map.set(r.setupId, { id: r.setupId, label: r.setupLabel || r.setupId, signal: r.signal, total: 0, hits: 0, ties: 0 });
    const o = map.get(r.setupId);
    o.total++;
    if (r.result === 'ACERTO') o.hits++;
    if (r.result === 'NEUTRO') o.ties++;
  }
  const all = [...map.values()].map(o => {
    const rate = o.total ? o.hits / o.total * 100 : null;
    // Suavização multinomial: vitória, perda e empate têm massa explícita.
    const p = o.total ? (o.hits + 1) / (o.total + 3) : null;
    const tieP = o.total ? (o.ties + 1) / (o.total + 3) : null;
    const ev = p === null ? null : expectancy(p, payout, safeStake, operationCost, tieP, tiePolicy);
    return { ...o, errors: o.total - o.hits - o.ties, rate, p, tieP, tieRate: o.total ? o.ties / o.total * 100 : null, ev, enough: o.total >= minSamples };
  });
  const eligible = all.filter(o => o.enough);
  return {
    all: all.sort((a, b) => b.total - a.total),
    best: eligible.slice().sort((a, b) => b.ev - a.ev).slice(0, 8),
    worst: eligible.slice().sort((a, b) => a.ev - b.ev).slice(0, 8),
    minSamples, payout, stake: safeStake, operationCost: Math.max(0, Number(operationCost) || 0), tiePolicy,
    classes: all.length, eligibleCount: eligible.length
  };
}

/** Estatística de UMA classe (usada para bônus/penalidade e para a nota do setup). */
export function setupStatsFor(ranking, setupId, minSamples = 20) {
  if (!ranking) return null;
  const found = (ranking.all || []).find(o => o.id === setupId);
  if (!found) return null;
  return { ...found, samples: found.total, minSamples, enough: found.total >= minSamples };
}
