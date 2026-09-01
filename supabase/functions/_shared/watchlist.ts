import type { AdminClient } from "./supabase.ts";
import type { MarketSource, WatchAsset } from "./types.ts";

function sourceOf(value: unknown): MarketSource | null {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "binance" || normalized === "yahoo" ? normalized : null;
}

export async function loadWatchlist(client: AdminClient): Promise<WatchAsset[]> {
  const { data, error } = await client.from("assets_watchlist").select("*").eq("active", true).order("symbol");
  if (error) throw new Error(`Não foi possível ler assets_watchlist: ${error.message}`);
  const output: WatchAsset[] = [];
  for (const row of data || []) {
    const source = sourceOf(row.source);
    const symbol = String(row.symbol || "").trim().toUpperCase();
    if (!source || !symbol) continue;
    output.push({
      id: row.id ? String(row.id) : undefined,
      symbol,
      providerSymbol: String(row.provider_symbol || row.providerSymbol || symbol).trim().toUpperCase(),
      market: String(row.market || (source === "binance" ? "crypto" : "forex")),
      source,
    });
  }
  return output;
}
