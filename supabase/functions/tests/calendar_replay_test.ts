import { normalizeReplayRows, validateReplayPoints } from "../_shared/calendar-replay.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
}

function assertThrows(action: () => unknown): void {
  try { action(); } catch { return; }
  throw new Error("expected action to throw");
}

Deno.test("calendar replay accepts a bounded causal point", () => {
  const now = Date.UTC(2026, 7, 30, 12);
  const points = validateReplayPoints([{
    key: "42",
    knownAt: now,
    from: now - 5 * 60_000,
    to: now + 3 * 60 * 60_000,
  }], now);
  assertEquals(points.length, 1);
  assertEquals(points[0].key, "42");
});

Deno.test("calendar replay rejects duplicate keys and future knowledge", () => {
  const now = Date.UTC(2026, 7, 30, 12);
  assertThrows(() => validateReplayPoints([
    { key: "x", knownAt: now, from: now, to: now + 1_000 },
    { key: "x", knownAt: now, from: now, to: now + 1_000 },
  ], now));
  assertThrows(() => validateReplayPoints([
    { key: "future", knownAt: now + 60_000, from: now, to: now + 1_000 },
  ], now));
});

Deno.test("calendar replay preserves explicit unavailable snapshots", () => {
  const rows = normalizeReplayRows([{
    point_key: "a",
    known_at: "2026-08-30T12:00:00.000Z",
    fetched_at: null,
    source: null,
    events: null,
  }]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "unavailable");
  assert(Array.isArray(rows[0].events));
});
