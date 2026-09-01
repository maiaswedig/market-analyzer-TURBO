// condition.js — detector de condição de mercado + filtro de eventos extremos.
// Classifica: tendência forte / tendência moderada / lateral / alta volatilidade (condição ruim).
// Lateral REDUZ o score — não força AGUARDAR automaticamente.

export const CONDITIONS = {
  TREND_STRONG: { key: 'TREND_STRONG', label: 'Tendência forte', icon: '🟢', scoreMult: 1, penalty: 0 },
  TREND_MOD: { key: 'TREND_MOD', label: 'Tendência moderada', icon: '🟡', scoreMult: 0.95, penalty: 0 },
  RANGE: { key: 'RANGE', label: 'Lateral', icon: '🟠', scoreMult: 0.82, penalty: 6 },
  BAD: { key: 'BAD', label: 'Alta volatilidade / condição ruim', icon: '🔴', scoreMult: 0.75, penalty: 10 }
};

/**
 * @param snap snapshot (features.js) — precisa de adx, atrPercentile, bb, ema, zones
 */
export function marketCondition(snap) {
  const adxV = snap.adx;
  const atrP = snap.atrPercentile;
  const bwP = snap.bb.bwPercentile;
  const compression = snap.emaCompression;   // (max-min das EMAs) / ATR
  const rangePos = snap.zones ? snap.zones.rangePos : 0.5;

  let cond = CONDITIONS.RANGE;
  const notes = [];
  if (atrP !== null && atrP > 92) { cond = CONDITIONS.BAD; notes.push(`ATR no percentil ${atrP.toFixed(0)} (volatilidade extrema)`); }
  else if (adxV !== null && adxV >= 25 && compression !== null && compression > 1.2) { cond = CONDITIONS.TREND_STRONG; notes.push(`ADX ${adxV.toFixed(1)} e EMAs abertas (${compression.toFixed(2)} ATR)`); }
  else if (adxV !== null && adxV >= 18) { cond = CONDITIONS.TREND_MOD; notes.push(`ADX ${adxV.toFixed(1)}`); }
  else { cond = CONDITIONS.RANGE; notes.push(adxV === null ? 'ADX indisponível' : `ADX ${adxV.toFixed(1)} (abaixo de 18)`); }

  if (cond !== CONDITIONS.BAD && compression !== null && compression < 0.35) notes.push(`EMAs comprimidas (${compression.toFixed(2)} ATR) — mercado sem direção clara`);
  if (bwP !== null && bwP < 12) notes.push(`largura das Bollinger no percentil ${bwP.toFixed(0)} (squeeze)`);
  if (rangePos > 0.85) notes.push('preço no topo da faixa mapeada');
  if (rangePos < 0.15) notes.push('preço no fundo da faixa mapeada');

  /* ---------------- eventos extremos ---------------- */
  const extremes = [];
  if (snap.rangeRel > 2.6) extremes.push(`vela com amplitude ${snap.rangeRel.toFixed(2)}× a média das últimas 20`);
  if (atrP !== null && atrP > 96) extremes.push(`pico anormal de ATR (percentil ${atrP.toFixed(0)})`);
  if (snap.gapAtr !== null && snap.gapAtr !== undefined && Math.abs(snap.gapAtr) > 1.2) extremes.push(`gap/impulso de abertura de ${snap.gapAtr.toFixed(2)} ATR`);
  if (snap.volume.available && snap.volume.rel !== null && snap.volume.rel > 4) extremes.push(`volume ${snap.volume.rel.toFixed(1)}× a média (evento)`);
  const abnormal = extremes.length > 0;

  return {
    key: cond.key, label: cond.label, icon: cond.icon,
    scoreMult: cond.scoreMult, penalty: cond.penalty,
    adx: adxV, atrPercentile: atrP, bbBwPercentile: bwP, emaCompression: compression, rangePos,
    notes, abnormal, extremes,
    text: `${cond.icon} ${cond.label} — ${notes.join(' · ')}`
  };
}
