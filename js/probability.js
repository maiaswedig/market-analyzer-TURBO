// probability.js — probabilidade histórica por analogia (não é o score!)
// Procura situações passadas com "impressão digital" semelhante e mede o que a PRÓXIMA vela fez.
import { bucketDistance } from './features.js';

/**
 * @param snaps array de snapshots (ordem cronológica) — o último é o atual
 * @param current snapshot atual
 * @param opts { maxNeighbors, maxDistance, minSamples }
 */
export function historicalProbability(snaps, current, opts = {}) {
  const maxNeighbors = opts.maxNeighbors || 250;
  const baseDistance = opts.maxDistance ?? 6;
  const minSamples = opts.minSamples ?? 30;
  const relax = opts.relax !== false;               // amplia o raio até 1,5x se faltar amostra
  const horizon = Math.max(1, Math.min(3, Math.round(Number(opts.horizon) || 1)));

  const all = [];
  for (const s of snaps) {
    if (!s || s.i >= current.i) continue;            // apenas o passado
    // Para E2/E3, o rótulo só entra quando a vela de expiração já havia
    // fechado em t. Caso contrário seria usar um resultado do futuro.
    if (s.i + horizon > current.i) continue;
    const futureDir = s.futureDir && s.futureDir[horizon] !== undefined ? s.futureDir[horizon] : (horizon === 1 ? s.nextDir : null);
    if (futureDir === undefined || futureDir === null) continue;
    const d = bucketDistance(s.buckets, current.buckets);
    all.push({ d, direction: futureDir });
  }
  all.sort((a, b) => a.d - b.d);

  // raio efetivo: começa no limite configurado; se não houver amostra suficiente,
  // amplia em passos até 1,5x o limite (fica registrado em `relaxedTo`).
  const steps = relax ? [1, 1.15, 1.3, 1.5] : [1];
  let maxDistance = baseDistance, used = [];
  for (const f of steps) {
    maxDistance = baseDistance * f;
    used = all.filter(x => x.d <= maxDistance).slice(0, maxNeighbors);
    if (used.length >= minSamples) break;
  }
  const relaxedTo = maxDistance > baseDistance + 1e-9 ? maxDistance : null;
  const samples = used.length;
  const up = used.filter(x => x.direction > 0).length;
  const down = used.filter(x => x.direction < 0).length;
  const ties = samples - up - down;

  if (samples < minSamples) {
    return { insufficient: true, samples, up, down, minSamples, maxDistance, baseDistance, relaxedTo,
      pUp: null, pDown: null, pTie: null, ties, ciLow: null, ciHigh: null, direction: 0, horizon,
      text: `amostra insuficiente (${samples} de ${minSamples} situações mínimas para ${horizon} vela${horizon > 1 ? 's' : ''})` };
  }

  // Laplace multinomial + intervalo de Wilson 95%. Empates entram na amostra:
  // em binárias, o tratamento (perda/reembolso) depende da corretora.
  const pUp = (up + 1) / (samples + 3);
  const pDown = (down + 1) / (samples + 3);
  const pTie = (ties + 1) / (samples + 3);
  const z = 1.96;
  const phat = up / samples;
  const denom = 1 + z * z / samples;
  const center = (phat + z * z / (2 * samples)) / denom;
  const margin = (z * Math.sqrt(phat * (1 - phat) / samples + z * z / (4 * samples * samples))) / denom;
  const ciLow = Math.max(0, center - margin), ciHigh = Math.min(1, center + margin);

  const direction = pUp > 0.5 ? 1 : pUp < 0.5 ? -1 : 0;
  const dominant = Math.max(pUp, pDown);
  // significância: o intervalo de confiança não deve cruzar 50%
  const significant = (direction > 0 && ciLow > 0.5) || (direction < 0 && ciHigh < 0.5);

  return {
    insufficient: false, samples, up, down, minSamples, maxDistance, baseDistance, relaxedTo,
    pUp, pDown, pTie, ties, dominant, ciLow, ciHigh, direction, significant, horizon,
    avgDistance: used.reduce((s, x) => s + x.d, 0) / samples,
    text: `${samples} situações históricas semelhantes (${horizon} vela${horizon > 1 ? 's' : ''}) → alta: ${up} / baixa: ${down} / empate: ${ties}`
  };
}

/**
 * Anexa a direção da próxima vela a cada snapshot (rótulo supervisionado).
 */
export function labelSnapshots(snaps, candles) {
  for (const s of snaps) {
    if (!s) continue;
    // A entrada hipotética é a abertura da próxima vela; E1/E2/E3 comparam o
    // fechamento da vela de expiração com ESSA mesma abertura. Isso impede que
    // horizontes diferentes reutilizem o rótulo da próxima vela.
    const entry = candles[s.i + 1];
    s.futureDir = {};
    s.futureChangePct = {};
    s.futureEntryOpen = entry ? entry.o : null;
    for (let horizon = 1; horizon <= 3; horizon++) {
      const target = candles[s.i + horizon];
      // Uma vela ainda em formação nunca é um rótulo supervisionado. Assim o
      // painel ao vivo não aprende/mede resultado parcial como se fosse fechado.
      if (!entry || entry.live || !target || target.live || !Number.isFinite(entry.o)) {
        s.futureDir[horizon] = null;
        s.futureChangePct[horizon] = null;
        continue;
      }
      const dir = target.c > entry.o ? 1 : target.c < entry.o ? -1 : 0;
      s.futureDir[horizon] = dir;
      s.futureChangePct[horizon] = ((target.c - entry.o) / entry.o) * 100;
    }
    // Campos legados preservados para consumidores de E1.
    s.nextDir = s.futureDir[1];
    s.nextChangePct = s.futureChangePct[1];
  }
  return snaps;
}
