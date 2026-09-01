import { fetchGapWindow } from "./providers.ts";
import { requiredRpc } from "./rpc.ts";
import { ingestCandles } from "./storage.ts";
import type { AdminClient } from "./supabase.ts";
import { iso, timeframeMs } from "./time.ts";
import type { Timeframe, WatchAsset } from "./types.ts";

interface CandleGapRow {
  id: string;
  asset_id: string;
  timeframe: Timeframe;
  missing_kind: "entry" | "expiry";
  missing_time: string;
}

interface GapReconcileRow {
  gap_id: string;
  gap_status: "pending" | "resolved" | "permanently_missing";
  attempt_count: number;
}

interface GapClaimResponse {
  due?: CandleGapRow[];
}

interface GapReconcileResponse {
  results?: GapReconcileRow[];
}

interface GapFetchAttempt {
  id: string;
  attempted: boolean;
  error?: string;
}

export interface GapBackfillSummary {
  due: number;
  attempted: number;
  resolved: number;
  abandoned: number;
  pending: number;
  failed: number;
  errors?: string[];
}

async function mapLimited<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
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

export function gapTargetOpenTime(
  missingKind: "entry" | "expiry",
  missingTimeMs: number,
  timeframe: Timeframe,
): number {
  return missingKind === "expiry"
    ? missingTimeMs - timeframeMs(timeframe)
    : missingTimeMs;
}

export async function backfillCandleGaps(
  client: AdminClient,
  assets: WatchAsset[],
  runId: string,
  asOf: number,
): Promise<GapBackfillSummary> {
  const claimed = await requiredRpc<GapClaimResponse>(client, "list_due_candle_gaps", {
    p_as_of: iso(asOf),
    p_run_id: runId,
    p_limit: 6,
  });
  const due = Array.isArray(claimed?.due) ? claimed.due : [];
  if (!due.length) return { due: 0, attempted: 0, resolved: 0, abandoned: 0, pending: 0, failed: 0 };

  const assetsById = new Map(assets.filter((asset) => asset.id).map((asset) => [String(asset.id), asset]));
  const attempts = await mapLimited<CandleGapRow, GapFetchAttempt>(due, 3, async (gap) => {
    const asset = assetsById.get(String(gap.asset_id));
    if (!asset) return { id: gap.id, attempted: false, error: `ativo ${gap.asset_id} não encontrado` };
    const missingTime = Date.parse(gap.missing_time);
    if (!Number.isFinite(missingTime)) return { id: gap.id, attempted: false, error: `horário inválido em ${gap.id}` };
    try {
      const requestedAt = Date.now();
      const targetOpen = gapTargetOpenTime(gap.missing_kind, missingTime, gap.timeframe);
      const candles = await fetchGapWindow(asset, gap.timeframe, targetOpen, requestedAt);
      const receivedAt = Date.now();
      for (const candle of candles) candle.receivedAt = receivedAt;
      await ingestCandles(client, asset, gap.timeframe, candles, runId, receivedAt);
      return { id: gap.id, attempted: true };
    } catch (error) {
      return {
        id: gap.id,
        attempted: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // Even a provider error is a real, auditable attempt. Reconciliation checks
  // the exact database key itself and never trusts the network response.
  const attemptedIds = attempts.filter((item) => item.attempted).map((item) => item.id);
  const reconciled = attemptedIds.length
    ? await requiredRpc<GapReconcileResponse>(client, "reconcile_candle_gaps", {
      p_as_of: iso(Date.now()),
      p_run_id: runId,
      p_gap_ids: attemptedIds,
    })
    : null;
  const results = Array.isArray(reconciled?.results) ? reconciled.results : [];
  const failed = attempts.filter((item) => !!item.error).length;
  const errors = attempts.flatMap((item) => item.error ? [`${item.id}: ${item.error}`] : []);
  return {
    due: due.length,
    attempted: attemptedIds.length,
    resolved: results.filter((item) => item.gap_status === "resolved").length,
    abandoned: results.filter((item) => item.gap_status === "permanently_missing").length,
    pending: results.filter((item) => item.gap_status === "pending").length,
    failed,
    ...(errors.length ? { errors: errors.slice(0, 6) } : {}),
  };
}
