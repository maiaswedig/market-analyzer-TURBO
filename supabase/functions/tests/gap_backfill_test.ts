import { gapTargetOpenTime } from "../_shared/gap-backfill.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`expected ${expected}, received ${actual}`);
}

Deno.test("entry gap targets the exact entry candle open", () => {
  const missing = Date.UTC(2026, 7, 28, 12, 30, 0);
  assertEquals(gapTargetOpenTime("entry", missing, "M5"), missing);
});

Deno.test("M5 expiry gap targets the candle that closes at expiry", () => {
  const expiry = Date.UTC(2026, 7, 28, 12, 35, 0);
  assertEquals(gapTargetOpenTime("expiry", expiry, "M5"), expiry - (5 * 60_000));
});

Deno.test("H1 expiry gap targets the candle that closes at expiry", () => {
  const expiry = Date.UTC(2026, 7, 28, 13, 0, 0);
  assertEquals(gapTargetOpenTime("expiry", expiry, "H1"), expiry - (60 * 60_000));
});
