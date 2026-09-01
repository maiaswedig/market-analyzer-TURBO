import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const cycle = read("supabase/functions/market-cycle/index.ts");
const features = read("supabase/functions/_shared/features.ts");
const migration = read("supabase/migrations/202608310026_decouple_confirmed_quality.sql");

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

function rejectPattern(source, pattern, message) {
  if (pattern.test(source)) throw new Error(message);
}

requirePattern(cycle, /score:\s*decision\.assessment\.score/, "ledger score must use the weighted technical assessment");
rejectPattern(cycle, /score:\s*decision\.score\s*,/, "directional intensity must not be published as the technical score");
requirePattern(cycle, /grade:\s*decision\.grade/, "ledger must publish the matching technical grade");
requirePattern(cycle, /technical_assessment:\s*decision\.assessment/, "Edge payload must retain the assessment evidence");
requirePattern(features, /familyDefinitions[\s\S]*trend[\s\S]*momentum[\s\S]*rsi[\s\S]*volume[\s\S]*price_action/, "five evidence families are required");
requirePattern(features, /if \(assessmentScore >= 85\)[\s\S]*if \(assessmentScore >= 72\)/, "A+ and A thresholds changed unexpectedly");
requirePattern(migration, /r\.score[\s\S]*feature_snapshot->>'grade'/, "canonical browser view must expose the frozen score and grade together");

console.log("Backend score contract: OK");
