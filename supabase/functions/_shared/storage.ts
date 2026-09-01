import { iso, parseTime } from "./time.ts";
import type { AdminClient } from "./supabase.ts";
import { requiredRpc } from "./rpc.ts";
import type { Candle, LogisticArtifact, StoredModel, Timeframe, WatchAsset } from "./types.ts";

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeArtifact(value: unknown): LogisticArtifact | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" ? parsed as LogisticArtifact : null;
  } catch {
    return null;
  }
}

export async function latestClosedOpen(client: AdminClient, symbol: string, timeframe: Timeframe): Promise<number | null> {
  const { data, error } = await client.from("candles")
    .select("open_time")
    .eq("symbol", symbol)
    .eq("timeframe", timeframe)
    .eq("is_closed", true)
    .order("open_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Falha ao localizar o último candle ${symbol} ${timeframe}: ${error.message}`);
  return parseTime(data?.open_time);
}

export async function loadClosedCandles(client: AdminClient, asset: WatchAsset, timeframe: Timeframe, limit = 3_500): Promise<Candle[]> {
  const requested = Math.max(220, Math.min(5_000, Math.round(limit)));
  // PostgREST normalmente limita cada resposta a 1.000 linhas, mesmo quando
  // o cliente pede mais. Paginar evita treinar silenciosamente com uma janela
  // menor que a declarada e mantém a divisão cronológica auditável.
  const pageSize = 1_000;
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < requested; offset += pageSize) {
    const take = Math.min(pageSize, requested - offset);
    const { data, error } = await client.from("candles")
      .select("symbol,timeframe,open_time,open,high,low,close,volume,source,is_closed,inserted_at")
      .eq("symbol", asset.symbol)
      .eq("timeframe", timeframe)
      .eq("is_closed", true)
      .order("open_time", { ascending: false })
      .range(offset, offset + take - 1);
    if (error) throw new Error(`Falha ao ler candles fechados ${asset.symbol} ${timeframe}: ${error.message}`);
    const page = (data || []) as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < take) break;
  }
  return rows.map((row): Candle | null => {
    const openTime = parseTime(row.open_time);
    const open = numeric(row.open);
    const high = numeric(row.high);
    const low = numeric(row.low);
    const close = numeric(row.close);
    if (openTime === null || [open, high, low, close].some((value) => value === null)) return null;
    return {
      symbol: asset.symbol,
      timeframe,
      openTime,
      open: open!, high: high!, low: low!, close: close!, volume: numeric(row.volume) || 0,
      source: asset.source,
      isClosed: true,
      receivedAt: parseTime(row.inserted_at) || Date.now(),
    };
  }).filter((row): row is Candle => row !== null).reverse();
}

export async function loadScopeModels(client: AdminClient, symbol: string, timeframe: Timeframe): Promise<StoredModel[]> {
  // Load the champion independently.  A single recency-limited query can drop
  // an older production model after four newer challengers are created, which
  // would stop both inference and the prospective shadow comparison.
  const championQuery = await client.from("model_artifacts")
    .select("id,status,artifact,created_at")
    .eq("symbol", symbol)
    .eq("timeframe", timeframe)
    .eq("status", "production")
    .order("created_at", { ascending: false })
    .limit(1);
  if (championQuery.error) {
    throw new Error(`Falha ao carregar champion ${symbol} ${timeframe}: ${championQuery.error.message}`);
  }
  const challengerQuery = await client.from("model_artifacts")
    .select("id,status,artifact,created_at")
    .eq("symbol", symbol)
    .eq("timeframe", timeframe)
    .eq("status", "candidate")
    .order("created_at", { ascending: false })
    .limit(3);
  if (challengerQuery.error) {
    throw new Error(`Falha ao carregar challengers ${symbol} ${timeframe}: ${challengerQuery.error.message}`);
  }
  const rows = [...(championQuery.data || []), ...(challengerQuery.data || [])];
  const seen = new Set<string>();
  return rows.map((row): StoredModel | null => {
    const artifact = decodeArtifact(row.artifact);
    const id = row.id ? String(row.id) : "";
    if (!artifact || !id || seen.has(id) || !["production", "candidate"].includes(row.status)) return null;
    seen.add(id);
    return { id: String(row.id), status: row.status, artifact, createdAt: row.created_at ? String(row.created_at) : undefined } as StoredModel;
  }).filter((row): row is StoredModel => row !== null);
}

export function candlePayload(candle: Candle) {
  return {
    symbol: candle.symbol,
    timeframe: candle.timeframe,
    open_time: iso(candle.openTime),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    source: candle.source,
    is_closed: candle.isClosed,
    received_at: iso(candle.receivedAt),
  };
}

export async function ingestCandles(client: AdminClient, asset: WatchAsset, timeframe: Timeframe, candles: Candle[], runId: string, receivedAt: number) {
  const closed = candles.filter((candle) => candle.isClosed).map(candlePayload);
  const live = candles.filter((candle) => !candle.isClosed).sort((a, b) => b.openTime - a.openTime).slice(0, 1).map(candlePayload);
  return await requiredRpc(client, "ingest_candles", {
    p_symbol: asset.symbol,
    p_timeframe: timeframe,
    p_source: asset.source,
    p_closed_candles: closed,
    p_live_candle: live[0] || null,
    p_run_id: runId,
    p_received_at: iso(receivedAt),
  });
}
