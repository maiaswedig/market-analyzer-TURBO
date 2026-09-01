// priceaction.js — módulo avançado de price action (janelas de 3 / 5 / 10 / 20 velas).
// Só descreve o que está nos candles reais; nenhuma leitura é inventada.
import { candleAnatomy } from './patterns.js';

const dirOf = k => k.c > k.o ? 1 : k.c < k.o ? -1 : 0;

/**
 * @param candles array cronológico
 * @param upTo    índice exclusivo (analisa candles[upTo-1] como última vela FECHADA)
 * @param ctx     { atr, zones } — zones opcional (js/zones.js) para rejeição de suporte/resistência
 */
export function analyzePriceAction(candles, upTo = candles.length, ctx = {}) {
  const n = upTo;
  if (n < 21) return { events: [], dir: 0, net: 0, summary: 'Histórico insuficiente para leitura de price action.', windows: {} };
  const k = candles[n - 1], p = candles[n - 2], p2 = candles[n - 3];
  const a = candleAnatomy(k), ap = candleAnatomy(p);
  const atr = ctx.atr || null;
  const win = (len) => candles.slice(Math.max(0, n - len), n);
  const w3 = win(3), w5 = win(5), w10 = win(10), w20 = win(20);
  const avgRange = w20.reduce((s, x) => s + (x.h - x.l), 0) / w20.length;
  const avgBody = w20.reduce((s, x) => s + Math.abs(x.c - x.o), 0) / w20.length;
  const events = [];
  const push = (name, dir, weight, detail) => events.push({ name, dir, weight, detail });

  const sizeVsAtr = atr ? (k.h - k.l) / atr : null;
  const bodyVsAvg = avgBody ? Math.abs(k.c - k.o) / avgBody : null;

  /* ---- velas isoladas ---- */
  if (a.bodyPct > 0.72 && (k.h - k.l) > avgRange * 1.15) {
    push(a.bull ? 'candle de força de alta' : 'candle de força de baixa', a.bull ? 1 : -1, 1,
      `corpo ${(a.bodyPct * 100).toFixed(0)}% da amplitude, ${bodyVsAvg ? bodyVsAvg.toFixed(2) + '× o corpo médio' : ''}`);
  }
  if (a.upperPct > 0.5 && a.bodyPct < 0.4) push('candle de rejeição no topo', -1, 0.9, `pavio superior ${(a.upperPct * 100).toFixed(0)}% da amplitude`);
  if (a.lowerPct > 0.5 && a.bodyPct < 0.4) push('candle de rejeição no fundo', 1, 0.9, `pavio inferior ${(a.lowerPct * 100).toFixed(0)}% da amplitude`);
  if (a.lowerPct > 0.55 && a.bodyPct < 0.35 && a.upperPct < 0.2) push('pin bar de alta', 1, 1, 'pavio inferior dominante');
  if (a.upperPct > 0.55 && a.bodyPct < 0.35 && a.lowerPct < 0.2) push('pin bar de baixa', -1, 1, 'pavio superior dominante');
  if (a.bodyPct < 0.12) push('doji (indecisão)', 0, 0.5, `corpo ${(a.bodyPct * 100).toFixed(0)}% da amplitude`);
  if (a.bull && ap.bear && k.c >= p.o && k.o <= p.c && a.body > ap.body * 1.05) push('engolfo de alta', 1, 1.1, 'corpo engole a vela anterior');
  if (a.bear && ap.bull && k.c <= p.o && k.o >= p.c && a.body > ap.body * 1.05) push('engolfo de baixa', -1, 1.1, 'corpo engole a vela anterior');
  if (k.h < p.h && k.l > p.l) push('inside bar (compressão)', 0, 0.5, 'amplitude interna à vela anterior');
  if (k.h > p.h && k.l < p.l) push(dirOf(k) > 0 ? 'outside bar de alta' : 'outside bar de baixa', dirOf(k), 0.8, 'amplitude engloba a vela anterior');

  /* ---- sequências e aceleração ---- */
  const seqDir = dirOf(k);
  if (seqDir !== 0 && dirOf(p) === seqDir && dirOf(p2) === seqDir) {
    push(seqDir > 0 ? 'sequência de alta (3 velas)' : 'sequência de baixa (3 velas)', seqDir, 0.9, 'três fechamentos na mesma direção');
  }
  const body3 = w3.reduce((s, x) => s + Math.abs(x.c - x.o), 0) / 3;
  const body10 = w10.reduce((s, x) => s + Math.abs(x.c - x.o), 0) / 10;
  if (body10 > 0 && body3 > body10 * 1.5) push('aceleração de movimento', seqDir, 0.7, `corpos recentes ${(body3 / body10).toFixed(2)}× a média de 10`);
  if (body10 > 0 && body3 < body10 * 0.6) push('perda de momentum', 0, 0.6, `corpos recentes ${(body3 / body10).toFixed(2)}× a média de 10`);

  /* ---- rompimentos ---- */
  const hi20 = Math.max(...w20.slice(0, -1).map(x => x.h));
  const lo20 = Math.min(...w20.slice(0, -1).map(x => x.l));
  if (k.c > hi20) push('rompimento de máxima de 20 velas', 1, 1, `fechou acima de ${hi20.toPrecision(8)}`);
  else if (k.h > hi20 && k.c < hi20) push('falso rompimento de máxima', -1, 1, 'furou a máxima e voltou para dentro');
  if (k.c < lo20) push('rompimento de mínima de 20 velas', -1, 1, `fechou abaixo de ${lo20.toPrecision(8)}`);
  else if (k.l < lo20 && k.c > lo20) push('falso rompimento de mínima', 1, 1, 'furou a mínima e voltou para dentro');

  /* ---- rejeição de zonas de suporte/resistência ---- */
  const zones = ctx.zones;
  if (zones) {
    const near = (z) => z && k.l <= z.high && k.h >= z.low;
    const sup = zones.nearestSupport;
    const res = zones.nearestResistance;
    if (near(sup) && k.c > sup.high * 0.99999 && a.lowerPct > 0.3) push('rejeição de suporte', 1, 1.1, `testou a zona ${sup.low.toPrecision(8)}–${sup.high.toPrecision(8)} e fechou acima`);
    if (near(res) && k.c < res.low * 1.00001 && a.upperPct > 0.3) push('rejeição de resistência', -1, 1.1, `testou a zona ${res.low.toPrecision(8)}–${res.high.toPrecision(8)} e fechou abaixo`);
  }

  const net = events.reduce((s, e) => s + e.dir * e.weight, 0);
  const dir = net > 0.6 ? 1 : net < -0.6 ? -1 : 0;

  /* ---- resumo em uma frase ---- */
  const strongest = events.slice().sort((a2, b2) => Math.abs(b2.dir * b2.weight) - Math.abs(a2.dir * a2.weight))[0];
  const closePos = (k.h - k.l) > 0 ? (k.c - k.l) / (k.h - k.l) : 0.5;
  const posTxt = closePos > 0.75 ? 'fechou perto da máxima' : closePos < 0.25 ? 'fechou perto da mínima' : 'fechou no meio da amplitude';
  const volTxt = ctx.volumeRel === null || ctx.volumeRel === undefined ? 'sem volume real na fonte'
    : ctx.volumeRel > 1.2 ? 'com volume acima da média'
      : ctx.volumeRel < 0.8 ? 'com volume abaixo da média' : 'com volume próximo da média';
  const summary = strongest
    ? `Última vela: ${strongest.name} — ${posTxt}, ${volTxt}${sizeVsAtr ? ` (amplitude ${sizeVsAtr.toFixed(2)}× o ATR)` : ''}.`
    : `Última vela sem padrão relevante — ${posTxt}, ${volTxt}${sizeVsAtr ? ` (amplitude ${sizeVsAtr.toFixed(2)}× o ATR)` : ''}.`;

  const wsum = (arr) => {
    const ups = arr.filter(x => dirOf(x) > 0).length;
    return { velas: arr.length, altas: ups, baixas: arr.filter(x => dirOf(x) < 0).length, variacaoPct: ((arr[arr.length - 1].c - arr[0].o) / arr[0].o) * 100 };
  };

  return {
    events, dir, net, summary,
    anatomy: { bodyPct: a.bodyPct, upperPct: a.upperPct, lowerPct: a.lowerPct, bull: a.bull },
    sizeVsAtr, bodyVsAvg, closePos,
    windows: { w3: wsum(w3), w5: wsum(w5), w10: wsum(w10), w20: wsum(w20) }
  };
}
