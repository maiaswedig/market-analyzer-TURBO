import { computeMarketDecision, ENGINE_POLICY_VERSION, FEATURE_SCHEMA_VERSION } from "../_shared/features.ts";
import { backfillCandleGaps, type GapBackfillSummary } from "../_shared/gap-backfill.ts";
import { handleFunction, readJson } from "../_shared/http.ts";
import { externalMarketBlockers, fetchCalendarSnapshot, type CalendarSnapshot } from "../_shared/market-guards.ts";
import { currentLiveCandle, fetchMarketCandles } from "../_shared/providers.ts";
import { requiredRpc } from "../_shared/rpc.ts";
import { createAdminClient, type AdminClient } from "../_shared/supabase.ts";
import { cyclePhase, floorCandleOpen, iso, signalClock } from "../_shared/time.ts";
import { ingestCandles, latestClosedOpen, loadClosedCandles, loadScopeModels } from "../_shared/storage.ts";
import { TIMEFRAMES, type Timeframe, type WatchAsset } from "../_shared/types.ts";
import { loadWatchlist } from "../_shared/watchlist.ts";

interface CycleBody extends Record<string, unknown> {
  assetLimit: number;
  forceCollect: boolean;
  forceAnalyze: boolean;
  timeframes: string[];
}

interface ScopeResult {
  symbol: string;
  timeframe: Timeframe;
  fetched: number;
  closed: number;
  live: boolean;
  decision?: "signal" | "low-signal" | "wait";
  registrations?: Array<{ mode: OperationMode; kind: string; id?: string }>;
  shadowCount?: number;
  policyShadowCount?: number;
  error?: string;
}

interface ModeSettings {
  minScore: number;
  minConfluence: number;
  minLiveProgress: number;
  payout: number;
  operationCost: number;
  tiePolicy: string;
  requireRealVolume: boolean;
}

type OperationMode = "conservador" | "neutro" | "agressivo";

interface LoadedModePolicy {
  id: string;
  configHash: string;
  settings: ModeSettings;
}

type LoadedPolicies = Record<OperationMode, LoadedModePolicy>;

interface SourceSnapshot {
  receivedAt: number;
  latencyMs: number;
}

interface CalendarArchiveSummary {
  ok?: boolean;
  fetchId?: string;
  eventCount?: number;
  eventsInserted?: number;
  observationsInserted?: number;
  status?: "success" | "error";
}

// Os valores antigos continuam válidos no ledger, mas novos ciclos publicam
// uma única fotografia por ativo/timeframe/candle.
const MODES: readonly OperationMode[] = ["neutro"];

function finiteConfig(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
}

async function loadModePolicies(client: AdminClient): Promise<LoadedPolicies> {
  const { data, error } = await client.from("worker_policy_settings")
    .select("id,mode,config,config_hash,effective_from");
  if (error) throw new Error(`Falha ao carregar a política imutável do motor: ${error.message}`);
  const loaded = new Map<OperationMode, LoadedModePolicy>();
  for (const row of data || []) {
    const mode = String(row.mode || "") as OperationMode;
    if (!MODES.includes(mode) || !row.id || !row.config_hash || !row.config || typeof row.config !== "object") continue;
    const config = row.config as Record<string, unknown>;
    if (Number(config.engine_policy_version) !== ENGINE_POLICY_VERSION ||
      String(config.feature_schema_version || "") !== FEATURE_SCHEMA_VERSION) {
      throw new Error(`Política ${mode} incompatível com o schema/versão do motor.`);
    }
    loaded.set(mode, {
      id: String(row.id),
      configHash: String(row.config_hash),
      settings: {
        minScore: finiteConfig(config, "min_score", 62),
        minConfluence: finiteConfig(config, "min_confluence", 3),
        minLiveProgress: finiteConfig(config, "min_live_progress", 0.65),
        payout: finiteConfig(config, "payout_ratio", 0.85),
        operationCost: finiteConfig(config, "operation_cost", 0),
        tiePolicy: String(config.tie_policy || "loss"),
        requireRealVolume: true,
      },
    });
  }
  for (const mode of MODES) {
    if (!loaded.has(mode)) throw new Error(`Política ativa ausente para o modo ${mode}.`);
  }
  return Object.fromEntries(MODES.map((mode) => [mode, loaded.get(mode)!])) as LoadedPolicies;
}

function selectedTimeframes(value: unknown): Timeframe[] {
  if (!Array.isArray(value) || !value.length) return Object.keys(TIMEFRAMES) as Timeframe[];
  return [...new Set(value.map(String).filter((item): item is Timeframe => item in TIMEFRAMES))];
}

async function mapLimited<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
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

async function registerDecision(
  client: AdminClient,
  asset: WatchAsset,
  timeframe: Timeframe,
  mode: OperationMode,
  runId: string,
  now: number,
  decision: ReturnType<typeof computeMarketDecision>,
  policy: LoadedModePolicy,
  source: SourceSnapshot,
) {
  const observedOpen = decision.observedCandleOpen || floorCandleOpen(now, timeframe);
  const expiryCandles = Math.max(1, Math.min(3, Number(String(decision.expiration).replace(/^E/i, "")) || 1));
  const clock = signalClock(observedOpen, timeframe, expiryCandles);
  const payload = {
    run_id: runId,
    idempotency_key: `${asset.symbol}|${timeframe}|${observedOpen}|v${ENGINE_POLICY_VERSION}`,
    symbol: asset.symbol,
    provider_symbol: asset.providerSymbol,
    market: asset.market,
    source: asset.source,
    timeframe,
    mode,
    engine_policy_version: ENGINE_POLICY_VERSION,
    policy_version_id: policy.id,
    policy_signature: policy.configHash,
    observed_candle_open: iso(observedOpen),
    entry_candle_open: iso(clock.entryCandleOpen),
    target_candle_open: iso(clock.targetCandleOpen),
    resolve_after: iso(clock.resolveAfter),
    emitted_at: iso(now),
    expiration: decision.expiration,
    status: decision.status,
    direction: decision.direction,
    // `decision.score` is only the directional intensity used as one input of
    // the transparent assessment. The ledger score must match the A+/A/B/C/D
    // grade shown to the user, so policy/ranking and grade use the same
    // eight-check, five-family technical scale.
    score: decision.assessment.score,
    grade: decision.grade,
    technical_assessment: decision.assessment,
    confluence_count: decision.confluence,
    confidence: decision.confidence,
    ev_net: decision.evNet,
    reference_price: decision.referencePrice,
    used_live_candle: decision.usedLiveCandle,
    source_received_at: iso(source.receivedAt),
    data_age_ms: Math.max(0, now - source.receivedAt),
    source_latency_ms: Math.max(0, Math.round(source.latencyMs)),
    blockers: decision.blockers,
    reasons: decision.reasons,
    feature_vector: decision.featureVector,
    feature_schema_version: decision.predictions[0]?.featureSchemaVersion || FEATURE_SCHEMA_VERSION,
    champion_model_id: decision.championModelId,
    predictions: decision.predictions.map((prediction) => ({
      model_id: prediction.modelId,
      role: prediction.role,
      probability_up: prediction.probabilityUp,
      tie_probability: prediction.tieProbability,
      policy_action: prediction.policyAction,
      policy_direction: prediction.policyDirection,
      win_probability: prediction.winProbability,
      expected_ev: prediction.expectedEv,
      decision_policy_version: prediction.decisionPolicyVersion,
      feature_schema_version: prediction.featureSchemaVersion,
    })),
  };
  return await requiredRpc<{ kind?: string; id?: string }>(client, "register_market_decision", { p_decision: payload });
}

async function processScope(
  client: AdminClient,
  asset: WatchAsset,
  timeframe: Timeframe,
  runId: string,
  analyze: boolean,
  calendar: CalendarSnapshot | null,
  policies: LoadedPolicies,
): Promise<ScopeResult> {
  try {
    const latest = await latestClosedOpen(client, asset.symbol, timeframe);
    const fetchStartedAt = Date.now();
    const fetched = await fetchMarketCandles(asset, timeframe, {
      sinceMs: latest,
      limit: latest ? 500 : 300,
      includeLive: true,
      asOf: fetchStartedAt,
    });
    const fetchedAt = Date.now();
    if (!fetched.length) throw new Error("provedor não devolveu candles válidos");
    // `receivedAt` is the actual end of the provider request, never the cycle
    // start.  This keeps data age and network latency auditable.
    for (const candle of fetched) candle.receivedAt = fetchedAt;
    await ingestCandles(client, asset, timeframe, fetched, runId, fetchedAt);
    const decisionNow = Date.now();
    const live = currentLiveCandle(fetched, timeframe, decisionNow);
    const result: ScopeResult = {
      symbol: asset.symbol,
      timeframe,
      fetched: fetched.length,
      closed: fetched.filter((candle) => candle.isClosed).length,
      live: !!live,
    };
    if (!analyze) return result;

    // Inferência precisa apenas de warmup suficiente para EMA200 e filtros. O
    // histórico profundo fica reservado ao treino horário, reduzindo CPU no cron.
    const closed = await loadClosedCandles(client, asset, timeframe, 320);
    const models = await loadScopeModels(client, asset.symbol, timeframe);
    const expectedOpen = live?.openTime ?? floorCandleOpen(decisionNow, timeframe);
    const expectedClock = signalClock(expectedOpen, timeframe, 1);
    const externalBlockers = externalMarketBlockers(asset, expectedClock.entryCandleOpen, expectedClock.resolveAfter, calendar);
    const registrations: Array<{ mode: OperationMode; kind: string; id?: string }> = [];
    let neutralStatus: "signal" | "low-signal" | "wait" = "wait";
    let shadowCount = 0;
    let neutralDecisionId: string | null = null;
    let neutralPredictions: ReturnType<typeof computeMarketDecision>["predictions"] = [];
    for (const mode of MODES) {
      const policy = policies[mode];
      const settings = policy.settings;
      const modeBlockers = [...externalBlockers];
      // Forex has no centralized exchange volume. We never invent it; the
      // normal feature pipeline exposes that limitation in the frozen reasons.
      const decision = computeMarketDecision(closed, live, {
        now: decisionNow,
        timeframe,
        models,
        ...settings,
        requireRealVolume: asset.source === "binance",
        externalBlockers: modeBlockers,
      });
      if (!live) {
        decision.observedCandleOpen = expectedOpen;
        decision.entryCandleOpen = expectedClock.entryCandleOpen;
        decision.targetCandleOpen = expectedClock.targetCandleOpen;
        decision.resolveAfter = expectedClock.resolveAfter;
        // Sem a vela em andamento não existe a fotografia pedida pelo usuário.
        // Mantemos o viés visível como AGUARDAR, mas removemos o champion do
        // evento para que o RPC jamais o registre como paper trade/sinal.
        decision.championModelId = null;
        decision.blockers = [...new Set([...decision.blockers, 'vela atual obrigatória ausente; leitura não elegível para sinal'])];
      }
      decision.symbol = asset.symbol;
      const registered = await registerDecision(
        client,
        asset,
        timeframe,
        mode,
        runId,
        decisionNow,
        decision,
        policy,
        { receivedAt: fetchedAt, latencyMs: fetchedAt - fetchStartedAt },
      );
      const registeredKind = String(registered?.kind || decision.status);
      registrations.push({ mode, kind: registeredKind, id: registered?.id });
      shadowCount += decision.predictions.filter((prediction) => prediction.role === "shadow").length;
      if (mode === "neutro") {
        neutralStatus = registeredKind === "signal" || registeredKind === "low-signal"
          ? registeredKind
          : "wait";
        // A espera usa analysis_waits e devolve um ID que não pertence a
        // decision_events. O laboratório causal só pode parear oportunidades
        // que realmente viraram um evento de decisão imutável.
        neutralDecisionId = neutralStatus !== "wait" && registered?.id
          ? String(registered.id)
          : null;
        neutralPredictions = decision.predictions;
      }
    }
    if (neutralDecisionId) {
      try {
        const lab = await requiredRpc<{ inserted?: number }>(client, "register_policy_shadow_decisions", {
          p_decision_id: neutralDecisionId,
          p_predicted_at: iso(Date.now()),
          p_predictions: neutralPredictions.map((prediction) => ({
            model_id: prediction.modelId,
            probability_up: prediction.probabilityUp,
            tie_probability: prediction.tieProbability,
            decision_policy_version: prediction.decisionPolicyVersion,
          })),
        });
        result.policyShadowCount = Number(lab?.inserted) || 0;
      } catch (error) {
        result.error = `laboratório shadow independente: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    result.decision = neutralStatus;
    result.registrations = registrations;
    result.shadowCount = shadowCount;
    return result;
  } catch (error) {
    return {
      symbol: asset.symbol,
      timeframe,
      fetched: 0,
      closed: 0,
      live: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

Deno.serve((request) => handleFunction(request, async () => {
  const body = await readJson<CycleBody>(request);
  const client = createAdminClient();
  const now = Date.now();
  const startedAt = now;
  const runId = crypto.randomUUID();
  const allAssets = await loadWatchlist(client);
  const assetLimit = Math.max(1, Math.min(12, Math.round(Number(body.assetLimit) || 8)));
  const assets = allAssets.slice(0, assetLimit);
  if (!assets.length) return { ok: true, runId, status: "empty-watchlist", scopes: [] };

  const timeframes = selectedTimeframes(body.timeframes);
  const policies = await loadModePolicies(client);
  const scopes: Array<{ asset: WatchAsset; timeframe: Timeframe; analyze: boolean }> = [];
  for (const timeframe of timeframes) {
    const phase = cyclePhase(now, timeframe);
    if (!phase.collect && body.forceCollect !== true) continue;
    for (const asset of assets) scopes.push({ asset, timeframe, analyze: phase.analyze || body.forceAnalyze === true });
  }
  const needsCalendar = scopes.some((scope) => scope.analyze && scope.asset.source === "yahoo");
  const calendar = needsCalendar ? await fetchCalendarSnapshot(now) : null;
  // Archive the exact snapshot before it can influence a decision. Future
  // backtests can therefore reconstruct only information that was already
  // available at each decision timestamp; current news is never projected
  // backwards onto historical candles.
  const calendarArchive = calendar
    ? await requiredRpc<CalendarArchiveSummary>(client, "archive_economic_calendar", {
      p_run_id: runId,
      p_fetched_at: iso(calendar.fetchedAt),
      p_snapshot: {
        source: "Forex Factory",
        error: calendar.error,
        events: calendar.events || [],
      },
    })
    : null;
  const results = await mapLimited(scopes, 4, (scope) => processScope(
    client,
    scope.asset,
    scope.timeframe,
    runId,
    scope.analyze,
    calendar,
    policies,
  ));
  if (results.length && results.every((result) => !!result.error)) {
    throw new Error(`Todos os escopos falharam: ${results.slice(0, 3).map((result) => `${result.symbol}/${result.timeframe}: ${result.error}`).join(" | ")}`);
  }

  const resolutionAsOf = Date.now();
  const resolution = await requiredRpc(client, "resolve_due_outcomes", {
    p_as_of: iso(resolutionAsOf),
    p_run_id: runId,
  });
  const gapBackfill = await backfillCandleGaps(client, allAssets, runId, resolutionAsOf).catch((error): GapBackfillSummary => ({
    due: 0,
    attempted: 0,
    resolved: 0,
    abandoned: 0,
    pending: 0,
    failed: 1,
    errors: [error instanceof Error ? error.message : String(error)],
  }));
  // A recovered candle can make one or more decisions resolvable immediately.
  // Run the same causal resolver again only when the database confirmed an
  // exact recovery; never infer a result from the provider response itself.
  const recoveredResolution = gapBackfill.resolved > 0
    ? await requiredRpc(client, "resolve_due_outcomes", {
      p_as_of: iso(Date.now()),
      p_run_id: runId,
    })
    : null;
  const reviewAsOf = Date.now();
  const promotion = await requiredRpc(client, "review_and_promote_challengers", {
    p_as_of: iso(reviewAsOf),
    p_min_resolved: 500,
    // The database stores explicit 95% confidence bounds for promotion.
    p_z_margin: 1.96,
  });
  const errors = results.filter((result) => !!result.error).length;
  const registrations = results.flatMap((result) => result.registrations || []);
  const decisionsCreated = registrations.filter((item) => item.kind === "signal" || item.kind === "low-signal").length;
  const waits = registrations.filter((item) => item.kind === "wait").length;
  const finishedAt = Date.now();
  const lastResult = results[results.length - 1];
  await requiredRpc(client, "record_scanner_run", {
    p_payload: {
      idempotency_key: `market-cycle|${runId}`,
      worker_id: "supabase-edge-market-cycle-v1",
      started_at: iso(startedAt),
      finished_at: iso(finishedAt),
      status: errors === 0 ? "ok" : errors < results.length ? "partial" : "failed",
      assets_requested: assets.length,
      decisions_created: decisionsCreated,
      shadows_created: results.reduce((sum, result) => sum + (result.shadowCount || 0), 0),
      waits,
      errors,
      details: {
        scopes: results.length,
        last_symbol: lastResult?.symbol || null,
        last_timeframe: lastResult?.timeframe || null,
        candle_gaps: gapBackfill,
        calendar_archive: calendarArchive,
      },
      health: [{
        component: "market-cycle",
        status: errors === 0 ? "healthy" : errors < results.length ? "degraded" : "down",
        observed_at: iso(finishedAt),
        latency_ms: finishedAt - startedAt,
        last_data_at: iso(now),
        message: `${decisionsCreated} sinais · ${waits} aguardares · ${errors} erros · ${gapBackfill.resolved}/${gapBackfill.due} lacunas recuperadas`,
        details: { assets: assets.length, scopes: results.length, candle_gaps: gapBackfill, calendar_archive: calendarArchive },
      }],
    },
  });
  return {
    ok: results.every((result) => !result.error),
    runId,
    at: iso(now),
    assets: assets.length,
    decisionsCreated,
    waits,
    scopes: results,
    resolution,
    gapBackfill,
    recoveredResolution,
    promotion,
    calendar: calendar ? { fetchedAt: iso(calendar.fetchedAt), events: calendar.events?.length ?? null, error: calendar.error } : null,
    calendarArchive,
  };
}));
