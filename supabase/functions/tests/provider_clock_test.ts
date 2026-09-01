import { conservativeProviderClock, fetchMarketCandles } from "../_shared/providers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("relógio do provedor impede fechamento prematuro por runtime adiantado", () => {
  const provider = Date.UTC(2026, 7, 28, 12, 0, 0);
  const runtimeAhead = provider + 180_000;
  const effective = conservativeProviderClock(runtimeAhead, provider);
  assert(effective === provider + 2_000, "o relógio adiantado não foi limitado pela fonte");
});

Deno.test("relógio conservador nunca adianta um runtime atrasado", () => {
  const runtime = Date.UTC(2026, 7, 28, 12, 0, 0);
  const providerAhead = runtime + 60_000;
  assert(conservativeProviderClock(runtime, providerAhead) === runtime, "a fonte adiantou o relógio local");
  assert(conservativeProviderClock(runtime, null) === runtime, "ausência do header deveria manter o fallback local");
});

Deno.test("falha HTTP 451 da Binance usa candles reais da OKX sem sintetizar", async () => {
  const originalFetch = globalThis.fetch;
  const asOf = Date.UTC(2026, 7, 28, 12, 20, 0);
  const openTime = Date.UTC(2026, 7, 28, 12, 10, 0);
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.includes("binance.com")) {
      return new Response('{"code":0}', { status: 451, headers: { date: new Date(asOf).toUTCString() } });
    }
    if (url.includes("okx.com")) {
      return new Response(JSON.stringify({
        code: "0",
        data: [[String(openTime), "100", "104", "99", "103", "12.5", "0", "0", "1"]],
      }), { status: 200, headers: { "content-type": "application/json", date: new Date(asOf).toUTCString() } });
    }
    throw new Error(`provedor inesperado no teste: ${url}`);
  }) as typeof fetch;

  try {
    const rows = await fetchMarketCandles({
      symbol: "BTCUSDT",
      providerSymbol: "BTCUSDT",
      market: "crypto",
      source: "binance",
    }, "M5", { limit: 20, includeLive: false, asOf });
    assert(requests.some((url) => url.includes("binance.com")), "o provedor primário não foi tentado");
    assert(requests.some((url) => url.includes("okx.com")), "o fallback independente não foi tentado");
    assert(rows.length === 1, "o fallback não retornou exatamente o candle real recebido");
    assert(rows[0].source === "okx", "a linhagem do provedor fallback não foi preservada");
    assert(rows[0].openTime === openTime && rows[0].open === 100 && rows[0].close === 103,
      "o candle retornado não corresponde ao payload real da OKX");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Yahoo recebe M30 nativo e mantém a grade causal de 30 minutos", async () => {
  const originalFetch = globalThis.fetch;
  const asOf = Date.UTC(2026, 7, 30, 14, 10, 0);
  const openTime = Date.UTC(2026, 7, 30, 13, 30, 0);
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    return new Response(JSON.stringify({ chart: { result: [{
      timestamp: [openTime / 1_000],
      indicators: { quote: [{ open: [1.17], high: [1.18], low: [1.16], close: [1.175], volume: [0] }] },
    }] } }), { status: 200, headers: { "content-type": "application/json", date: new Date(asOf).toUTCString() } });
  }) as typeof fetch;

  try {
    const rows = await fetchMarketCandles({
      symbol: "EURUSD",
      providerSymbol: "EURUSD=X",
      market: "forex",
      source: "yahoo",
    }, "M30", { limit: 20, includeLive: false, asOf });
    assert(requests.length === 1 && requests[0].includes("interval=30m"), "Yahoo não recebeu o intervalo M30 nativo");
    assert(rows.length === 1 && rows[0].timeframe === "M30" && rows[0].openTime === openTime,
      "candle Yahoo M30 não preservou timeframe/grade");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
