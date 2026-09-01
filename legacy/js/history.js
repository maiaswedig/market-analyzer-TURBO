// history.js — histórico de sinais (inclui AGUARDAR, para medir a distribuição real)
// + verificação automática do resultado quando a vela prevista fecha (novo fetch de candles reais).
import { store, uid } from './util.js';
import { getAsset, TIMEFRAMES } from './assets.js';
import { getCandles } from './data.js';

const KEY = 'ma_history_v2';
let cache = null;

export function loadHistory() {
  if (cache) return cache;
  cache = store.get(KEY, []) || [];
  return cache;
}
export function saveHistory(list) { cache = list; return store.set(KEY, list); }
export function clearHistory() { cache = []; store.set(KEY, []); }

/** Registra o resultado de uma análise. AGUARDAR entra como registro não operável (status N/A). */
export function addSignal(result, { origin = 'live-user', rankEligible = true } = {}) {
  if (!result || !result.snapshot || !result.score) return null;
  const list = loadHistory();
  const tfSec = TIMEFRAMES[result.tfKey].sec;
  const nowOpen = Math.floor(Date.now() / (tfSec * 1000)) * (tfSec * 1000);
  const isSignal = result.verdict === 'CALL' || result.verdict === 'PUT';
  const existing = list.find(r => r.assetId === result.asset.id && r.tf === result.tfKey && r.predictedCandleOpen === nowOpen);
  if (existing) {
    if (rankEligible && existing.rankEligible !== true) {
      existing.origin = origin; existing.rankEligible = true;
      existing.setupId = result.fingerprint ? result.fingerprint.id : existing.setupId;
      existing.setupLabel = result.fingerprint ? result.fingerprint.label : existing.setupLabel;
      saveHistory(list);
    }
    return null;
  }
  const est = result.decision ? result.decision.estimate : null;
  const rec = {
    id: uid(),
    createdAt: Date.now(),
    assetId: result.asset.id,
    assetName: result.asset.name,
    tf: result.tfKey,
    signal: result.verdict,
    score: result.score.score,
    bias100: result.score.bias100,
    grade: result.grade ? result.grade.grade : null,
    confluence: result.score.confluence ? result.score.confluence.text : null,
    condition: result.cond ? result.cond.label : null,
    // TRÊS métricas separadas, cada uma com origem e amostra
    modelProb: result.ml && result.ml.usable && result.ml.p !== null ? result.ml.p * 100 : null,
    histRate: result.hist && !result.hist.insufficient ? (result.score.direction > 0 ? result.hist.pUp : result.hist.pDown) * 100 : null,
    histSamples: result.hist ? result.hist.samples : 0,
    estimate: est && est.p !== null ? { p: est.p * 100, source: est.source, samples: est.samples } : null,
    ev: result.decision ? result.decision.ev : null,
    setupId: result.fingerprint ? result.fingerprint.id : null,
    setupLabel: result.fingerprint ? result.fingerprint.label : null,
    // Proveniência é obrigatória para que registros antigos ou resultados do
    // scanner não entrem por acidente no aprendizado do sinal ao vivo.
    origin,
    rankEligible: !!rankEligible && isSignal,
    refClose: result.snapshot.price,
    predictedCandleOpen: nowOpen,
    predictedCandleClose: nowOpen + tfSec * 1000,
    conditions: {
      buckets: result.snapshot.buckets, rsi: result.snapshot.rsi, alignment: result.snapshot.alignment,
      structure: result.snapshot.structure.label, atrPercentile: result.snapshot.atrPercentile,
      volumeRel: result.snapshot.volume.rel, adx: result.snapshot.adx
    },
    status: isSignal ? 'PENDENTE' : 'N/A',
    reasons: isSignal ? [] : (result.decision ? result.decision.reasons.slice(0, 4) : []),
    outcome: null, checkedAt: null
  };
  list.unshift(rec);
  saveHistory(list.slice(0, 3000));
  return rec;
}

/** Verifica os pendentes cuja vela prevista já fechou, buscando os candles reais novamente. */
export async function checkPending({ onUpdate } = {}) {
  const list = loadHistory();
  const now = Date.now();
  const pend = list.filter(r => r.status === 'PENDENTE' && r.predictedCandleClose < now - 3000);
  let changed = 0;
  const groups = new Map();
  for (const r of pend) {
    const k = r.assetId + '|' + r.tf;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, recs] of groups) {
    const [assetId, tf] = k.split('|');
    const asset = getAsset(assetId);
    if (!asset) continue;
    try {
      const d = await getCandles(asset, tf, { depth: 'live', force: true });
      for (const r of recs) {
        const c = d.candles.find(x => x.t === r.predictedCandleOpen);
        if (!c) continue;
        const dir = c.c > r.refClose ? 1 : c.c < r.refClose ? -1 : 0;
        const hit = (r.signal === 'CALL' && dir > 0) || (r.signal === 'PUT' && dir < 0);
        r.status = dir === 0 ? 'NEUTRO' : (hit ? 'ACERTO' : 'ERRO');
        r.outcome = { open: c.o, close: c.c, changePct: ((c.c - r.refClose) / r.refClose) * 100, source: d.source };
        r.checkedAt = Date.now();
        changed++;
      }
    } catch (e) {
      for (const r of recs) r.lastError = e.message;
    }
  }
  if (changed) saveHistory(list);
  if (onUpdate) onUpdate(changed);
  return changed;
}

export function filterHistory(list, f = {}) {
  return list.filter(r => {
    if (f.assetId && r.assetId !== f.assetId) return false;
    if (f.tf && r.tf !== f.tf) return false;
    if (f.signal && r.signal !== f.signal) return false;
    if (f.grade && r.grade !== f.grade) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.minScore !== undefined && f.minScore !== null && f.minScore !== '' && r.score < Number(f.minScore)) return false;
    if (f.maxScore !== undefined && f.maxScore !== null && f.maxScore !== '' && r.score > Number(f.maxScore)) return false;
    if (f.from && r.createdAt < new Date(f.from).getTime()) return false;
    if (f.to && r.createdAt > new Date(f.to).getTime() + 86400000) return false;
    return true;
  });
}

export function historyStats(list = loadHistory(), { payout = 0.85, stake = 5, operationCost = 0 } = {}) {
  const cost = Math.max(0, Number(operationCost) || 0);
  const operable = list.filter(r => r.signal === 'CALL' || r.signal === 'PUT');
  const done = operable.filter(r => r.status === 'ACERTO' || r.status === 'ERRO');
  const hits = done.filter(r => r.status === 'ACERTO').length;
  const group = (fn, src = done) => {
    const m = new Map();
    for (const r of src) {
      const k = fn(r);
      if (!m.has(k)) m.set(k, { key: k, total: 0, hits: 0 });
      const o = m.get(k); o.total++; if (r.status === 'ACERTO') o.hits++;
    }
    return [...m.values()].map(o => {
      const p = (o.hits + 1) / (o.total + 2);
      return { ...o, rate: o.total ? o.hits / o.total * 100 : null, ev: (p * payout - (1 - p)) * stake - cost };
    }).sort((a, b) => b.total - a.total);
  };
  const band = r => r.score >= 85 ? '85-100' : r.score >= 75 ? '75-84' : r.score >= 65 ? '65-74' : r.score >= 58 ? '58-64' : '<58';
  // evolução da taxa de acerto (ordem cronológica)
  const chrono = done.slice().sort((a, b) => a.createdAt - b.createdAt);
  let acc = 0;
  const evolution = chrono.map((r, i) => { if (r.status === 'ACERTO') acc++; return { t: r.createdAt, rate: acc / (i + 1) * 100, n: i + 1 }; });
  let bw = 0, bl = 0, cw = 0, cl = 0;
  for (const r of chrono) {
    if (r.status === 'ACERTO') { cw++; cl = 0; } else { cl++; cw = 0; }
    bw = Math.max(bw, cw); bl = Math.max(bl, cl);
  }
  const byAsset = group(r => r.assetName || r.assetId);
  const p = done.length ? (hits + 1) / (done.length + 2) : null;
  return {
    total: list.length, operable: operable.length,
    wait: list.filter(r => r.signal === 'AGUARDAR').length,
    callCount: list.filter(r => r.signal === 'CALL').length,
    putCount: list.filter(r => r.signal === 'PUT').length,
    pending: operable.filter(r => r.status === 'PENDENTE').length,
    neutros: operable.filter(r => r.status === 'NEUTRO').length,
    resolved: done.length, hits, errs: done.length - hits,
    rate: done.length ? hits / done.length * 100 : null,
    ev: p === null ? null : (p * payout - (1 - p)) * stake - cost,
    call: { total: done.filter(r => r.signal === 'CALL').length, hits: done.filter(r => r.signal === 'CALL' && r.status === 'ACERTO').length },
    put: { total: done.filter(r => r.signal === 'PUT').length, hits: done.filter(r => r.signal === 'PUT' && r.status === 'ACERTO').length },
    byAsset, byTf: group(r => r.tf), byHour: group(r => String(new Date(r.createdAt).getHours()).padStart(2, '0') + 'h'),
    byBand: group(band), byGrade: group(r => r.grade || '—'),
    bestStreak: bw, worstStreak: bl, evolution,
    setupRecords: done.filter(r => r.origin === 'live-user' && r.rankEligible === true)
      .map(r => ({
        id: r.id, assetId: r.assetId, tf: r.tf, setupId: r.setupId, setupLabel: r.setupLabel,
        signal: r.signal, result: r.status, origin: r.origin, emittedAt: r.createdAt, resolvedAt: r.checkedAt
      }))
  };
}

export function exportJson() { return JSON.stringify({ app: 'MARKET ANALYZER v2', exportedAt: new Date().toISOString(), signals: loadHistory() }, null, 2); }

export function exportCsv() {
  const list = loadHistory();
  const cols = ['id', 'criado_em', 'ativo', 'timeframe', 'sinal', 'score', 'vies', 'qualidade', 'confluencia', 'condicao', 'prob_modelo', 'taxa_historica', 'amostra_historica', 'estimativa_usada', 'origem_estimativa', 'ev', 'setup', 'preco_ref', 'vela_prevista', 'status', 'fechamento', 'variacao_pct'];
  const rows = list.map(r => [
    r.id, new Date(r.createdAt).toISOString(), r.assetName || r.assetId, r.tf, r.signal,
    r.score, r.bias100, r.grade, r.confluence, r.condition,
    r.modelProb === null || r.modelProb === undefined ? '' : r.modelProb.toFixed(2),
    r.histRate === null || r.histRate === undefined ? '' : r.histRate.toFixed(2), r.histSamples,
    r.estimate ? r.estimate.p.toFixed(2) : '', r.estimate ? r.estimate.source : '',
    r.ev === null || r.ev === undefined ? '' : r.ev.toFixed(4),
    r.setupLabel || '', r.refClose, new Date(r.predictedCandleOpen).toISOString(), r.status,
    r.outcome ? r.outcome.close : '', r.outcome ? r.outcome.changePct.toFixed(4) : ''
  ]);
  return [cols.join(',')].concat(rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))).join('\n');
}

export function importJson(text) {
  const data = JSON.parse(text);
  const incoming = Array.isArray(data) ? data : (data.signals || []);
  if (!Array.isArray(incoming)) throw new Error('formato inválido');
  const list = loadHistory();
  const ids = new Set(list.map(r => r.id));
  let added = 0;
  for (const r of incoming) {
    if (!r || !r.id || ids.has(r.id)) continue;
    list.push(r); ids.add(r.id); added++;
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  saveHistory(list.slice(0, 4000));
  return added;
}
