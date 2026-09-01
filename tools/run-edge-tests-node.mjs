// Offline fallback for the pure Edge unit tests when Deno is unavailable.
// Run with Node 24+: node --experimental-strip-types tools/run-edge-tests-node.mjs

const tests = [];
globalThis.Deno = {
  test(name, fn) {
    tests.push({ name, fn });
  },
};

for (const file of [
  "../supabase/functions/tests/time_test.ts",
  "../supabase/functions/tests/features_test.ts",
  "../supabase/functions/tests/logistic_test.ts",
  "../supabase/functions/tests/http_test.ts",
  "../supabase/functions/tests/gap_backfill_test.ts",
  "../supabase/functions/tests/provider_clock_test.ts",
  "../supabase/functions/tests/market_guards_test.ts",
  "../supabase/functions/tests/calendar_replay_test.ts",
]) {
  await import(new URL(file, import.meta.url));
}

let failures = 0;
for (const test of tests) {
  try {
    await test.fn();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error instanceof Error ? error.stack : String(error));
  }
}

if (failures) {
  process.exitCode = 1;
} else {
  console.log(`Edge unit tests: ${tests.length}/${tests.length} passed`);
}
