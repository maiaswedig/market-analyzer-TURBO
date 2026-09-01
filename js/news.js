// news.js — trava de calendário econômico para o navegador.
// Fontes públicas são tratadas como confirmação adicional: se uma falhar, a UI
// deixa isso explícito em vez de inventar uma agenda de notícias.

const CACHE_MS = 5 * 60 * 1000;
const MAX_STALE_MS = 6 * 60 * 60 * 1000;
let cached = { at: 0, events: null, source: null, error: null };

const countryCurrency = {
  'united states': 'USD', usa: 'USD', us: 'USD', usd: 'USD',
  'euro zone': 'EUR', 'euro area': 'EUR', europe: 'EUR', eur: 'EUR',
  'united kingdom': 'GBP', uk: 'GBP', gbp: 'GBP'
};

function currencyFor(value) {
  const text = String(value || '').trim().toLowerCase();
  return countryCurrency[text] || (text.includes('united states') ? 'USD' : text.includes('euro') ? 'EUR' : text.includes('united kingdom') ? 'GBP' : null);
}
function dateStamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function parseTimestamp(value) {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
function highImpact(item) {
  const importance = Number(item.Importance ?? item.importance ?? 0);
  const impact = String(item.Impact ?? item.impact ?? '').toLowerCase();
  return importance >= 3 || /high|red|alto/.test(impact);
}
function normalizeForexFactory(rows) {
  return (Array.isArray(rows) ? rows : []).filter(highImpact).map(row => {
    const currency = currencyFor(row.country || row.currency);
    const at = parseTimestamp(row.date || row.Date);
    return currency && at ? { at, currency, title: String(row.title || row.event || 'Evento econômico'), impact: 'high', source: 'Forex Factory' } : null;
  }).filter(Boolean);
}
function normalizeTradingEconomics(rows) {
  return (Array.isArray(rows) ? rows : []).filter(highImpact).map(row => {
    const currency = currencyFor(row.Country || row.country);
    const at = parseTimestamp(row.Date || row.date);
    return currency && at ? { at, currency, title: String(row.Event || row.Category || row.event || 'Evento econômico'), impact: 'high', source: 'Trading Economics' } : null;
  }).filter(Boolean);
}
async function jsonFetch(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally { clearTimeout(timer); }
}

async function loadCalendar(now) {
  // Fonte pública simples para uso em navegador. A resposta é normalizada e
  // limitada a eventos de alto impacto das moedas suportadas.
  try {
    const rows = await jsonFetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    return { events: normalizeForexFactory(rows), source: 'Forex Factory', error: null };
  } catch (firstError) {
    // Reserva documentada. O plano guest pode variar; se não responder, a
    // aplicação informa a indisponibilidade, sem transformar isso em notícia.
    const from = dateStamp(now - 24 * 3600e3), to = dateStamp(now + 2 * 24 * 3600e3);
    const url = `https://api.tradingeconomics.com/calendar/country/united%20states,euro%20area,united%20kingdom/${from}/${to}?c=guest:guest&f=json`;
    try {
      const rows = await jsonFetch(url);
      return { events: normalizeTradingEconomics(rows), source: 'Trading Economics', error: null };
    } catch (secondError) {
      throw new Error(`calendário indisponível (${firstError.message}; ${secondError.message})`);
    }
  }
}

function validCalendar(value, now, maxAge = MAX_STALE_MS) {
  return !!(value && Array.isArray(value.events) && Number.isFinite(Number(value.at)) && now - Number(value.at) <= maxAge);
}

export async function highImpactCalendar(now = Date.now(), persisted = null) {
  // Uma agenda válida salva pela sessão anterior reduz a janela sem cobertura
  // enquanto a consulta atual é refeita; nunca é aceita por mais de seis horas.
  if (validCalendar(persisted, now) && (!validCalendar(cached, now) || Number(persisted.at) > Number(cached.at))) {
    cached = { at: Number(persisted.at), events: persisted.events, source: persisted.source || null, error: null };
  }
  if (cached.events && now - cached.at < CACHE_MS) return { ...cached, cached: true };
  try {
    const loaded = await loadCalendar(now);
    cached = { at: now, ...loaded };
  } catch (error) {
    if (validCalendar(cached, now)) {
      cached = { ...cached, error: error.message || String(error), stale: true };
    } else {
      cached = { at: now, events: null, source: null, error: error.message || String(error) };
    }
  }
  return { ...cached, cached: false };
}

export function currenciesForAsset(asset, cfg = {}) {
  if (!asset || (asset.group !== 'Forex' && cfg.newsApplyCryptoUsd !== true)) return [];
  const id = String(asset && asset.id || '').toUpperCase();
  const found = ['USD', 'EUR', 'GBP'].filter(code => id.includes(code));
  // USDT é tratado como exposição em USD para a trava, quando ela estiver ativa.
  if (!found.length && id.includes('USDT')) found.push('USD');
  return [...new Set(found)];
}

/** Calcula a trava para uma janela operacional a partir de uma agenda já normalizada. */
export function calendarGuard(asset, entryAt, expiresAt = entryAt, cfg = {}, calendar = null) {
  const enabled = cfg.newsFilter !== false;
  const currencies = currenciesForAsset(asset, cfg);
  const beforeMs = Math.max(0, Number(cfg.newsBlockBeforeMin ?? 5)) * 60000;
  const afterMs = Math.max(0, Number(cfg.newsBlockAfterMin ?? 5)) * 60000;
  if (!enabled || !currencies.length) return { enabled, blocked: false, currencies, status: 'not-applicable', events: [], text: 'calendário não aplicável ao ativo' };
  if (!calendar || !calendar.events) {
    const failClosed = cfg.newsFailClosedForex !== false && asset && asset.group === 'Forex';
    return {
      enabled, blocked: false, unverified: true, failClosed, wouldBlockUnderStrictPolicy: failClosed, currencies, events: [], source: null, status: 'unavailable',
      text: `calendário econômico não confirmado: ${calendar && calendar.error ? calendar.error : 'fonte indisponível'}`
    };
  }
  if (calendar.stale && cfg.newsFailClosedForex !== false && asset && asset.group === 'Forex') {
    return {
      enabled, blocked: false, unverified: true, failClosed: true, wouldBlockUnderStrictPolicy: true, stale: true, currencies, events: [], source: calendar.source || null, status: 'stale',
      beforeMs, afterMs, fetchedAt: calendar.at,
      text: 'calendário econômico está em cache sem atualização válida'
    };
  }
  const start = Math.min(Number(entryAt), Number(expiresAt));
  const end = Math.max(Number(entryAt), Number(expiresAt));
  const events = calendar.events.filter(event => currencies.includes(event.currency) && event.at + afterMs >= start && event.at - beforeMs <= end);
  return {
    enabled, blocked: events.length > 0, currencies, events, source: calendar.source, status: calendar.stale ? 'stale' : 'ready',
    beforeMs, afterMs, fetchedAt: calendar.at, cached: calendar.cached, stale: !!calendar.stale,
    text: events.length
      ? `notícia de alto impacto: ${events.map(event => `${event.currency} · ${event.title}`).join(' · ')}`
      : `sem notícia de alto impacto para ${currencies.join('/')} na janela de ${beforeMs / 60000}+${afterMs / 60000} min${calendar.stale ? ' (agenda em cache; atualização pendente)' : ''}`
  };
}

/** Carrega uma agenda atual e avalia toda a janela de exposição do sinal. */
export async function newsGuard(asset, entryAt = Date.now(), expiresAt = entryAt, cfg = {}) {
  const calendar = await highImpactCalendar(entryAt);
  return calendarGuard(asset, entryAt, expiresAt, cfg, calendar);
}
