// score.js — SCORE POR CATEGORIAS (v2).
//
// MAPEAMENTO DOCUMENTADO (é isto que corrige o excesso de AGUARDAR da v1):
//  1. cada categoria devolve um viés b ∈ [−1, +1]  (+1 = totalmente comprador, −1 = vendedor)
//  2. sub-score da categoria = 50 + 50·b        → mercado neutro = 50, nunca ~20
//  3. viés final B = média ponderada dos b pelos pesos configurados
//  4. força = clamp((|B| − B0) / (B1 − B0), 0, 1)   com B0 = viés desprezível e B1 = viés máximo útil
//  5. score técnico = 50 + 50·força − penalidades
//     ⇒ mercado neutro ≈ 50 · confluência quase total ≈ 90–100 · leitura contraditória < 50
//     B0/B1 são defaults conservadores. Candidatos por ativo/timeframe devem ser
//     medidos em ordem temporal com tools/calibrate-score.mjs e só adotados
//     depois de validação fora da amostra; o script nunca altera estes defaults.
//  O score é FORÇA DE CONFLUÊNCIA, nunca taxa de acerto.
import { clamp } from './util.js';
import { zoneClearance } from './zones.js';

export const DEFAULT_WEIGHTS = {
  tendencia: 22, momentum: 18, multitf: 18, priceaction: 14, sr: 12, volatilidade: 8, volume: 8
};
export const CATEGORY_LABELS = {
  tendencia: 'Tendência', momentum: 'Momentum', multitf: 'Multi-TF',
  priceaction: 'Price Action', sr: 'S/R', volatilidade: 'Volatilidade', volume: 'Volume'
};
export const DEFAULT_SCORE_B0 = 0.06;     // default de produto; não é prova de edge estatístico
export const DEFAULT_SCORE_B1 = 0.45;     // default de produto; calibrar por ativo/timeframe fora da amostra

/**
 * @param snap snapshot do TF principal (features.js)
 * @param mtf  [{tf, dir, isMain}]
 * @param cond condição de mercado (condition.js) — opcional
 * @param cfg  { weights, toggles, scoreB0, scoreB1, minZoneAtr }
 */
export function computeScore(snap, mtf, cond = null, cfg = {}) {
  const W = Object.assign({}, DEFAULT_WEIGHTS, cfg.weights || {});
  const T = Object.assign({ ema: true, rsi: true, macd: true, stoch: true, volume: true, bollinger: true, estrutura: true, sr: true, priceaction: true, atr: true, multitf: true }, cfg.toggles || {});
  const B0 = Number.isFinite(Number(cfg.scoreB0)) ? Number(cfg.scoreB0) : DEFAULT_SCORE_B0;
  const B1 = Number.isFinite(Number(cfg.scoreB1)) ? Number(cfg.scoreB1) : DEFAULT_SCORE_B1;
  const categories = [];
  const add = (key, bias, detail, extra = {}) => {
    const w = W[key] || 0;
    if (w <= 0) return;
    const b = clamp(bias, -1, 1);
    categories.push({ key, label: CATEGORY_LABELS[key] || key, weight: w, bias: b, sub: Math.round((50 + 50 * b) * 10) / 10, detail, ...extra });
  };

  /* ---------------- Tendência (EMAs + estrutura HH/HL) ---------------- */
  if (T.ema) {
    let b = 0;
    b += (snap.alignment / 3) * 0.42;
    b += clamp(snap.emaSpread / 1.5, -1, 1) * 0.16;
    if (snap.slope9 !== null) b += clamp(snap.slope9 / 35, -1, 1) * 0.14;
    b += (snap.aboveLong || 0) * 0.10;
    if (T.estrutura) b += clamp(snap.structure.score / 2, -1, 1) * 0.18;
    add('tendencia', b,
      `alinhamento ${snap.alignment >= 0 ? '+' : ''}${snap.alignment}/3 · ${snap.structure.label} · preço ${snap.aboveLong > 0 ? 'acima' : 'abaixo'} da EMA longa`);
  }

  /* ---------------- Momentum ---------------- */
  {
    let b = 0, parts = [], n = 0;
    if (T.rsi && snap.rsi !== null) {
      let rb = clamp((snap.rsi - 50) / 18, -1, 1) * 0.6 + clamp(snap.rsiSlope / 7, -1, 1) * 0.4;
      if (snap.rsi > 74) rb -= 0.35;
      if (snap.rsi < 26) rb += 0.35;
      if (snap.rsiDiv) rb += snap.rsiDiv * 0.3;
      b += clamp(rb, -1, 1); n++;
      parts.push(`RSI ${snap.rsi.toFixed(1)}${snap.rsiDiv ? (snap.rsiDiv > 0 ? ' (divergência de alta)' : ' (divergência de baixa)') : ''}`);
    }
    if (T.macd && snap.macd.hist !== null) {
      const mb = clamp(snap.macd.hist / (snap.atr * 0.30), -1, 1) * 0.75 + snap.macd.cross * 0.25;
      b += clamp(mb, -1, 1); n++;
      parts.push(`MACD hist ${snap.macd.hist > 0 ? 'positivo' : 'negativo'}${snap.macd.cross ? ' com cruzamento' : ''}`);
    }
    if (T.stoch && snap.stoch.k !== null) {
      let sb = clamp((snap.stoch.k - 50) / 30, -1, 1) * 0.6;
      if (snap.stoch.d !== null) sb += clamp((snap.stoch.k - snap.stoch.d) / 8, -1, 1) * 0.4;
      if (snap.stoch.k > 88) sb -= 0.3;
      if (snap.stoch.k < 12) sb += 0.3;
      b += clamp(sb, -1, 1); n++;
      parts.push(`Estocástico ${snap.stoch.k.toFixed(0)}`);
    }
    if (snap.roc !== null) { b += clamp(snap.roc / 0.8, -1, 1) * 0.8; n += 0.8; parts.push(`ROC ${snap.roc.toFixed(2)}%`); }
    if (snap.plusDI !== null && snap.minusDI !== null) { b += clamp((snap.plusDI - snap.minusDI) / 18, -1, 1); n++; parts.push(`+DI ${snap.plusDI.toFixed(0)} / −DI ${snap.minusDI.toFixed(0)}`); }
    add('momentum', n ? b / n : 0, parts.join(' · ') || 'sem dados de momentum');
  }

  /* ---------------- Multi-timeframe (confluência) ---------------- */
  if (T.multitf) {
    const others = mtf.filter(m => !m.isMain && !m.unavailable);
    const main = mtf.find(m => m.isMain);
    let b = 0;
    if (others.length) {
      // contexto pesa por proximidade: TFs mais próximos do principal contam um pouco mais
      const sum = others.reduce((s, m) => s + m.dir, 0);
      b = sum / others.length;
      if (main && main.dir !== 0) b = b * 0.75 + main.dir * 0.25;
    } else if (main) b = main.dir * 0.5;
    add('multitf', b, mtf.map(m => `${m.tf}:${m.unavailable ? 'n/d' : m.dir > 0 ? 'alta' : m.dir < 0 ? 'baixa' : 'neutro'}`).join(' · '),
      { confluence: confluenceOf(mtf) });
  }

  /* ---------------- Price Action ---------------- */
  if (T.priceaction) {
    const pa = snap.priceAction;
    add('priceaction', clamp(pa.net / 2.2, -1, 1), pa.events.length ? pa.events.map(e => e.name).join(', ') : 'nenhum padrão relevante nas últimas velas');
  }

  /* ---------------- Suporte / Resistência (zonas) ---------------- */
  if (T.sr) {
    const z = snap.zones;
    const dR = snap.distR, dS = snap.distS;
    let b = 0; const detail = [];
    if (dR !== null && dS !== null) {
      const sR = (z.nearestResistance.strength || 1) / 5, sS = (z.nearestSupport.strength || 1) / 5;
      const pressR = clamp((1.8 - dR) / 1.8, 0, 1) * (0.5 + sR * 0.5);
      const pressS = clamp((1.8 - dS) / 1.8, 0, 1) * (0.5 + sS * 0.5);
      b = pressS - pressR;
      detail.push(`resistência a ${dR.toFixed(2)} ATR (força ${z.nearestResistance.strength})`);
      detail.push(`suporte a ${dS.toFixed(2)} ATR (força ${z.nearestSupport.strength})`);
    } else if (dR !== null) { b = -clamp((1.8 - dR) / 1.8, 0, 1) * 0.7; detail.push(`resistência a ${dR.toFixed(2)} ATR`); }
    else if (dS !== null) { b = clamp((1.8 - dS) / 1.8, 0, 1) * 0.7; detail.push(`suporte a ${dS.toFixed(2)} ATR`); }
    add('sr', b, detail.join(' · ') || 'nenhuma zona próxima mapeada');
  }

  /* ---------------- Volatilidade ---------------- */
  if (T.atr) {
    const ap = snap.atrPercentile, bwp = snap.bb.bwPercentile;
    let quality = 0;
    if (ap !== null) quality = ap > 92 ? -0.8 : ap < 12 ? -0.5 : (ap > 35 && ap < 82) ? 0.7 : 0.2;
    if (bwp !== null && bwp < 12) quality -= 0.3;
    const dirHint = Math.sign(snap.alignment);
    add('volatilidade', clamp(quality * dirHint, -1, 1),
      `ATR percentil ${ap === null ? '—' : ap.toFixed(0)} · largura BB percentil ${bwp === null ? '—' : bwp.toFixed(0)}${bwp !== null && bwp < 12 ? ' (squeeze)' : ''}`);
  }

  /* ---------------- Volume ---------------- */
  if (T.volume) {
    if (!snap.volume.available) {
      const w = W.volume || 0;
      if (w > 0) categories.push({ key: 'volume', label: 'Volume', weight: w, bias: 0, sub: 50, detail: 'fonte sem volume real — fator neutralizado', neutralized: true });
    } else {
      const dirLast = Math.sign(snap.candle.c - snap.candle.o);
      const rel = snap.volume.rel;
      let b = dirLast * clamp((rel - 0.9) / 1.0, -0.3, 1);
      if (rel < 0.7) b = dirLast * -0.3;
      add('volume', b, `volume relativo ${rel.toFixed(2)}× a média ${snap.volume.rising ? '(crescendo)' : '(caindo)'}`);
    }
  }

  /* ---------------- consolidação ---------------- */
  const wSum = categories.reduce((s, c) => s + c.weight, 0) || 1;
  const B = categories.reduce((s, c) => s + c.weight * c.bias, 0) / wSum;
  const bias100 = Math.round((50 + 50 * B) * 10) / 10;
  const direction = Math.abs(B) < 0.02 ? 0 : (B > 0 ? 1 : -1);
  const strength = clamp((Math.abs(B) - B0) / Math.max(1e-6, B1 - B0), 0, 1);
  const rawScore = 50 + 50 * strength;

  /* ---------------- penalidades ---------------- */
  const penalties = [];
  const pen = (name, value, blocking = false, detail = '') => { if (value > 0) penalties.push({ name, value: Math.round(value * 10) / 10, blocking, detail }); };

  const conflicting = mtf.filter(m => !m.isMain && !m.unavailable && m.dir !== 0 && direction !== 0 && m.dir !== direction);
  if (conflicting.length) pen(`Conflito com timeframes de contexto (${conflicting.map(c => c.tf).join(', ')})`, Math.min(12, conflicting.length * 4.5));

  // Zona colada na direção do sinal → penalidade e, abaixo do mínimo, BLOQUEIO explícito
  let clearance = null;
  if (direction !== 0) {
    clearance = zoneClearance(snap.zones, direction, cfg);
    if (clearance.penalty > 0) pen(`Zona de ${direction > 0 ? 'resistência' : 'suporte'} próxima`, clearance.penalty * 0.7, clearance.blocked, clearance.reason);
  }

  if (direction > 0 && snap.rsi !== null && snap.rsi > 78) pen('RSI muito esticado (sobrecompra)', 6);
  if (direction < 0 && snap.rsi !== null && snap.rsi < 22) pen('RSI muito esticado (sobrevenda)', 6);
  if (snap.bb.bwPercentile !== null && snap.bb.bwPercentile < 10 && Math.abs(snap.alignment) <= 1) pen('Squeeze de volatilidade sem direção definida', 6);
  if (!snap.volume.available) pen('Volume real ausente na fonte', 3, false, 'fator volume neutralizado');
  else if (snap.volume.rel !== null && snap.volume.rel < 0.6) pen('Volume muito abaixo da média', 4);
  if (snap.patterns.klass === 3) pen('Padrão de indecisão no último candle', 4);
  if (cond) {
    if (cond.penalty > 0) pen(`Condição de mercado: ${cond.label}`, cond.penalty);
    if (cond.abnormal) pen('Condição anormal (evento extremo)', 10, true, cond.extremes.join(' · '));
  }

  const penaltyTotal = penalties.reduce((s, p) => s + p.value, 0);
  const score = Math.round(clamp(rawScore - penaltyTotal, 0, 100) * 10) / 10;
  const blocking = penalties.filter(p => p.blocking);

  return {
    direction, bias: B, bias100, categories, scale: { B0, B1 }, strength,
    base: Math.round(rawScore * 10) / 10,
    score, penalties, penaltyTotal: Math.round(penaltyTotal * 10) / 10, blocking, clearance,
    confluence: confluenceOf(mtf)
  };
}

export function confluenceOf(mtf) {
  const usable = mtf.filter(m => !m.unavailable);
  if (!usable.length) return { agree: 0, total: 0, dir: 0, text: '0/0' };
  const up = usable.filter(m => m.dir > 0).length;
  const down = usable.filter(m => m.dir < 0).length;
  const dir = up > down ? 1 : down > up ? -1 : 0;
  const agree = dir > 0 ? up : dir < 0 ? down : 0;
  return { agree, total: usable.length, dir, text: `${agree}/${usable.length}` };
}

// Direção resumida de um TF (tabela multi-TF)
export function tfDirection(snap) {
  if (!snap) return 0;
  let s = 0;
  s += snap.alignment / 3;
  s += clamp(snap.structure.score / 2, -1, 1) * 0.8;
  if (snap.macd.hist !== null) s += Math.sign(snap.macd.hist) * 0.5;
  if (snap.rsi !== null) s += clamp((snap.rsi - 50) / 25, -1, 1) * 0.5;
  if (s > 0.5) return 1;
  if (s < -0.5) return -1;
  return 0;
}

/**
 * Nota do setup: A+ / A / B / C / D.
 * Documentado no tooltip da UI: soma de pontos, com limiares fixos.
 */
export function setupGrade({ score, confluence, cond, penaltyTotal, setupStats = null, blocked = false, warningCount = 0 }) {
  const detail = [];
  let pts = 0;
  if (score >= 82) { pts += 2.5; detail.push('score ≥ 82 (+2,5)'); }
  else if (score >= 72) { pts += 2; detail.push('score ≥ 72 (+2)'); }
  else if (score >= 64) { pts += 1.25; detail.push('score ≥ 64 (+1,25)'); }
  else if (score >= 56) { pts += 0.5; detail.push('score ≥ 56 (+0,5)'); }
  else detail.push('score < 56 (0)');

  if (confluence && confluence.total) {
    const ratio = confluence.agree / confluence.total;
    if (ratio === 1) { pts += 1.5; detail.push('confluência total (+1,5)'); }
    else if (ratio >= 0.75) { pts += 1; detail.push('confluência ≥ 3/4 (+1)'); }
    else if (ratio >= 0.5) { pts += 0.25; detail.push('confluência ≥ 1/2 (+0,25)'); }
    else { pts -= 0.5; detail.push('confluência fraca (−0,5)'); }
  }
  if (cond) {
    if (cond.key === 'TREND_STRONG') { pts += 1; detail.push('tendência forte (+1)'); }
    else if (cond.key === 'TREND_MOD') { pts += 0.5; detail.push('tendência moderada (+0,5)'); }
    else if (cond.key === 'RANGE') { pts -= 0.5; detail.push('mercado lateral (−0,5)'); }
    else { pts -= 1.5; detail.push('condição ruim (−1,5)'); }
    if (cond.abnormal) { pts -= 1.5; detail.push('evento extremo (−1,5)'); }
  }
  if (penaltyTotal <= 3) { pts += 0.5; detail.push('quase sem penalidades (+0,5)'); }
  else if (penaltyTotal > 14) { pts -= 1; detail.push('penalidades altas (−1)'); }

  if (setupStats && setupStats.samples >= (setupStats.minSamples || 20)) {
    if (setupStats.ev > 0 && setupStats.rate >= 55) { pts += 1; detail.push(`classe de setup histórica favorável (+1, ${setupStats.samples} amostras)`); }
    else if (setupStats.ev < 0) { pts -= 1; detail.push(`classe de setup histórica desfavorável (−1, ${setupStats.samples} amostras)`); }
  }
  const warnings = Math.max(0, Math.min(3, Math.round(Number(warningCount) || 0)));
  if (warnings) {
    const deduction = warnings * 0.25;
    pts -= deduction;
    detail.push(`${warnings} divergência(s) técnica(s) menor(es) (−${String(deduction).replace('.', ',')})`);
  }
  // O bloqueio continua impedindo o sinal; a nota, porém, ainda precisa mostrar
  // a qualidade relativa do gráfico para que a lista não vire uma parede de D.
  // A penalização forte de segurança é aplicada separadamente no ranking.
  if (blocked) { pts -= 0.75; detail.push('bloqueio operacional separado da qualidade (−0,75)'); }

  const grade = pts >= 5 ? 'A+' : pts >= 3.75 ? 'A' : pts >= 2.5 ? 'B' : pts >= 1.25 ? 'C' : 'D';
  return { grade, points: Math.round(pts * 100) / 100, detail };
}
