import { floorCandleOpen, isClosedAt, timeframeMs } from "./time.ts";
import type { Candle, Timeframe, WatchAsset } from "./types.ts";

interface FetchOptions {
  sinceMs?: number | null;
  limit?: number;
  includeLive?: boolean;
  bootstrap?: boolean;
  asOf?: number;
}

interface ProviderJsonResponse {
  body: unknown;
  serverDateMs: number | null;
}

const BINANCE_INTERVAL: Record<Timeframe, string> = { M5: "5m", M15: "15m", M30: "30m", H1: "1h" };
const OKX_INTERVAL: Record<Timeframe, string> = { M5: "5m", M15: "15m", M30: "30m", H1: "1H" };
const YAHOO_INTERVAL: Record<Timeframe, string> = { M5: "5m", M15: "15m", M30: "30m", H1: "60m" };
const BINANCE_HOSTS = ["https://api.binance.com", "https://api1.binance.com"];
const OKX_HOSTS = ["https://www.okx.com"];
const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validCandle(candle: Candle): boolean {
  return [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0) &&
    candle.high >= Math.max(candle.open, candle.close, candle.low) &&
    candle.low <= Math.min(candle.open, candle.close, candle.high);
}

export function conservativeProviderClock(runtimeNow: number, providerDateMs: number | null): number {
  const runtime = Number(runtimeNow);
  if (!Number.isFinite(runtime)) throw new Error("Relógio do runtime inválido.");
  const provider = Number(providerDateMs);
  // HTTP Date has one-second precision. A two-second allowance prevents a
  // harmless rounding difference while min() ensures a fast runtime clock can
  // never close a candle before the provider clock reaches that boundary.
  return Number.isFinite(provider) && provider > 0 ? Math.min(runtime, provider + 2_000) : runtime;
}

async function fetchJson(url: string, timeoutMs = 10_000): Promise<ProviderJsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "SignalAtlasResearch/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const dateHeader = response.headers.get("date");
    const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
    return {
      body: await response.json(),
      serverDateMs: Number.isFinite(parsedDate) ? parsedDate : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function firstSuccessful(urls: string[], timeoutMs = 10_000): Promise<ProviderJsonResponse> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return await fetchJson(url, timeoutMs);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Todas as rotas do provedor falharam: ${errors.join(" | ")}`);
}

async function firstProviderWithCandles(
  attempts: Array<{ name: string; run: () => Promise<Candle[]> }>,
): Promise<Candle[]> {
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const candles = await attempt.run();
      if (candles.length) return candles;
      errors.push(`${attempt.name}: sem candles válidos`);
    } catch (error) {
      errors.push(`${attempt.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Todos os provedores cripto falharam: ${errors.join(" | ")}`);
}

async function binancePage(asset: WatchAsset, timeframe: Timeframe, options: { startTime?: number; endTime?: number; limit: number }, asOf: number): Promise<Candle[]> {
  const query = new URLSearchParams({
    symbol: asset.providerSymbol.replace(/[-/]/g, ""),
    interval: BINANCE_INTERVAL[timeframe],
    limit: String(Math.max(1, Math.min(1_000, options.limit))),
  });
  if (Number.isFinite(options.startTime)) query.set("startTime", String(Math.round(options.startTime!)));
  if (Number.isFinite(options.endTime)) query.set("endTime", String(Math.round(options.endTime!)));
  const response = await firstSuccessful(BINANCE_HOSTS.map((host) => `${host}/api/v3/klines?${query}`));
  const raw = response.body;
  const closeClock = conservativeProviderClock(asOf, response.serverDateMs);
  if (!Array.isArray(raw)) throw new Error("Binance devolveu um formato inesperado.");
  return raw.map((row): Candle | null => {
    if (!Array.isArray(row)) return null;
    const openTime = finite(row[0]);
    const open = finite(row[1]);
    const high = finite(row[2]);
    const low = finite(row[3]);
    const close = finite(row[4]);
    const volume = finite(row[5]) ?? 0;
    const providerClose = finite(row[6]);
    if ([openTime, open, high, low, close].some((value) => value === null)) return null;
    const candle: Candle = {
      symbol: asset.symbol,
      timeframe,
      openTime: openTime!,
      open: open!, high: high!, low: low!, close: close!, volume,
      source: "binance",
      isClosed: providerClose !== null && providerClose < closeClock - 2_000,
      receivedAt: asOf,
    };
    return validCandle(candle) ? candle : null;
  }).filter((value): value is Candle => value !== null);
}

function okxInstrument(asset: WatchAsset): string {
  const compact = asset.providerSymbol.replace(/[-/]/g, "").toUpperCase();
  if (compact.endsWith("USDT") && compact.length > 4) return `${compact.slice(0, -4)}-USDT`;
  throw new Error(`Par ${asset.providerSymbol} não possui fallback OKX/USDT mapeável.`);
}

async function okxPage(
  asset: WatchAsset,
  timeframe: Timeframe,
  options: { history?: boolean; after?: number; before?: number; limit: number },
  asOf: number,
): Promise<Candle[]> {
  const query = new URLSearchParams({
    instId: okxInstrument(asset),
    bar: OKX_INTERVAL[timeframe],
    limit: String(Math.max(1, Math.min(300, options.limit))),
  });
  if (Number.isFinite(options.after)) query.set("after", String(Math.round(options.after!)));
  if (Number.isFinite(options.before)) query.set("before", String(Math.round(options.before!)));
  const endpoint = options.history ? "/api/v5/market/history-candles" : "/api/v5/market/candles";
  const response = await firstSuccessful(OKX_HOSTS.map((host) => `${host}${endpoint}?${query}`));
  const raw = response.body as Record<string, unknown>;
  if (String(raw?.code) !== "0" || !Array.isArray(raw?.data)) {
    throw new Error(`OKX devolveu um formato inesperado${raw?.msg ? `: ${String(raw.msg)}` : "."}`);
  }
  const closeClock = conservativeProviderClock(asOf, response.serverDateMs);
  return (raw.data as unknown[]).map((value): Candle | null => {
    if (!Array.isArray(value)) return null;
    const openTime = finite(value[0]);
    const open = finite(value[1]);
    const high = finite(value[2]);
    const low = finite(value[3]);
    const close = finite(value[4]);
    const volume = finite(value[5]) ?? 0;
    if ([openTime, open, high, low, close].some((item) => item === null)) return null;
    const candle: Candle = {
      symbol: asset.symbol,
      timeframe,
      openTime: openTime!,
      open: open!, high: high!, low: low!, close: close!, volume,
      source: "okx",
      // OKX publishes an explicit confirmation flag. The provider clock is
      // still checked so an inconsistent payload cannot close a future bar.
      isClosed: String(value[8]) === "1" && isClosedAt(openTime!, timeframe, closeClock, 2_000),
      receivedAt: asOf,
    };
    return validCandle(candle) ? candle : null;
  }).filter((value): value is Candle => value !== null);
}

async function cryptoRecentCandles(
  asset: WatchAsset,
  timeframe: Timeframe,
  options: { startTime?: number; limit: number },
  asOf: number,
): Promise<Candle[]> {
  return await firstProviderWithCandles([
    { name: "Binance", run: () => binancePage(asset, timeframe, options, asOf) },
    { name: "OKX", run: () => okxPage(asset, timeframe, { limit: Math.min(300, options.limit) }, asOf) },
  ]);
}

function yahooRange(timeframe: Timeframe, bootstrap: boolean): string {
  if (!bootstrap) return timeframe === "H1" ? "5d" : "5d";
  if (timeframe === "M5") return "1mo";
  if (timeframe === "M15") return "1mo";
  // Yahoo limits intraday M30 retention. Asking for two years can make the
  // whole Forex bootstrap fail, so keep this request inside a real provider
  // window and let the database accumulate new bars prospectively.
  if (timeframe === "M30") return "1mo";
  return "2y";
}

async function yahooCandles(asset: WatchAsset, timeframe: Timeframe, options: FetchOptions, asOf: number): Promise<Candle[]> {
  const query = new URLSearchParams({
    interval: YAHOO_INTERVAL[timeframe],
    range: yahooRange(timeframe, !!options.bootstrap),
    includePrePost: "false",
    events: "div,splits",
  });
  const symbol = encodeURIComponent(asset.providerSymbol);
  const response = await firstSuccessful(YAHOO_HOSTS.map((host) => `${host}/v8/finance/chart/${symbol}?${query}`));
  const raw = response.body as Record<string, unknown>;
  const closeClock = conservativeProviderClock(asOf, response.serverDateMs);
  const chart = raw?.chart as Record<string, unknown> | undefined;
  const resultRows = Array.isArray(chart?.result) ? chart.result : [];
  const result = resultRows[0] as Record<string, unknown> | undefined;
  if (!result) throw new Error("Yahoo devolveu um formato inesperado.");
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const indicators = result.indicators as Record<string, unknown> | undefined;
  const quoteRows = Array.isArray(indicators?.quote) ? indicators.quote : [];
  const quotes = quoteRows[0] as Record<string, unknown> | undefined;
  if (!quotes) return [];
  const rows: Candle[] = [];
  for (let index = 0; index < timestamps.length; index++) {
    const openTimeSeconds = finite(timestamps[index]);
    const open = finite((quotes.open as unknown[])?.[index]);
    const high = finite((quotes.high as unknown[])?.[index]);
    const low = finite((quotes.low as unknown[])?.[index]);
    const close = finite((quotes.close as unknown[])?.[index]);
    const volume = finite((quotes.volume as unknown[])?.[index]) ?? 0;
    if ([openTimeSeconds, open, high, low, close].some((value) => value === null)) continue;
    // O Yahoo às vezes marca a barra corrente com o instante da última
    // atualização (por exemplo 17:09:08) em vez do início exato 17:05:00.
    // Normalizar para a grade do timeframe preserva a chave causal/idempotente
    // e evita rejeitar a vela parcial como desalinhada.
    const openTime = floorCandleOpen(openTimeSeconds! * 1_000, timeframe);
    const candle: Candle = {
      symbol: asset.symbol,
      timeframe,
      openTime,
      open: open!, high: high!, low: low!, close: close!, volume,
      source: "yahoo",
      // Yahoo não publica um flag de fechamento. A margem adicional impede que
      // a última atualização parcial seja promovida cedo para o histórico.
      isClosed: isClosedAt(openTime, timeframe, closeClock, 90_000),
      receivedAt: asOf,
    };
    if (validCandle(candle)) rows.push(candle);
  }
  return rows;
}

/**
 * Fetches only the narrow provider window around one exact missing candle.
 * This path is deliberately separate from normal collection: Yahoo `range`
 * is relative to now and cannot reliably revisit an old gap.
 */
export async function fetchGapWindow(
  asset: WatchAsset,
  timeframe: Timeframe,
  targetOpenMs: number,
  asOf = Date.now(),
): Promise<Candle[]> {
  const interval = timeframeMs(timeframe);
  const targetOpen = floorCandleOpen(targetOpenMs, timeframe);

  if (asset.source === "binance") {
    return deduplicate(await firstProviderWithCandles([
      {
        name: "Binance",
        run: async () => (await binancePage(asset, timeframe, {
          startTime: Math.max(0, targetOpen - interval),
          endTime: targetOpen + (2 * interval),
          limit: 5,
        }, asOf)).filter((row) => row.isClosed && row.openTime === targetOpen),
      },
      {
        name: "OKX",
        run: async () => (await okxPage(asset, timeframe, {
          history: true,
          after: targetOpen + (2 * interval),
          limit: 10,
        }, asOf)).filter((row) => row.isClosed && row.openTime === targetOpen),
      },
    ]));
  }

  const query = new URLSearchParams({
    interval: YAHOO_INTERVAL[timeframe],
    period1: String(Math.floor((targetOpen - (2 * interval)) / 1_000)),
    period2: String(Math.ceil((targetOpen + (3 * interval)) / 1_000)),
    includePrePost: "false",
    events: "div,splits",
  });
  const symbol = encodeURIComponent(asset.providerSymbol);
  // Gap repair must remain a small bounded part of the scanner cycle. Each
  // Yahoo host therefore gets a shorter timeout than normal collection.
  const response = await firstSuccessful(
    YAHOO_HOSTS.map((host) => `${host}/v8/finance/chart/${symbol}?${query}`),
    6_000,
  );
  const raw = response.body as Record<string, unknown>;
  const closeClock = conservativeProviderClock(asOf, response.serverDateMs);
  const chart = raw?.chart as Record<string, unknown> | undefined;
  const resultRows = Array.isArray(chart?.result) ? chart.result : [];
  const result = resultRows[0] as Record<string, unknown> | undefined;
  if (!result) throw new Error("Yahoo devolveu um formato inesperado na recuperação de lacuna.");
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const indicators = result.indicators as Record<string, unknown> | undefined;
  const quoteRows = Array.isArray(indicators?.quote) ? indicators.quote : [];
  const quotes = quoteRows[0] as Record<string, unknown> | undefined;
  if (!quotes) return [];

  const rows: Candle[] = [];
  for (let index = 0; index < timestamps.length; index++) {
    const openTimeSeconds = finite(timestamps[index]);
    const open = finite((quotes.open as unknown[])?.[index]);
    const high = finite((quotes.high as unknown[])?.[index]);
    const low = finite((quotes.low as unknown[])?.[index]);
    const close = finite((quotes.close as unknown[])?.[index]);
    const volume = finite((quotes.volume as unknown[])?.[index]) ?? 0;
    if ([openTimeSeconds, open, high, low, close].some((value) => value === null)) continue;
    const openTime = floorCandleOpen(openTimeSeconds! * 1_000, timeframe);
    const candle: Candle = {
      symbol: asset.symbol,
      timeframe,
      openTime,
      open: open!, high: high!, low: low!, close: close!, volume,
      source: "yahoo",
      isClosed: isClosedAt(openTime, timeframe, closeClock, 90_000),
      receivedAt: asOf,
    };
    if (validCandle(candle)) rows.push(candle);
  }
  return deduplicate(rows.filter((row) => row.isClosed));
}

function deduplicate(candles: Candle[]): Candle[] {
  const byOpen = new Map<number, Candle>();
  for (const candle of candles) {
    const previous = byOpen.get(candle.openTime);
    if (!previous || (!previous.isClosed && candle.isClosed)) byOpen.set(candle.openTime, candle);
  }
  return [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
}

export async function fetchMarketCandles(asset: WatchAsset, timeframe: Timeframe, options: FetchOptions = {}): Promise<Candle[]> {
  const asOf = options.asOf ?? Date.now();
  const limit = Math.max(3, Math.min(1_000, Math.round(options.limit || 300)));
  let candles: Candle[];
  if (asset.source === "binance") {
    const overlap = options.sinceMs ? Math.max(0, options.sinceMs - timeframeMs(timeframe)) : undefined;
    candles = await cryptoRecentCandles(asset, timeframe, { startTime: overlap, limit }, asOf);
  } else {
    candles = await yahooCandles(asset, timeframe, options, asOf);
  }
  const filtered = deduplicate(candles).filter((candle) => !options.sinceMs || candle.openTime >= options.sinceMs - timeframeMs(timeframe));
  return options.includeLive === false ? filtered.filter((candle) => candle.isClosed) : filtered;
}

export async function fetchBackfillCandles(asset: WatchAsset, timeframe: Timeframe, target: number, asOf = Date.now()): Promise<Candle[]> {
  const wanted = Math.max(220, Math.min(5_000, Math.round(target)));
  if (asset.source === "yahoo") {
    const rows = await yahooCandles(asset, timeframe, { bootstrap: true, includeLive: false, limit: wanted }, asOf);
    return deduplicate(rows.filter((row) => row.isClosed)).slice(-wanted);
  }

  return deduplicate(await firstProviderWithCandles([
    {
      name: "Binance",
      run: async () => {
        const collected: Candle[] = [];
        let endTime = asOf;
        while (collected.length < wanted) {
          const page = await binancePage(asset, timeframe, {
            endTime,
            limit: Math.min(1_000, wanted - collected.length),
          }, asOf);
          const closed = page.filter((row) => row.isClosed);
          if (!closed.length) break;
          collected.push(...closed);
          const oldest = Math.min(...closed.map((row) => row.openTime));
          if (!Number.isFinite(oldest) || oldest >= endTime) break;
          endTime = oldest - 1;
        }
        return deduplicate(collected).slice(-wanted);
      },
    },
    {
      name: "OKX",
      run: async () => {
        const collected = await okxPage(asset, timeframe, { limit: Math.min(300, wanted) }, asOf);
        let oldest = Math.min(...collected.map((row) => row.openTime));
        let guard = 0;
        const maxPages = Math.ceil(wanted / 300) + 2;
        while (collected.length < wanted && Number.isFinite(oldest) && guard++ < maxPages) {
          const page = await okxPage(asset, timeframe, {
            history: true,
            after: oldest,
            limit: Math.min(300, wanted - collected.length),
          }, asOf);
          const closed = page.filter((row) => row.isClosed);
          if (!closed.length) break;
          collected.push(...closed);
          const nextOldest = Math.min(...closed.map((row) => row.openTime));
          if (!Number.isFinite(nextOldest) || nextOldest >= oldest) break;
          oldest = nextOldest;
        }
        return deduplicate(collected.filter((row) => row.isClosed)).slice(-wanted);
      },
    },
  ]));
}

export function currentLiveCandle(candles: Candle[], timeframe: Timeframe, asOf: number): Candle | null {
  const expected = floorCandleOpen(asOf, timeframe);
  return candles.find((candle) => !candle.isClosed && candle.openTime === expected) || null;
}
