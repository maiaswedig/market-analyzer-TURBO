// filters.js — travas causais de qualidade para sinais de curta duração.
// Todas usam apenas o snapshot da vela atual e contextos já fechados/visíveis.

const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const between = (value, min, max) => Math.max(min, Math.min(max, value));

function candleParts(candle) {
  if (!candle) return { body: 0, range: 0, upper: 0, lower: 0, bodyRatio: 0 };
  const range = Math.max(0, num(candle.h) - num(candle.l));
  const body = Math.abs(num(candle.c) - num(candle.o));
  const upper = Math.max(0, num(candle.h) - Math.max(num(candle.o), num(candle.c)));
  const lower = Math.max(0, Math.min(num(candle.o), num(candle.c)) - num(candle.l));
  return { body, range, upper, lower, bodyRatio: range ? body / range : 0 };
}

/** Pavio contrário em 3 velas: rejeição de preço antes de uma entrada curta. */
export function wickRejectionGuard(snap, direction, cfg = {}) {
  const threshold = between(num(cfg.wickOppositionRatio, 0.40), 0.10, 2);
  const recent = (snap.recentCandles || []).slice(-3);
  if (!direction || !recent.length) return { enabled: cfg.wickFilter !== false, blocked: false, hits: 0, total: recent.length, threshold, text: 'sem direção para avaliar pavios' };
  const rows = recent.map(candle => {
    const p = candleParts(candle);
    const opposing = direction > 0 ? p.upper : p.lower;
    // Para dojis, usa a amplitude; para corpos usuais, segue a regra pedida:
    // pavio contrário como fração do corpo.
    const ratio = p.bodyRatio < 0.08 ? (p.range ? opposing / p.range : 0) : opposing / Math.max(p.body, 1e-9);
    return { ratio, opposing, ...p };
  });
  const hits = rows.filter(row => row.ratio >= threshold).length;
  const totalOpposing = rows.reduce((sum, row) => sum + row.opposing, 0);
  const totalBody = rows.reduce((sum, row) => sum + row.body, 0);
  const aggregateRatio = totalOpposing / Math.max(totalBody, 1e-9);
  const indecision = rows.filter(row => row.bodyRatio < 0.08).length;
  const side = direction > 0 ? 'pavio superior (rejeição compradora)' : 'pavio inferior (rejeição vendedora)';
  const enabled = cfg.wickFilter !== false;
  return {
    // Regra principal: os pavios contrários acumulados das três velas não podem
    // superar 40% dos corpos acumulados. "hits" só explica o contexto na UI.
    enabled, blocked: enabled && (aggregateRatio > threshold || indecision >= 2), hits, total: rows.length, threshold,
    aggregateRatio, totalOpposing, totalBody, indecision,
    maxRatio: rows.length ? Math.max(...rows.map(row => row.ratio)) : 0,
    text: indecision >= 2
      ? `${indecision}/${rows.length} velas de indecisão (corpo muito pequeno)`
      : `pavio contrário acumulado: ${(aggregateRatio * 100).toFixed(0)}% dos corpos das últimas ${rows.length} velas (${side})`
  };
}

function directionalZoneDistance(price, zone, atr, direction) {
  if (!zone || !Number.isFinite(price) || !Number.isFinite(atr) || atr <= 0) return null;
  if (direction < 0) { // venda: suporte abaixo é o obstáculo
    if (price <= zone.low) return Infinity; // suporte já foi rompido
    return Math.max(0, price - zone.high) / atr;
  }
  // compra: resistência acima é o obstáculo
  if (price >= zone.high) return Infinity; // resistência já foi rompida
  return Math.max(0, zone.low - price) / atr;
}

/** Não vende em suporte forte / não compra em resistência forte de M15/H1. */
export function higherTfZoneGuard(snap, mtf, direction, cfg = {}) {
  const maxDistance = Math.max(0.1, num(cfg.higherTfZoneMaxAtr, 1));
  const minStrength = Math.max(1, num(cfg.higherTfMinZoneStrength, 3));
  const enabled = cfg.higherTfZoneFilter !== false;
  if (!direction) return { enabled, blocked: false, checks: [], text: 'sem direção para avaliar zonas maiores' };
  const contexts = (mtf || []).filter(ctx => ctx && ctx.snap && (ctx.tf === 'M15' || ctx.tf === 'H1'));
  const requireContext = cfg.higherTfRequireContext !== false;
  if (!contexts.length) {
    return {
      enabled, blocked: enabled && requireContext, unavailable: true, checks: [], maxDistance, minStrength,
      text: requireContext ? 'contexto fechado M15/H1 indisponível; zona maior não pôde ser confirmada' : 'contexto fechado M15/H1 indisponível'
    };
  }
  const checks = contexts.flatMap(ctx => {
    const zones = direction > 0 ? ctx.snap.zones && ctx.snap.zones.resistances : ctx.snap.zones && ctx.snap.zones.supports;
    return (zones || []).map(zone => {
      const strength = num(zone && zone.strength, 0);
      const distanceAtr = directionalZoneDistance(snap.price, zone, ctx.snap.atr, direction);
      return { tf: ctx.tf, zone, strength, distanceAtr, strong: strength >= minStrength, near: distanceAtr !== null && distanceAtr <= maxDistance };
    });
  }).filter(check => check.zone);
  const blocking = checks.filter(check => check.strong && check.near);
  const obstacle = direction > 0 ? 'resistência' : 'suporte';
  return {
    enabled, blocked: enabled && blocking.length > 0, checks, maxDistance, minStrength,
    text: blocking.length
      ? `${obstacle} forte em ${blocking.map(check => `${check.tf} a ${check.distanceAtr.toFixed(2)} ATR`).join(' · ')}`
      : `sem ${obstacle} forte de M15/H1 a até ${maxDistance.toFixed(1)} ATR`
  };
}

/** Confirmação mínima de Volume Spread Analysis: esforço (volume) não pode ser fraco. */
export function vsaGuard(snap, direction, cfg = {}, { now = Date.now(), timeframeSec = 0 } = {}) {
  const enabled = cfg.vsaFilter !== false;
  const minRelativeVolume = Math.max(0.1, num(cfg.vsaMinRelativeVolume, 0.8));
  const volume = snap.volume || {};
  const rangeRel = num(snap.rangeRel, 1);
  if (!enabled) return { enabled: false, blocked: false, text: 'VSA desativado' };
  if (!volume.available || volume.rel === null || volume.rel === undefined) {
    return { enabled, blocked: cfg.vsaRequireRealVolume !== false, available: false, minRelativeVolume, rangeRel, text: 'volume real indisponível para confirmar o VSA' };
  }
  const elapsed = snap.candle && snap.candle.live && timeframeSec > 0
    ? between((now - snap.candle.t) / (timeframeSec * 1000), 0.05, 1)
    : 1;
  const minProgress = between(num(cfg.vsaMinCandleProgress, 0.20), 0.05, 0.75);
  // Na vela em formação, compara o volume já ocorrido com a fração esperada da
  // média. Assim os primeiros segundos não parecem artificialmente "baixo volume".
  const rel = num(volume.rel);
  const paceRel = snap.candle && snap.candle.live ? rel / elapsed : rel;
  const gateRel = paceRel;
  const earlyCandle = !!(snap.candle && snap.candle.live && elapsed < minProgress);
  const lowEffort = gateRel < minRelativeVolume;
  const absorption = rel >= 1.5 && rangeRel < 0.65;
  const dir = Math.sign(num(snap.candle && snap.candle.c) - num(snap.candle && snap.candle.o));
  const oppositeClose = direction !== 0 && dir !== 0 && dir !== direction;
  return {
    enabled, blocked: lowEffort || earlyCandle, available: true, rel, paceRel, elapsed, minProgress, rangeRel, minRelativeVolume, absorption, oppositeClose,
    text: earlyCandle
      ? `vela em formação com ${(elapsed * 100).toFixed(0)}% do tempo; aguarde ao menos ${(minProgress * 100).toFixed(0)}% para confirmar volume`
      : lowEffort
      ? `volume VSA ajustado ${gateRel.toFixed(2)}× abaixo do mínimo de ${minRelativeVolume.toFixed(2)}×`
      : `VSA confirmado: volume ${gateRel.toFixed(2)}×${snap.candle && snap.candle.live ? ' no ritmo da vela' : ''} · spread ${rangeRel.toFixed(2)}× da média${absorption ? ' (possível absorção; leitura cautelosa)' : ''}`
  };
}

function localMinutes(timestamp, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp));
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  } catch (_) { return null; }
}
function circularDistance(a, b) { const raw = Math.abs(a - b); return Math.min(raw, 1440 - raw); }

/** Pausas de liquidez de Forex com DST resolvido pela zona IANA. */
function intervalHitsMinute(startMinute, durationMinutes, targetMinute, windowMinutes) {
  if (startMinute === null || !Number.isFinite(durationMinutes)) return false;
  const start = startMinute;
  const end = start + Math.max(0, durationMinutes);
  for (const shift of [-1440, 0, 1440]) {
    const target = targetMinute + shift;
    if (target + windowMinutes >= start && target - windowMinutes <= end) return true;
  }
  return false;
}

export function sessionGuard(asset, entryAt, expiresAt = entryAt, cfg = {}) {
  const enabled = cfg.sessionGuard !== false;
  const forexOnly = cfg.sessionGuardForexOnly !== false;
  if (!enabled || (forexOnly && (!asset || asset.group !== 'Forex'))) return { enabled, blocked: false, windows: [], text: 'trava de sessão não aplicável' };
  const windowMinutes = between(Math.round(num(cfg.sessionBlackoutMinutes, 10)), 1, 45);
  const periods = [
    { label: 'fechamento de Nova York', timeZone: 'America/New_York', minute: 17 * 60 },
    { label: 'abertura de Tóquio', timeZone: 'Asia/Tokyo', minute: 9 * 60 }
  ];
  const windows = periods.map(period => {
    const nowMinute = localMinutes(entryAt, period.timeZone);
    const durationMinutes = Math.max(0, (Number(expiresAt) - Number(entryAt)) / 60000);
    return { ...period, nowMinute, durationMinutes, active: intervalHitsMinute(nowMinute, durationMinutes, period.minute, windowMinutes) };
  });
  const active = windows.filter(window => window.active);
  return {
    enabled, blocked: active.length > 0, windows, windowMinutes,
    text: active.length ? `pausa de liquidez: exposição cruza ${active.map(window => window.label).join(' · ')} (±${windowMinutes} min)` : 'fora das transições de sessão configuradas'
  };
}

/** Expiração maior só é sugerida em exaustão coerente com a direção de reversão. */
export function suggestExpiry(snap, direction, cfg = {}) {
  const enabled = cfg.flexibleExpiry !== false;
  const maxCandles = between(Math.round(num(cfg.maxExpiryCandles, 3)), 1, 3);
  const rsi = snap.rsi;
  const bullishExhaustion = direction > 0 && rsi !== null && rsi < 30;
  const bearishExhaustion = direction < 0 && rsi !== null && rsi > 70;
  if (!enabled || (!bullishExhaustion && !bearishExhaustion)) return { candles: 1, kind: 'continuidade', reason: 'projeção para a próxima vela' };
  const extreme = bullishExhaustion ? rsi < 25 : rsi > 75;
  const candles = Math.min(maxCandles, extreme ? 3 : 2);
  return {
    candles, kind: 'exaustão',
    reason: `${bullishExhaustion ? 'RSI em sobrevenda' : 'RSI em sobrecompra'}: reversões podem precisar de ${candles} velas para amadurecer`
  };
}
