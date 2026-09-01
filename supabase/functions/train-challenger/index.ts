import { buildFeatureRows, ENGINE_POLICY_VERSION, FEATURE_SCHEMA_VERSION, policySignature } from "../_shared/features.ts";
import { handleFunction, HttpError, readJson } from "../_shared/http.ts";
import { trainChronological, type TrainingSample } from "../_shared/logistic.ts";
import { requiredRpc } from "../_shared/rpc.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { loadClosedCandles } from "../_shared/storage.ts";
import { iso } from "../_shared/time.ts";
import { TIMEFRAMES, type Timeframe, type WatchAsset } from "../_shared/types.ts";
import { loadWatchlist } from "../_shared/watchlist.ts";

interface TrainBody extends Record<string, unknown> {
  symbol: string;
  timeframe: string;
  maxCandles: number;
  minValidation: number;
  epochs: number;
}

function chooseScope(assets: WatchAsset[], body: Partial<TrainBody>, now: number): { asset: WatchAsset; timeframe: Timeframe } {
  if (!assets.length) throw new HttpError(409, "assets_watchlist está vazia.");
  if (body.symbol || body.timeframe) {
    const symbol = String(body.symbol || "").toUpperCase();
    const timeframe = String(body.timeframe || "") as Timeframe;
    const asset = assets.find((item) => item.symbol === symbol);
    if (!asset) throw new HttpError(400, `Ativo não está na watchlist: ${symbol || "—"}`);
    if (!(timeframe in TIMEFRAMES)) throw new HttpError(400, "Timeframe permitido: M5, M15, M30 ou H1.");
    return { asset, timeframe };
  }
  // Um escopo por hora mantém a função dentro do orçamento gratuito e dá a
  // cada ativo/TF uma janela determinística de retreino.
  const cursor = Math.floor(now / 3_600_000);
  const asset = assets[cursor % assets.length];
  const timeframeList = Object.keys(TIMEFRAMES) as Timeframe[];
  const timeframe = timeframeList[Math.floor(cursor / assets.length) % timeframeList.length];
  return { asset, timeframe };
}

Deno.serve((request) => handleFunction(request, async () => {
  const body = await readJson<TrainBody>(request);
  const client = createAdminClient();
  const now = Date.now();
  const assets = await loadWatchlist(client);
  const { asset, timeframe } = chooseScope(assets, body, now);
  const maxCandles = Math.max(1_200, Math.min(4_000, Math.round(Number(body.maxCandles) || 3_500)));
  const minValidation = Math.max(300, Math.min(500, Math.round(Number(body.minValidation) || 300)));
  const epochs = Math.max(40, Math.min(120, Math.round(Number(body.epochs) || 80)));
  const candles = await loadClosedCandles(client, asset, timeframe, maxCandles);
  const rows = buildFeatureRows(candles);
  const samples: TrainingSample[] = [];
  let ties = 0;
  let labeled = 0;
  for (const row of rows) {
    const target = candles[row.index + 1];
    if (!target || !target.isClosed) continue;
    labeled++;
    if (target.close === target.open) { ties++; continue; }
    samples.push({ at: row.openTime, vector: row.vector, label: target.close > target.open ? 1 : 0 });
  }
  const tieRate = labeled ? (ties + 1) / (labeled + 2) : 0;
  const training = trainChronological(samples, { minValidation, epochs, zMargin: 1.5, tieRate });
  if (!training.ok || !training.artifact) {
    return {
      ok: false,
      scope: { symbol: asset.symbol, timeframe },
      candles: candles.length,
      directionalSamples: samples.length,
      ties,
      reason: training.reason || "treino não produziu artefato",
    };
  }

  const artifact = training.artifact;
  const artifactPayload = {
    idempotency_key: `${asset.symbol}|${timeframe}|${artifact.trainTo}|${FEATURE_SCHEMA_VERSION}|v${artifact.validationPolicyVersion}`,
    symbol: asset.symbol,
    timeframe,
    status: artifact.usable ? "candidate" : "rejected",
    algorithm: artifact.algorithm,
    feature_schema_version: artifact.featureSchemaVersion,
    validation_policy_version: artifact.validationPolicyVersion,
    engine_policy_version: ENGINE_POLICY_VERSION,
    policy_signature: policySignature({ minValidation, zMargin: 1.5, horizon: "E1", closedCandlesOnly: true }),
    trained_at: artifact.trainedAt,
    train_from: artifact.trainFrom,
    train_to: artifact.trainTo,
    validation_from: artifact.validationFrom,
    validation_to: artifact.validationTo,
    shadow_start_after: artifact.validationTo,
    sample_size: artifact.samples,
    validation_sample_size: artifact.validationSamples,
    tie_rate: artifact.tieRate,
    usable: artifact.usable,
    metrics: artifact.metrics,
    gates: training.gates,
    artifact,
    immutable: true,
  };
  const created = await requiredRpc(client, "create_model_artifact", { p_artifact: artifactPayload });
  const reviewAsOf = Date.now();
  const review = await requiredRpc(client, "review_and_promote_challengers", {
    p_as_of: iso(reviewAsOf),
    p_symbol: asset.symbol,
    p_timeframe: timeframe,
    p_min_resolved: 500,
    p_z_margin: 1.96,
  });
  return {
    ok: true,
    scope: { symbol: asset.symbol, timeframe },
    candles: candles.length,
    labeled,
    directionalSamples: samples.length,
    ties,
    tieRate,
    candidateUsable: artifact.usable,
    validation: artifact.metrics,
    created,
    review,
  };
}));
