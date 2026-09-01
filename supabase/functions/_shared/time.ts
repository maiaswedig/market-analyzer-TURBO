import { TIMEFRAMES, type Timeframe } from "./types.ts";

export function timeframeMs(timeframe: Timeframe): number {
  return TIMEFRAMES[timeframe];
}

export function floorCandleOpen(timeMs: number, timeframe: Timeframe): number {
  const size = timeframeMs(timeframe);
  return Math.floor(timeMs / size) * size;
}

export function candleProgress(timeMs: number, openTime: number, timeframe: Timeframe): number {
  return Math.max(0, Math.min(1, (timeMs - openTime) / timeframeMs(timeframe)));
}

export function isClosedAt(openTime: number, timeframe: Timeframe, asOf: number, graceMs = 2_000): boolean {
  return openTime + timeframeMs(timeframe) <= asOf - Math.max(0, graceMs);
}

export function signalClock(observedOpen: number, timeframe: Timeframe, expiryCandles = 1) {
  const size = timeframeMs(timeframe);
  const horizon = Math.max(1, Math.min(3, Math.round(expiryCandles)));
  const entryCandleOpen = observedOpen + size;
  const targetCandleOpen = entryCandleOpen + (horizon - 1) * size;
  return {
    observedCandleOpen: observedOpen,
    entryCandleOpen,
    targetCandleOpen,
    resolveAfter: targetCandleOpen + size,
    expiryCandles: horizon,
  };
}

/**
 * O cron deve rodar a cada minuto. A função coleta logo após o fechamento e
 * analisa apenas no trecho final da vela atual. Assim uma execução atrasada
 * não transforma o início de uma vela em um falso sinal "de fechamento".
 */
export function cyclePhase(timeMs: number, timeframe: Timeframe) {
  const size = timeframeMs(timeframe);
  const phase = ((timeMs % size) + size) % size;
  const remaining = size - phase;
  const analysisWindow = Math.max(70_000, Math.min(5 * 60_000, size * 0.20));
  return {
    collect: phase <= 75_000 || remaining <= analysisWindow,
    analyze: remaining <= analysisWindow,
    phase,
    remaining,
    analysisWindow,
  };
}

export function iso(timeMs: number): string {
  return new Date(timeMs).toISOString();
}

export function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}
