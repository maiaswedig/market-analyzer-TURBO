import fs from 'node:fs';
import assert from 'node:assert/strict';

const migration = fs.readFileSync(new URL('../supabase/migrations/202609040029_prospective_strategy_lab.sql', import.meta.url), 'utf8');
const expansion = fs.readFileSync(new URL('../supabase/migrations/202609040030_fix_and_expand_strategy_controls.sql', import.meta.url), 'utf8');
const diagnostics = fs.readFileSync(new URL('../supabase/migrations/202609040031_statistical_diagnostics_and_regime.sql', import.meta.url), 'utf8');
const fairBenchmark = fs.readFileSync(new URL('../supabase/migrations/202609050032_coverage_matched_strategy_benchmark.sql', import.meta.url), 'utf8');
const gapFix = fs.readFileSync(new URL('../supabase/migrations/202609040028_fix_gap_batch_reconciliation.sql', import.meta.url), 'utf8');
const edge = fs.readFileSync(new URL('../supabase/functions/market-cycle/index.ts', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cloudApi = fs.readFileSync(new URL('../js/cloud-api.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../js/signal-ai.js', import.meta.url), 'utf8');

for (const arm of ['technical_current', 'technical_inverse', 'grade_a_or_a_plus']) {
  assert.match(migration, new RegExp(`'${arm}'`), `missing prospective arm ${arm}`);
}
for (const arm of ['always_buy', 'always_sell', 'last_closed_candle']) {
  assert.match(expansion, new RegExp(`'${arm}'`), `missing simple baseline ${arm}`);
}
assert.match(expansion, /feature_snapshot->>'grade'/i, 'grade must come from the canonical snapshot');
assert.match(expansion, /close_time <= new\.feature_cutoff_at/i, 'last-candle baseline must be causal');
assert.match(migration, /new\.decision_at\s*>=\s*new\.entry_at/i, 'pre-entry guard is required');
assert.match(migration, /after insert on signal_atlas\.decision_events/i, 'arms must be frozen with the decision');
assert.match(migration, /pg_catalog\.count\(\*\) >= 500[\s\S]*20/i, 'review gate must require 500 opportunities and 20 days');
assert.match(migration, /delta_vs_random_lb95/i, 'conservative random-benchmark comparison is required');
assert.match(migration, /force row level security/i, 'private strategy ledger must force RLS');
assert.match(migration, /security_invoker = true/i, 'public aggregate view must be security invoker');
assert.doesNotMatch(migration, /promote_champion|update\s+signal_atlas\.model_artifacts/i, 'strategy controls must not promote or rewrite a model');
assert.doesNotMatch(expansion, /promote_champion|update\s+signal_atlas\.model_artifacts/i, 'expanded controls must not promote or rewrite a model');

assert.match(gapFix, /for v_gap_id in[\s\S]*select g\.\* into v_gap[\s\S]*g\.status = 'pending'/i,
  'gap batch must re-read current state for each ID');
assert.match(gapFix, /and status = 'pending'[\s\S]*and lease_token = p_run_id/i,
  'gap transitions must be conditional on the current lease/state');

assert.match(edge, /operationalErrors = scopeErrorCount \+/, 'gap failures must affect scanner status');
assert.match(edge, /scope_errors: scopeErrors/, 'scope errors must remain observable');
assert.match(html, /id="cloudStrategyLab"/, 'strategy lab must be visible in the cloud monitor');
assert.match(cloudApi, /cloud_strategy_lab/, 'cloud API must load the strategy lab aggregate');
assert.match(ui, /function renderCloudStrategyLab/, 'strategy lab renderer is missing');
assert.match(diagnostics, /cloud_single_naive_baselines/i, 'naive baseline diagnosis is missing');
assert.match(diagnostics, /cloud_single_grade_calibration/i, 'Wilson grade calibration is missing');
assert.match(diagnostics, /wilson_lower/i, 'Wilson lower bound is missing');
assert.match(diagnostics, /feature_snapshot[^;]+regime/i, 'causal regime snapshot is missing');
assert.doesNotMatch(diagnostics, /update\s+signal_atlas\.model_artifacts/i, 'diagnostics must not rewrite models');
assert.match(html, /id="cloudNaiveBaselineRows"/, 'naive baselines must be visible in the frontend');
assert.match(html, /id="cloudGradeCalibrationRows"/, 'grade confidence intervals must be visible in the frontend');
assert.match(cloudApi, /cloud_single_naive_baselines/, 'cloud API must load naive baselines');
assert.match(cloudApi, /cloud_single_grade_calibration/, 'cloud API must load grade calibration');
assert.match(ui, /function renderCloudStatisticalDiagnostics/, 'statistical diagnostics renderer is missing');
assert.match(fairBenchmark, /case when s\.action = 'wait' then 0::numeric[\s\S]+coverage_benchmark_ev/i,
  'coverage-matched random must compare WAIT with WAIT');
assert.match(fairBenchmark, /avg\(s\.pnl - s\.coverage_benchmark_ev\)/i,
  'strategy delta must use the coverage-matched benchmark');
assert.match(fairBenchmark, /ev_per_trade numeric/i, 'per-trade EV must remain visible for selective arms');
assert.doesNotMatch(fairBenchmark, /promote_champion|update\s+signal_atlas\.model_artifacts/i,
  'fair benchmark must remain diagnostic-only');

console.log('Prospective strategy laboratory and operational recovery contracts passed.');
