const FINAL_OUTCOMES = new Set(['ACERTO', 'ERRO', 'NEUTRO']);

export function isFinalOutcome(value) {
  return FINAL_OUTCOMES.has(value);
}

export function settlementTimes(item, timeframeMs) {
  const tfMs = Math.max(1, Number(timeframeMs) || 1);
  const expiryCandles = Math.max(1, Number(item && item.expiryCandles) || 1);
  const entryCandleAt = Number(item && item.entryCandleAt);
  if (!Number.isFinite(entryCandleAt)) return null;
  const targetCandleAt = entryCandleAt + (expiryCandles - 1) * tfMs;
  return {
    entryCandleAt,
    targetCandleAt,
    expiresAt: entryCandleAt + expiryCandles * tfMs
  };
}

// Resolve apenas com a vela de entrada e a vela de expiração exatas, ambas
// fechadas. Nunca procura a vela "mais próxima" e nunca reescreve um desfecho.
export function settlePendingRecords(records, {
  assetId,
  tfKey,
  timeframeMs,
  candles,
  now = Date.now(),
  source = null
} = {}) {
  if (!Array.isArray(records) || !Array.isArray(candles)) return [];
  const exactClosed = new Map(candles.filter(candle => candle && !candle.live && Number.isFinite(Number(candle.t))).map(candle => [Number(candle.t), candle]));
  const changed = [];

  for (const item of records) {
    if (!item || item.asset !== assetId || item.tf !== tfKey || item.outcome !== 'PENDENTE') continue;
    const times = settlementTimes(item, timeframeMs);
    if (!times || now < times.expiresAt) continue;
    const entry = exactClosed.get(times.entryCandleAt);
    const target = exactClosed.get(times.targetCandleAt);
    if (!entry || !target) continue;

    const actualDirection = Math.sign(Number(target.c) - Number(entry.o));
    item.targetCandleAt = times.targetCandleAt;
    item.expiresAt = times.expiresAt;
    item.dueAt = times.expiresAt;
    item.entryPrice = Number(entry.o);
    item.nextClose = Number(target.c);
    item.actualDirection = actualDirection;
    item.outcome = actualDirection === 0 ? 'NEUTRO' : actualDirection === Number(item.direction) ? 'ACERTO' : 'ERRO';
    item.resolvedAt = now;
    item.resolutionMethod = 'exact-closed-candles';
    item.resolutionSource = source || item.resolutionSource || null;
    changed.push(item);
  }
  return changed;
}

export function latestResolvedRecord(records) {
  if (!Array.isArray(records)) return null;
  return records.filter(item => item && isFinalOutcome(item.outcome))
    .sort((a, b) => Number(b.resolvedAt || b.expiresAt || b.createdAt || b.t || 0) - Number(a.resolvedAt || a.expiresAt || a.createdAt || a.t || 0))[0] || null;
}
