import { handleFunction, readJson } from "../_shared/http.ts";
import { fetchBackfillCandles } from "../_shared/providers.ts";
import { chunks } from "../_shared/rpc.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { ingestCandles } from "../_shared/storage.ts";
import { iso } from "../_shared/time.ts";
import { TIMEFRAMES, type Timeframe, type WatchAsset } from "../_shared/types.ts";
import { loadWatchlist } from "../_shared/watchlist.ts";

interface BootstrapBody extends Record<string, unknown> {
  symbols: string[];
  timeframes: string[];
  targetCandles: number;
  maxAssets: number;
}

function selectTimeframes(value: unknown): Timeframe[] {
  if (!Array.isArray(value) || !value.length) return Object.keys(TIMEFRAMES) as Timeframe[];
  return [...new Set(value.map(String).filter((item): item is Timeframe => item in TIMEFRAMES))];
}

async function mapLimited<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

Deno.serve((request) => handleFunction(request, async () => {
  const body = await readJson<BootstrapBody>(request);
  const client = createAdminClient();
  const allAssets = await loadWatchlist(client);
  const requested = Array.isArray(body.symbols) ? new Set(body.symbols.map((value) => String(value).toUpperCase())) : null;
  const maxAssets = Math.max(1, Math.min(10, Math.round(Number(body.maxAssets) || 5)));
  const assets = allAssets.filter((asset) => !requested || requested.has(asset.symbol)).slice(0, maxAssets);
  const timeframes = selectTimeframes(body.timeframes);
  const target = Math.max(300, Math.min(5_000, Math.round(Number(body.targetCandles) || 1_500)));
  const now = Date.now();
  const runId = crypto.randomUUID();
  const scopes: Array<{ asset: WatchAsset; timeframe: Timeframe }> = [];
  for (const asset of assets) for (const timeframe of timeframes) scopes.push({ asset, timeframe });

  const results = await mapLimited(scopes, 2, async ({ asset, timeframe }) => {
    try {
      const candles = await fetchBackfillCandles(asset, timeframe, target, now);
      let written = 0;
      for (const batch of chunks(candles, 250)) {
        await ingestCandles(client, asset, timeframe, batch, runId, now);
        written += batch.length;
      }
      return {
        symbol: asset.symbol,
        timeframe,
        requested: target,
        received: candles.length,
        submitted: written,
        oldest: candles.length ? iso(candles[0].openTime) : null,
        newest: candles.length ? iso(candles[candles.length - 1].openTime) : null,
      };
    } catch (error) {
      return { symbol: asset.symbol, timeframe, requested: target, received: 0, submitted: 0, error: error instanceof Error ? error.message : String(error) };
    }
  });

  return {
    ok: results.every((result) => !("error" in result)),
    runId,
    at: iso(now),
    controlledLimits: { maxAssets, targetCandles: target, concurrency: 2, batchSize: 250 },
    scopes: results,
  };
}));
