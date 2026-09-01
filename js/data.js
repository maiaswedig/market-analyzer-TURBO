// data.js — camada de dados: provedores públicos gratuitos, sem chave de API.
// NUNCA gera candles sintéticos: se todas as fontes falharem, devolve erro explícito.
import { TIMEFRAMES } from './assets.js';
import { queue, sleep } from './util.js';

const CACHE = new Map();          // chave -> { at, payload }
export const providerHealth = {}; // nome do provedor -> { ok, at, msg }

function health(name, ok, msg = '') { providerHealth[name] = { ok, at: Date.now(), msg }; }

// Profundidades de histórico (alvo de candles). 'deep' é o que alimenta analogia/ML/backtest.
export const DEPTH_TARGET = { live: 300, context: 400, mid: 1500, deep: 6000 };

function cacheKey(assetId, tf, depth, target, includeLive) { return `${assetId}|${tf}|${depth}|${target}|${includeLive ? 'live' : 'closed'}`; }
function ttlFor(tfSec) { return Math.max(8000, Math.round(tfSec * 1000 / 3)); }

function freshness(payload, tfKey) {
  const now = Date.now();
  const tfMs = TIMEFRAMES[tfKey].sec * 1000;
  const updatedAt = Number(payload.updatedAt) || now;
  const lastCandleTime = Number(payload.lastCandleTime) || null;
  return {
    ...payload,
    // "idade" é o tempo desde a última resposta recebida; "idade do candle"
    // continua disponível separadamente para não confundir uma vela em formação
    // com atraso de rede.
    dataAgeMs: Math.max(0, now - updatedAt),
    candleAgeMs: lastCandleTime ? Math.max(0, now - lastCandleTime) : null,
    latencyLimitMs: Math.round(tfMs * 1.5)
  };
}

export function clearCache() { CACHE.clear(); }

/* ---------------------------------------------------------------- utilitários */
export function resample(candles, toSec) {
  const toMs = toSec * 1000;
  const out = [];
  let cur = null;
  for (const k of candles) {
    const bucket = Math.floor(k.t / toMs) * toMs;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v || 0 };
    } else {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.v += (k.v || 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function sortAsc(a) { return a.slice().sort((x, y) => x.t - y.t); }
function dedupe(a) {
  const out = [];
  for (const k of a) { if (!out.length || out[out.length - 1].t !== k.t) out.push(k); else out[out.length - 1] = k; }
  return out;
}
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function validCandle(k) {
  return k && [k.o, k.h, k.l, k.c].every(v => Number.isFinite(v) && v > 0) && k.h >= k.l;
}

async function jfetch(url, { timeout = 14000, asText = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return asText ? await r.text() : await r.json();
  } finally { clearTimeout(t); }
}

/* ---------------------------------------------------------------- CRIPTO */
const OKX_BARS = { M1: '1m', M5: '5m', M15: '15m', M30: '30m', H1: '1H', H4: '4H' };

// OKX: /market/candles (recentes) + /market/history-candles com paginação por `after`
// (limite 300 por página, validado). Alvo de candles definido por `target`.
async function okxCandles(instId, tfKey, target, onProgress, includeLive = false) {
  const bar = OKX_BARS[tfKey];
  if (!bar) throw new Error('timeframe não suportado pela OKX: ' + tfKey);
  const map = row => ({ t: Number(row[0]), o: num(row[1]), h: num(row[2]), l: num(row[3]), c: num(row[4]), v: num(row[5]) || 0, closed: row[8] === '1' });
  const first = await queue.add(() => jfetch(`https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=300`));
  if (!first || first.code !== '0' || !Array.isArray(first.data) || !first.data.length) throw new Error('OKX sem dados para ' + instId);
  let all = first.data.map(map);
  let oldest = all[all.length - 1].t;
  const maxPages = Math.ceil(Math.max(0, target - all.length) / 300) + 4;
  let guard = 0;
  while (all.length < target && guard++ < maxPages) {
    const page = await queue.add(() => jfetch(`https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${bar}&after=${oldest}&limit=300`));
    if (!page || page.code !== '0' || !Array.isArray(page.data) || !page.data.length) break;
    const rows = page.data.map(map);
    all = all.concat(rows);
    const newOldest = rows[rows.length - 1].t;
    if (!newOldest || newOldest >= oldest) break;
    oldest = newOldest;
    if (onProgress) onProgress(Math.min(1, all.length / target), all.length);
  }
  let candles = dedupe(sortAsc(all)).filter(validCandle);
  if (!includeLive && candles.length && candles[candles.length - 1].closed === false) candles = candles.slice(0, -1);
  return { candles, source: 'OKX', aggregatedFrom: null, hasVolume: true };
}

const CB_GRAN = { M1: 60, M5: 300, M15: 900, H1: 3600 };
async function coinbaseCandles(product, tfKey) {
  const baseTf = CB_GRAN[tfKey] ? tfKey : (TIMEFRAMES[tfKey].sec % 900 === 0 ? 'M15' : 'M5');
  const gran = CB_GRAN[baseTf];
  const raw = await queue.add(() => jfetch(`https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=${gran}`));
  if (!Array.isArray(raw) || !raw.length) throw new Error('Coinbase sem dados');
  let candles = dedupe(sortAsc(raw.map(r => ({ t: Number(r[0]) * 1000, l: num(r[1]), h: num(r[2]), o: num(r[3]), c: num(r[4]), v: num(r[5]) || 0 })))).filter(validCandle);
  let aggregated = null;
  if (baseTf !== tfKey) { candles = resample(candles, TIMEFRAMES[tfKey].sec); aggregated = TIMEFRAMES[baseTf].label; }
  return { candles, source: 'Coinbase Exchange', aggregatedFrom: aggregated, hasVolume: true };
}

const KR_INT = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240 };
async function krakenCandles(pair, tfKey) {
  const baseTf = KR_INT[tfKey] ? tfKey : 'M1';
  const raw = await queue.add(() => jfetch(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${KR_INT[baseTf]}`));
  if (!raw || !raw.result) throw new Error('Kraken sem dados');
  const key = Object.keys(raw.result).find(k => k !== 'last');
  const rows = raw.result[key];
  if (!Array.isArray(rows) || !rows.length) throw new Error('Kraken sem dados');
  let candles = dedupe(sortAsc(rows.map(r => ({ t: Number(r[0]) * 1000, o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[6]) || 0 })))).filter(validCandle);
  let aggregated = null;
  if (baseTf !== tfKey) { candles = resample(candles, TIMEFRAMES[tfKey].sec); aggregated = TIMEFRAMES[baseTf].label; }
  return { candles, source: 'Kraken', aggregatedFrom: aggregated, hasVolume: true, maxHistory: 720 };
}

/* ---------------------------------------------------------------- YAHOO + PROXIES CORS */
const YF_PLAN = {
  M1: { interval: '1m', range: '5d', deepRange: '7d', base: 'M1' },
  M5: { interval: '5m', range: '5d', deepRange: '1mo', base: 'M5' },
  M15: { interval: '15m', range: '1mo', deepRange: '2mo', base: 'M15' },
  M30: { interval: '30m', range: '1mo', deepRange: '2mo', base: 'M30' },
  H1: { interval: '60m', range: '3mo', deepRange: '6mo', base: 'H1' },
  H4: { interval: '60m', range: '6mo', deepRange: '1y', base: 'H1' }
};

const PROXIES = [
  { name: 'allorigins(get)', build: u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, parse: async r => JSON.parse(r.contents), asText: false },
  { name: 'allorigins(raw)', build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, parse: async r => r, asText: false },
  { name: 'codetabs', build: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`, parse: async r => r, asText: false },
  { name: 'corsproxy.io', build: u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`, parse: async r => r, asText: false },
  { name: 'Yahoo direto', build: u => u, parse: async r => r, asText: false }
];

const proxyCooldown = new Map();
const COOLDOWN_MS = 40000;

async function yahooChart(symbol, interval, range) {
  const yurl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const errors = [];
  const now = Date.now();
  const deadline = now + 18000;
  let candidates = PROXIES.filter(p => !(proxyCooldown.get(p.name) > now));
  if (!candidates.length) {
    const soonest = PROXIES.slice().sort((a, b) => (proxyCooldown.get(a.name) || 0) - (proxyCooldown.get(b.name) || 0))[0];
    candidates = [soonest];
  }
  for (const p of candidates) {
    if (Date.now() > deadline) { errors.push('tempo esgotado'); break; }
    const tries = p.name === 'allorigins(get)' ? 2 : 1;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (Date.now() > deadline) { errors.push('tempo esgotado'); break; }
      try {
        const raw = await queue.add(() => jfetch(p.build(yurl), { timeout: 8000, asText: p.asText }));
        const json = await p.parse(raw);
        const res = json && json.chart && json.chart.result && json.chart.result[0];
        if (!res || !res.timestamp) throw new Error('resposta sem candles');
        health('Yahoo/' + p.name, true);
        proxyCooldown.delete(p.name);
        return { res, via: p.name };
      } catch (e) {
        errors.push(`${p.name}: ${e.message}`);
        health('Yahoo/' + p.name, false, e.message);
        if (attempt === tries - 1) proxyCooldown.set(p.name, Date.now() + COOLDOWN_MS);
        else await sleep(400);
      }
    }
  }
  throw new Error('fonte indisponível — ' + errors.slice(0, 4).join(' | '));
}

async function yahooCandles(symbol, tfKey, deep) {
  const plan = YF_PLAN[tfKey];
  const range = deep && plan.deepRange ? plan.deepRange : plan.range;
  let out;
  try {
    out = await yahooChart(symbol, plan.interval, range);
  } catch (e) {
    if (range !== plan.range) out = await yahooChart(symbol, plan.interval, plan.range);
    else throw e;
  }
  const { res, via } = out;
  const ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const k = { t: ts[i] * 1000, o: num(q.open && q.open[i]), h: num(q.high && q.high[i]), l: num(q.low && q.low[i]), c: num(q.close && q.close[i]), v: num(q.volume && q.volume[i]) || 0 };
    if (validCandle(k)) candles.push(k);
  }
  if (candles.length < 30) throw new Error('histórico insuficiente devolvido pela fonte');
  let list = dedupe(sortAsc(candles));
  const volSum = list.reduce((s, k) => s + (k.v || 0), 0);
  let aggregated = null;
  if (plan.base !== tfKey) { list = resample(list, TIMEFRAMES[tfKey].sec); aggregated = TIMEFRAMES[plan.base].label; }
  return {
    candles: list,
    source: `Yahoo Finance · ${via}`,
    aggregatedFrom: aggregated,
    hasVolume: volSum > 0,
    meta: res.meta || null
  };
}

/* ---------------------------------------------------------------- API pública */
/**
 * @param opts { depth:'live'|'context'|'mid'|'deep', target?:number, force?:boolean, includeLive?:boolean, onProgress? }
 */
export async function getCandles(asset, tfKey, opts = {}) {
  const depth = opts.depth || 'live';
  const target = Math.max(120, opts.target || DEPTH_TARGET[depth] || 300);
  const includeLive = !!opts.includeLive;
  const key = cacheKey(asset.id, tfKey, depth, target, includeLive);
  const ttl = ttlFor(TIMEFRAMES[tfKey].sec);
  const hit = CACHE.get(key);
  if (!opts.force && hit && Date.now() - hit.at < ttl) return freshness({ ...hit.payload, cached: true }, tfKey);

  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const errors = [];
  const attempts = [];
  const deepFlag = depth === 'deep' || depth === 'mid';
  if (asset.kind === 'crypto') {
    if (asset.okx) attempts.push(['OKX', () => okxCandles(asset.okx, tfKey, target, opts.onProgress, includeLive)]);
    if (asset.coinbase) attempts.push(['Coinbase', () => coinbaseCandles(asset.coinbase, tfKey)]);
    if (asset.kraken) attempts.push(['Kraken', () => krakenCandles(asset.kraken, tfKey)]);
  } else if (asset.kind === 'fx') {
    if (asset.kraken) attempts.push(['Kraken', () => krakenCandles(asset.kraken, tfKey)]);
    if (asset.yahoo) attempts.push(['Yahoo', () => yahooCandles(asset.yahoo, tfKey, deepFlag)]);
  } else {
    attempts.push(['Yahoo', () => yahooCandles(asset.yahoo, tfKey, deepFlag)]);
  }

  for (const [name, fn] of attempts) {
    try {
      const r = await fn();
      if (!r.candles || r.candles.length < 30) throw new Error('poucos candles');
      // Sinal ao vivo pode incluir a vela em formação; treino e backtest pedem
      // apenas velas fechadas para não rotular uma barra ainda incompleta.
      const tfMs = TIMEFRAMES[tfKey].sec * 1000;
      const now = Date.now();
      r.candles = r.candles.filter(k => includeLive ? k.t <= now + 1000 : (k.t + tfMs) <= now + 1000)
        .map(k => ({ ...k, live: (k.t + tfMs) > now }));
      if (r.candles.length < 30) throw new Error('poucos candles disponíveis');
      health(name, true);
      const payload = {
        ...r,
        depth, target,
        latencyMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
        updatedAt: Date.now(),
        lastCandleTime: r.candles[r.candles.length - 1].t,
        count: r.candles.length,
        error: null,
        cached: false
      };
      CACHE.set(key, { at: Date.now(), payload });
      return freshness(payload, tfKey);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      health(name, false, e.message);
    }
  }
  if (hit) return freshness({ ...hit.payload, cached: true, stale: true, error: 'fonte indisponível (dados em cache): ' + errors.join(' | ') }, tfKey);
  const err = new Error('fonte indisponível: ' + errors.join(' | '));
  err.isDataError = true;
  throw err;
}

export async function getCandleAt(asset, tfKey, timeMs) {
  const r = await getCandles(asset, tfKey, { depth: 'live', force: true });
  const k = r.candles.find(c => c.t === timeMs);
  return { candle: k || null, source: r.source, candles: r.candles };
}

export function candleWindow(tfSec, nowMs = Date.now()) {
  // O sinal é calculado com base na vela atual/último candle disponível,
  // então a janela exibida precisa ser SEMPRE a próxima vela, não a que está em andamento.
  const ms = tfSec * 1000;
  const currentOpen = Math.floor(nowMs / ms) * ms;
  const open = currentOpen + ms;
  return {
    open,
    close: open + ms,
    remaining: open - nowMs,
    currentOpen,
    currentClose: currentOpen + ms
  };
}
