// patterns.js — padrões de candles. Nenhum padrão isolado gera sinal (peso limitado no score).
export function candleAnatomy(k) {
  const range = Math.max(1e-12, k.h - k.l);
  const body = Math.abs(k.c - k.o);
  const upper = k.h - Math.max(k.c, k.o);
  const lower = Math.min(k.c, k.o) - k.l;
  return { range, body, upper, lower, bodyPct: body / range, upperPct: upper / range, lowerPct: lower / range, bull: k.c > k.o, bear: k.c < k.o };
}

/**
 * Detecta padrões no último candle de `candles.slice(0, upTo)`.
 * Retorna { list:[{name, dir, weight}], dir: -1|0|1, classe: 0..3 }
 */
export function detectPatterns(candles, upTo = candles.length, avgRange = null) {
  const n = upTo;
  if (n < 3) return { list: [], dir: 0, klass: 0 };
  const k = candles[n - 1], p = candles[n - 2], p2 = candles[n - 3];
  const a = candleAnatomy(k), ap = candleAnatomy(p);
  const list = [];
  const ar = avgRange || (candles.slice(Math.max(0, n - 21), n).reduce((s, x) => s + (x.h - x.l), 0) / Math.min(20, n));

  // Engolfo
  if (a.bull && ap.bear && k.c >= p.o && k.o <= p.c && a.body > ap.body * 1.05) list.push({ name: 'engolfo de alta', dir: 1, weight: 1 });
  if (a.bear && ap.bull && k.c <= p.o && k.o >= p.c && a.body > ap.body * 1.05) list.push({ name: 'engolfo de baixa', dir: -1, weight: 1 });

  // Martelo / estrela cadente / pin bar
  if (a.lowerPct > 0.55 && a.bodyPct < 0.35 && a.upperPct < 0.2) list.push({ name: a.bull ? 'martelo' : 'pin bar de alta', dir: 1, weight: 1 });
  if (a.upperPct > 0.55 && a.bodyPct < 0.35 && a.lowerPct < 0.2) list.push({ name: a.bear ? 'estrela cadente' : 'pin bar de baixa', dir: -1, weight: 1 });

  // Doji / indecisão
  if (a.bodyPct < 0.12) list.push({ name: 'doji (indecisão)', dir: 0, weight: 0.5 });

  // Marubozu / vela de força
  if (a.bodyPct > 0.85 && a.range > ar * 1.2) list.push({ name: a.bull ? 'marubozu de alta (vela de força)' : 'marubozu de baixa (vela de força)', dir: a.bull ? 1 : -1, weight: 1 });

  // Sequência de 3 velas na mesma direção
  const dirOf = x => x.c > x.o ? 1 : x.c < x.o ? -1 : 0;
  if (dirOf(k) !== 0 && dirOf(k) === dirOf(p) && dirOf(p) === dirOf(p2)) {
    list.push({ name: dirOf(k) > 0 ? 'três velas de alta seguidas' : 'três velas de baixa seguidas', dir: dirOf(k), weight: 0.8 });
  }

  // Pavio de rejeição relevante
  if (a.upper > ar * 0.8 && a.upperPct > 0.4) list.push({ name: 'rejeição no topo (pavio superior)', dir: -1, weight: 0.7 });
  if (a.lower > ar * 0.8 && a.lowerPct > 0.4) list.push({ name: 'rejeição no fundo (pavio inferior)', dir: 1, weight: 0.7 });

  // Inside bar
  if (k.h < p.h && k.l > p.l) list.push({ name: 'inside bar (compressão)', dir: 0, weight: 0.4 });

  const net = list.reduce((s, x) => s + x.dir * x.weight, 0);
  const dir = net > 0.5 ? 1 : net < -0.5 ? -1 : 0;
  const indecision = list.some(x => x.dir === 0);
  const klass = dir === 1 ? 1 : dir === -1 ? 2 : indecision ? 3 : 0;
  return { list, dir, net, klass };
}
