import type { AdminClient } from "./supabase.ts";

export async function readCandlePage(client: AdminClient, symbol: string, timeframe: string,
  limit: number, offset = 0, before: string | null = null): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await client.rpc("worker_closed_candles", {
      p_symbol: symbol, p_timeframe: timeframe, p_limit: limit,
      p_offset: offset, p_before: before,
    });
    if (!error) return data || [];
    const transient = error.code === "57014" || /gateway timeout|statement timeout|connection.*timeout/i.test(error.message);
    if (attempt || !transient) throw new Error(`Leitura de candles ${symbol}/${timeframe}: ${error.message}`);
    // Retry only this read; writes/decisions are never replayed here.
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return [];
}
