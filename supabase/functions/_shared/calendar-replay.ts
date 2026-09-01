import { HttpError } from "./http.ts";

export interface ReplayPoint extends Record<string, unknown> {
  key: string;
  knownAt: number;
  from: number;
  to: number;
}

export interface ReplayRow {
  point_key: string;
  known_at: string;
  fetched_at: string | null;
  source: string | null;
  events: Array<Record<string, unknown>> | null;
}

function finiteTime(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function validateReplayPoints(value: unknown, now = Date.now()): ReplayPoint[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 750) {
    throw new HttpError(400, "Envie de 1 a 750 pontos de replay.");
  }
  const ceiling = now + 5_000;
  const keys = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HttpError(400, `Ponto de replay inválido na posição ${index}.`);
    }
    const item = raw as Record<string, unknown>;
    const key = String(item.key || "").trim().slice(0, 80);
    const knownAt = finiteTime(item.knownAt);
    const from = finiteTime(item.from);
    const to = finiteTime(item.to);
    if (!key || keys.has(key) || knownAt === null || from === null || to === null ||
      knownAt > ceiling || from > to || to - from > 25 * 60 * 60_000) {
      throw new HttpError(400, `Ponto de replay inválido na posição ${index}.`);
    }
    keys.add(key);
    return { key, knownAt, from, to };
  });
}

export function normalizeReplayRows(rows: ReplayRow[]): Array<Record<string, unknown>> {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    key: row.point_key,
    knownAt: Date.parse(row.known_at),
    fetchedAt: row.fetched_at ? Date.parse(row.fetched_at) : null,
    source: row.source || null,
    events: Array.isArray(row.events) ? row.events : [],
    status: row.fetched_at ? "ready" : "unavailable",
  }));
}
