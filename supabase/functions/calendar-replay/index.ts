import { normalizeReplayRows, type ReplayPoint, type ReplayRow, validateReplayPoints } from "../_shared/calendar-replay.ts";
import { HttpError, readJson } from "../_shared/http.ts";
import { requiredRpc } from "../_shared/rpc.ts";
import { createAdminClient } from "../_shared/supabase.ts";

interface ReplayBody extends Record<string, unknown> {
  points: ReplayPoint[];
  maxStaleMinutes: number;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    if (request.method !== "POST") throw new HttpError(405, "Use POST para esta função.");
    const body = await readJson<ReplayBody>(request);
    const points = validateReplayPoints(body.points);
    const maxStaleMinutes = Math.max(1, Math.min(360, Math.round(Number(body.maxStaleMinutes) || 360)));
    const client = createAdminClient();
    const rows = await requiredRpc<ReplayRow[]>(client, "calendar_replay_snapshots", {
      p_points: points,
      p_max_stale_minutes: maxStaleMinutes,
    });
    const snapshots = normalizeReplayRows(rows);
    return response({
      ok: true,
      requested: points.length,
      covered: snapshots.filter((item) => item.status === "ready").length,
      snapshots,
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, status);
  }
});
