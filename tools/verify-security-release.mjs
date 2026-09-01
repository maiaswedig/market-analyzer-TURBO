import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/202608270011_security_release_hardening.sql");
const qualityMigration = read("supabase/migrations/202608270013_quality_curves_and_security_contract.sql");
const independentMigration = read("supabase/migrations/202608280014_independent_shadow_policies.sql");
const gapMigration = read("supabase/migrations/202608280016_missing_candle_gap_backfill.sql");
const gapLifecycleMigration = read("supabase/migrations/202608280017_candle_gap_lifecycle.sql");
const abandonmentCleanupMigration = read("supabase/migrations/202608280018_abandonment_gap_cleanup.sql");
const economicMigration = read("supabase/migrations/202608280019_canonical_tie_economics.sql");
const calendarReplayMigration = read("supabase/migrations/202608300023_calendar_replay_bridge.sql");
const gradeHistoryMigration = read("supabase/migrations/202608310024_public_cloud_grade_history.sql");
const decisionExplanationMigration = read("supabase/migrations/202608310025_public_cloud_decision_explanations.sql");
const confirmedQualityMigration = read("supabase/migrations/202608310026_decouple_confirmed_quality.sql");
const historicalScheduler = read("supabase/migrations/202608260003_scheduling.sql");
const http = read("supabase/functions/_shared/http.ts");
const marketCycle = read("supabase/functions/market-cycle/index.ts");
const gapBackfill = read("supabase/functions/_shared/gap-backfill.ts");
const features = read("supabase/functions/_shared/features.ts");
const calendarReplay = read("supabase/functions/calendar-replay/index.ts");
const config = read("supabase/config.toml");
const securityContract = read("supabase/tests/security_contract.sql");
const causalityContract = read("supabase/tests/causality_contract.sql");
const economicContract = read("supabase/tests/economic_contract.sql");
const gradeHistoryContract = read("supabase/tests/cloud_grade_history_contract.sql");
const decisionExplanationContract = read("supabase/tests/cloud_decision_explanations_contract.sql");
const confirmedQualityContract = read("supabase/tests/confirmed_quality_contract.sql");

function requirePattern(text, pattern, label) {
  if (!pattern.test(text)) throw new Error(`FAIL: ${label}`);
}

function rejectPattern(text, pattern, label) {
  if (pattern.test(text)) throw new Error(`FAIL: ${label}`);
}

for (const slug of ["market-cycle", "train-challenger", "bootstrap-data"]) {
  requirePattern(
    config,
    new RegExp(`\\[functions\\.${slug.replace("-", "\\-")}\\]\\s+verify_jwt\\s*=\\s*true`, "m"),
    `${slug} must keep verify_jwt=true`,
  );
}
requirePattern(config, /\[functions\.calendar-replay\]\s+verify_jwt\s*=\s*true/m,
  "calendar-replay must keep verify_jwt=true");

requirePattern(http, /claims\.role\s*!==\s*"anon"\s*&&\s*claims\.role\s*!==\s*"service_role"/,
  "ordinary authenticated-user JWTs must be rejected");
requirePattern(http, /SIGNAL_ATLAS_CRON_SECRET/, "the independent Edge cron secret must be required");
requirePattern(http, /crypto\.subtle\.digest\("SHA-256"/, "secret comparison must use fixed-length digests");

for (const extension of ["pgcrypto", "pg_net", "pg_cron", "supabase_vault"]) {
  requirePattern(migration, new RegExp(extension), `migration must declare/check ${extension}`);
}
for (const name of [
  "cloud_latest_decisions",
  "cloud_opportunities",
  "cloud_segment_metrics",
  "cloud_paper_summary",
  "cloud_system_health",
]) {
  requirePattern(
    migration,
    new RegExp(`function signal_atlas\\.${name}_rows\\(\\)[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`, "i"),
    `${name} must use a private fixed-search_path projection`,
  );
  requirePattern(
    migration,
    new RegExp(`view public\\.${name}[\\s\\S]*?security_invoker = true[\\s\\S]*?signal_atlas\\.${name}_rows\\(\\)`, "i"),
    `${name} must remain a security_invoker public view`,
  );
}

for (const name of ["cloud_quality_segment_metrics", "cloud_quality_paper_summary"]) {
  requirePattern(
    qualityMigration,
    new RegExp(`function signal_atlas\\.${name}_rows\\(\\)[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`, "i"),
    `${name} must use a private fixed-search_path projection`,
  );
  requirePattern(
    qualityMigration,
    new RegExp(`view public\\.${name}[\\s\\S]*?security_invoker = true[\\s\\S]*?signal_atlas\\.${name}_rows\\(\\)`, "i"),
    `${name} must remain a security_invoker public view`,
  );
}

requirePattern(gradeHistoryMigration, /function signal_atlas\.cloud_grade_history_rows\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/i,
  "cloud grade history must use a private fixed-search_path projection");
requirePattern(gradeHistoryMigration, /view public\.cloud_grade_history[\s\S]*?security_invoker = true[\s\S]*?signal_atlas\.cloud_grade_history_rows\(\)/i,
  "cloud grade history must remain a security_invoker public view");
requirePattern(gradeHistoryMigration, /grade', 'D'\)\) in \('A', 'A\+'\)/i,
  "cloud grade history must expose only frozen A/A+ grades");
requirePattern(gradeHistoryMigration, /unresolved_missing_data/i,
  "terminal missing-candle history must not look indefinitely pending");
requirePattern(gradeHistoryMigration, /grant select on public\.cloud_grade_history[\s\S]*?to anon, authenticated, service_role/i,
  "browser roles may only read the sanitized grade history view");
rejectPattern(gradeHistoryMigration, /grant\s+(?:insert|update|delete|all)\s+on\s+public\.cloud_grade_history/i,
  "cloud grade history must never expose write privileges");

requirePattern(decisionExplanationMigration,
  /function signal_atlas\.cloud_decision_explanation_rows\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/i,
  "cloud decision explanations must use a private fixed-search_path projection");
requirePattern(decisionExplanationMigration,
  /view public\.cloud_decision_explanations[\s\S]*?security_invoker = true[\s\S]*?signal_atlas\.cloud_decision_explanation_rows\(\)/i,
  "cloud decision explanations must remain a security_invoker public view");
requirePattern(decisionExplanationMigration,
  /grant select on public\.cloud_decision_explanations to anon, authenticated, service_role/i,
  "browser roles may only read the sanitized decision explanations view");
rejectPattern(decisionExplanationMigration,
  /grant\s+(?:insert|update|delete|all)\s+on\s+public\.cloud_decision_explanations/i,
  "cloud decision explanations must never expose write privileges");

requirePattern(confirmedQualityMigration,
  /model_deployment_events[\s\S]*?promotion_reviews[\s\S]*?action = 'promote_champion'/i,
  "confirmed quality must be proven by the prospective promotion ledger");
requirePattern(confirmedQualityMigration,
  /v_confirmed_samples\s*>=\s*coalesce[\s\S]*?min_promotion_paired_samples_confirmed/i,
  "confirmed quality must enforce the paired prospective sample policy");
requirePattern(confirmedQualityMigration,
  /when v_confirmed_pass[\s\S]*?then 'confirmed'/i,
  "confirmed quality must use its independent statistical gate");
rejectPattern(confirmedQualityMigration,
  /when\s+new\.feature_snapshot->>'grade'[\s\S]*?confirmed/i,
  "technical grade must never grant confirmed quality");
rejectPattern(confirmedQualityMigration, /champion_usable/i,
  "quality must not trust a champion_usable payload field");
requirePattern(confirmedQualityMigration,
  /function signal_atlas\.cloud_canonical_signal_rows\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/i,
  "canonical signals must use a private fixed-search_path projection");
requirePattern(confirmedQualityMigration,
  /view public\.cloud_canonical_signals[\s\S]*?security_invoker = true/i,
  "canonical signals must remain a security_invoker public view");
rejectPattern(confirmedQualityMigration,
  /grant\s+(?:insert|update|delete|all)\s+on\s+public\.cloud_canonical_signals/i,
  "canonical signals must never expose write privileges");

requirePattern(migration, /revoke all on all tables in schema signal_atlas from public, anon, authenticated/i,
  "browser roles must lose all private table grants");
rejectPattern(migration, /grant\s+select\s+on\s+signal_atlas\./i,
  "migration 011 must not grant browser SELECT on private tables");
requirePattern(migration, /signal_atlas_cron_secret/, "scheduler must read the dedicated Vault secret");
requirePattern(migration, /X-Signal-Atlas-Cron-Secret/, "scheduler must send the dedicated secret header");
requirePattern(migration, /v_jwt_payload->>'role'[\s\S]*?not in \('anon', 'service_role'\)/,
  "activation must reject a user-session Vault JWT");
requirePattern(migration, /function signal_atlas\.activate_schedules\(\)/,
  "scheduler activation must be explicit");
rejectPattern(historicalScheduler, /cron\.schedule\s*\(/i,
  "migration 003 must not start jobs before the explicit migration 011 activation");

for (const tag of ["$$", "$function$", "$market_job$", "$train_job$"]) {
  const count = migration.split(tag).length - 1;
  if (count % 2 !== 0) throw new Error(`FAIL: unbalanced SQL dollar quote ${tag}`);
}
if ((economicMigration.split("$$").length - 1) % 2 !== 0) {
  throw new Error("FAIL: unbalanced SQL dollar quote in migration 019");
}
if ((calendarReplayMigration.split("$$").length - 1) % 2 !== 0) {
  throw new Error("FAIL: unbalanced SQL dollar quote in migration 023");
}
if ((gradeHistoryMigration.split("$function$").length - 1) % 2 !== 0) {
  throw new Error("FAIL: unbalanced SQL dollar quote in migration 024");
}

const suspiciousSecret = /(?:sb_secret_|service_role\s*[=:]\s*["'][A-Za-z0-9._-]{30,}|eyJ[A-Za-z0-9_-]{60,}\.)/;
rejectPattern(migration, suspiciousSecret, "migration must not contain a credential value");
rejectPattern(http, suspiciousSecret, "Edge source must not contain a credential value");
rejectPattern(qualityMigration, suspiciousSecret, "migration 013 must not contain a credential value");
rejectPattern(independentMigration, suspiciousSecret, "migration 014 must not contain a credential value");
rejectPattern(gapMigration, suspiciousSecret, "migration 016 must not contain a credential value");
rejectPattern(gapLifecycleMigration, suspiciousSecret, "migration 017 must not contain a credential value");
rejectPattern(abandonmentCleanupMigration, suspiciousSecret, "migration 018 must not contain a credential value");
rejectPattern(economicMigration, suspiciousSecret, "migration 019 must not contain a credential value");
rejectPattern(calendarReplayMigration, suspiciousSecret, "migration 023 must not contain a credential value");
rejectPattern(gradeHistoryMigration, suspiciousSecret, "migration 024 must not contain a credential value");
rejectPattern(decisionExplanationMigration, suspiciousSecret, "migration 025 must not contain a credential value");
rejectPattern(confirmedQualityMigration, suspiciousSecret, "migration 026 must not contain a credential value");
rejectPattern(calendarReplay, suspiciousSecret, "calendar replay Edge source must not contain a credential value");
requirePattern(gradeHistoryContract, /resolved_at < expiry_at/i,
  "grade history contract must reject outcomes exposed before expiry");
requirePattern(securityContract, /public\.cloud_grade_history limit 0/i,
  "both browser roles must exercise the grade history view");
requirePattern(securityContract, /public\.cloud_decision_explanations limit 0/i,
  "both browser roles must exercise the decision explanations view");
requirePattern(decisionExplanationContract, /security_invoker=true/i,
  "decision explanations contract must assert security_invoker");
requirePattern(decisionExplanationContract, /correction_type = 'invalidate'/i,
  "decision explanations contract must reject invalidated decisions");
requirePattern(confirmedQualityContract, /technical grade still grants confirmed quality/i,
  "confirmed quality contract must reject grade coupling");
requirePattern(confirmedQualityContract, /public\.cloud_canonical_signals limit 0/i,
  "both browser roles must exercise the canonical signal view");

for (const table of ["economic_calendar_snapshots", "economic_calendar_fetch_snapshots"]) {
  requirePattern(calendarReplayMigration, new RegExp(`alter table signal_atlas\\.${table} force row level security`, "i"),
    `${table} must force RLS`);
}
requirePattern(calendarReplayMigration,
  /revoke all on signal_atlas\.economic_calendar_snapshots[\s\S]*?public, anon, authenticated, service_role/i,
  "complete calendar snapshots must deny direct table access");
requirePattern(calendarReplayMigration,
  /revoke all on function public\.archive_economic_calendar[\s\S]*?public, anon, authenticated, service_role/i,
  "calendar replay RPCs must revoke default execution");
requirePattern(calendarReplayMigration,
  /grant execute on function public\.archive_economic_calendar[\s\S]*?public\.calendar_replay_snapshots[\s\S]*?to service_role/i,
  "only service_role may use calendar ingestion and replay RPCs");
requirePattern(calendarReplayMigration,
  /jsonb_array_length\(p_points\)[\s\S]*?v_count > 750/i,
  "calendar replay batches must be bounded in SQL");
requirePattern(calendarReplay, /calendar_replay_snapshots/,
  "calendar replay Edge function must call only the bounded projection");
rejectPattern(calendarReplay, /archive_economic_calendar|from\s+signal_atlas\./i,
  "calendar replay Edge function must not write or query private tables directly");

requirePattern(independentMigration, /create table if not exists signal_atlas\.policy_shadow_decisions/i,
  "independent policy shadow ledger must exist");
requirePattern(independentMigration, /d\.mode = 'neutro'/i,
  "promotion must use one canonical neutral-mode opportunity");
requirePattern(independentMigration, /challenger independently beats champion and heuristic/i,
  "promotion must beat both champion and heuristic");
requirePattern(independentMigration, /alter table signal_atlas\.policy_shadow_decisions force row level security/i,
  "independent private ledger must force RLS");
requirePattern(independentMigration, /revoke all on signal_atlas\.policy_shadow_decisions[\s\S]*?public, anon, authenticated, service_role/i,
  "independent private ledger must deny direct access");
requirePattern(marketCycle, /neutralDecisionId\s*=\s*neutralStatus\s*!==\s*"wait"\s*&&\s*registered\?\.id/i,
  "WAIT records must never be sent as decision_event IDs to the independent laboratory");

for (const table of ["candle_gaps", "candle_gap_attempts", "resolution_abandonments"]) {
  requirePattern(gapMigration, new RegExp(`alter table signal_atlas\\.${table} force row level security`, "i"),
    `${table} must force RLS`);
}
requirePattern(gapMigration, /revoke all on signal_atlas\.candle_gaps[\s\S]*?public, anon, authenticated, service_role/i,
  "gap tables must deny direct access to browser and service roles");
requirePattern(gapMigration, /revoke all on function public\.list_due_candle_gaps[\s\S]*?public, anon, authenticated, service_role/i,
  "gap RPCs must revoke PUBLIC and browser execution");
requirePattern(gapMigration, /grant execute on function public\.list_due_candle_gaps[\s\S]*?to service_role/i,
  "only service_role may execute gap RPCs");
requirePattern(gapMigration, /lease_token[\s\S]*?lease_expires_at[\s\S]*?for update skip locked/i,
  "gap claims must use an expiring lease and row locking");
requirePattern(gapMigration, /5 \* pg_catalog\.power\(2, greatest\(0, v_attempts - 1\)\)/i,
  "gap retry backoff must start at five minutes");
requirePattern(gapMigration, /resolution_abandonments[\s\S]*?terminally abandoned decision cannot receive a later outcome/i,
  "terminal abandonment must prevent later outcomes");
rejectPattern(gapMigration, /resolution_abandoned_at/i,
  "gap handling must not mutate immutable decision events");
requirePattern(gapBackfill, /p_limit:\s*6/i, "each cycle must claim a bounded gap batch");
requirePattern(gapBackfill, /mapLimited(?:<[^>]+>)?\(due, 3/i, "provider gap calls must have bounded concurrency");
requirePattern(gapBackfill, /gapTargetOpenTime\(gap\.missing_kind/i,
  "expiry recovery must target the candle open, not the expiry timestamp");
requirePattern(marketCycle, /gapBackfill\.resolved > 0[\s\S]*?resolve_due_outcomes/i,
  "recovered exact candles must trigger immediate causal re-resolution");
requirePattern(gapLifecycleMigration, /status in \('pending', 'resolved', 'permanently_missing', 'cancelled'\)/i,
  "gap lifecycle must distinguish cancelled queue work");
requirePattern(gapLifecycleMigration, /after insert on signal_atlas\.outcomes[\s\S]*?for each statement/i,
  "outcomes must clean only unreferenced pending gap work");
requirePattern(gapLifecycleMigration, /not exists \([\s\S]*?signal_atlas\.decision_events/i,
  "gap cleanup must preserve work still referenced by an unresolved decision");
requirePattern(abandonmentCleanupMigration, /after insert on signal_atlas\.resolution_abandonments/i,
  "terminal abandonment must clean related pending gap work immediately");
requirePattern(abandonmentCleanupMigration, /revoke all on function signal_atlas\.cancel_related_gaps_after_abandonment\(\)[\s\S]*?service_role/i,
  "abandonment cleanup helper must remain private");

requirePattern(economicMigration, /function signal_atlas\.expected_trade_ev\([\s\S]*?p_tie_policy signal_atlas\.tie_policy_code[\s\S]*?immutable[\s\S]*?security invoker[\s\S]*?set search_path = ''/i,
  "canonical tie-aware EV helper must be immutable and use a fixed search_path");
for (const trigger of [
  "canonical_decision_economics_before_insert",
  "canonical_shadow_economics_before_insert",
  "canonical_policy_shadow_economics_before_insert",
]) {
  requirePattern(economicMigration, new RegExp(`create trigger ${trigger}[\\s\\S]*?before insert`, "i"),
    `${trigger} must enforce economics before ledger insertion`);
}
requirePattern(economicMigration, /alter function public\.register_market_decision\(jsonb\)[\s\S]*?set schema signal_atlas/i,
  "legacy market-decision implementation must move out of the exposed schema");
requirePattern(economicMigration, /revoke execute on function signal_atlas\.register_market_decision_legacy_v2\(jsonb\)[\s\S]*?service_role/i,
  "legacy market-decision implementation must not be directly callable");
requirePattern(economicMigration, /grant execute on function public\.register_market_decision\(jsonb\) to service_role/i,
  "only service_role may call the canonical market-decision wrapper");
rejectPattern(economicMigration, /update\s+signal_atlas\.(decision_events|shadow_predictions|policy_shadow_decisions)/i,
  "migration 019 must never rewrite the immutable historical ledgers");
requirePattern(features, /function directionalEconomics\([\s\S]*?tiePolicy[\s\S]*?expectedEv/i,
  "Edge decisions must share a canonical tie-aware economic helper");
requirePattern(features, /const economics = directionalEconomics\([\s\S]*?options\.tiePolicy/i,
  "the live decision EV must use the configured tie policy");
for (const value of ["-0.021", "0.079", "0.164"]) {
  requirePattern(economicContract, new RegExp(value.replace("-", "\\-")),
    `economic SQL contract must verify ${value}`);
}

requirePattern(securityContract, /foreach v_role in array array\['anon'::name, 'authenticated'::name\]/i,
  "security contract must audit anon and authenticated roles");
requirePattern(securityContract, /n\.nspname = 'signal_atlas'[\s\S]*?c\.relkind in \('r', 'p'\)/i,
  "security contract must discover every private base table");
for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
  requirePattern(securityContract, new RegExp(`'${privilege}'`), `security contract must deny ${privilege}`);
}
requirePattern(securityContract, /public\.calendar_replay_snapshots\(jsonb,integer\)/i,
  "security contract must deny direct browser execution of the calendar replay RPC");
requirePattern(causalityContract, /resolved_at < d\.expiry_at/i,
  "causality contract must reject early outcomes");
requirePattern(causalityContract, /ec\.open_time <> d\.entry_at[\s\S]*?xc\.close_time <> d\.expiry_at/i,
  "causality contract must bind exact entry and expiry candles");
requirePattern(causalityContract, /s\.predicted_at >= d\.entry_at/i,
  "causality contract must freeze shadows before entry");
requirePattern(causalityContract, /policy_shadow_decisions[\s\S]*?d\.mode <> 'neutro'/i,
  "causality contract must audit independent canonical opportunities");

console.log("Security release static contract: OK");
