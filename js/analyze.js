// analyze.js — orquestra dados + indicadores + categorias + decisão por expectativa.
// O MESMO motor (`evaluateBar`) é usado pela análise ao vivo, pelo scanner, pelo backtest
// e pelo diagnóstico de calibração — assim os números da UI e do backtest são comparáveis.
import { MTF_MAP, TIMEFRAMES } from './assets.js';
import { getCandles, candleWindow, DEPTH_TARGET } from './data.js';
import { buildSeries, snapshotAt, MIN_WARMUP } from './features.js';
import { computeScore, tfDirection, setupGrade, confluenceOf } from './score.js';
import { marketCondition } from './condition.js';
import { historicalProbability, labelSnapshots } from './probability.js';
import { predict } from './ml.js';
import { fingerprint, setupStatsFor } from './setups.js';
import { decide, whyBullets, INSUFFICIENT } from './decision.js';
import { wickRejectionGuard, higherTfZoneGuard, vsaGuard, sessionGuard, suggestExpiry } from './filters.js';
import { highImpactCalendar, calendarGuard } from './news.js';
import { fmtPrice } from './util.js';

export const DEFAULT_SETTINGS = {
  mode: 'normal',
  defaultAsset: 'BTCUSDT',
  defaultTf: 'M5',
  minScore: 64,               // limiar do score técnico (0–100, neutro = 50)
  minConfluence: 2,           // 0 = desligado
  minSamples: 40,             // amostra mínima de análogos
  minSetupSamples: 25,        // amostra mínima da classe de setup
  maxDistance: 6,
  scoreB0: 0.06,
  scoreB1: 0.45,
  evGate: 'aviso',            // 'aviso' = só avisa | 'bloquear' = exige EV > minEv
  minEv: 0,
  payout: 85,                 // %
  stake: 5,                   // R$ por operação
  operationCost: 0,           // R$ por operação: spread + slippage estimados
  tiePolicy: 'loss',          // tratamento de empate configurado conforme a corretora
  banca: 250,                 // R$
  stakePct: 0,                // 0 = valor fixo (sem martingale, sempre)
  minZoneAtr: 0.35,
  // 10 mil é o padrão para treino local. A fonte pode devolver menos, conforme o ativo/TF.
  // Valores maiores continuam disponíveis nas configurações, mas custam mais tempo e requisições.
  deepCandles: 10000,
  thresholds: {},             // { 'ATIVO|TF|E1': score mínimo walk-forward por expiração }
  wickFilter: true,
  wickOppositionRatio: 0.40,
  higherTfZoneFilter: true,
  higherTfZoneMaxAtr: 1,
  higherTfMinZoneStrength: 4,
  higherTfRequireContext: true,
  vsaFilter: true,
  vsaMinRelativeVolume: 0.8,
  vsaRequireRealVolume: true,
  vsaMinCandleProgress: 0.20,
  flexibleExpiry: true,
  maxExpiryCandles: 3,
  newsFilter: true,
  newsBlockBeforeMin: 5,
  newsBlockAfterMin: 5,
  newsFailClosedForex: true,
  newsApplyCryptoUsd: false,
  sessionGuard: true,
  sessionGuardForexOnly: true,
  sessionBlackoutMinutes: 10,
  scannerMarket: 'Cripto',
  scannerCount: 10,
  scannerTfs: ['M5'],
  scannerAuto: true,
  scannerIntervalSec: 300,
  autoRefresh: false,
  refreshSec: 30,
  useMl: true,
  alertSound: true,
  alertNotification: false,
  alertVisual: true,
  alertOnlyAGrades: true,
  theme: 'dark',
  brokerTolPct: 0.15,
  weights: { tendencia: 22, momentum: 18, multitf: 18, priceaction: 14, sr: 12, volatilidade: 8, volume: 8 },
  toggles: { ema: true, rsi: true, macd: true, stoch: true, volume: true, bollinger: true, estrutura: true, sr: true, priceaction: true, atr: true, multitf: true }
};

export const MODE_PRESETS = {
  conservador: { minScore: 68, minConfluence: 3, minSamples: 40, minSetupSamples: 25, evGate: 'bloquear' },
  normal: { minScore: 64, minConfluence: 2, minSamples: 40, minSetupSamples: 25, evGate: 'aviso' },
  agressivo: { minScore: 52, minConfluence: 2, minSamples: 20, minSetupSamples: 10, evGate: 'aviso' }
};

export function thresholdScope(assetId, tf, expiryCandles = 1) {
  const horizon = Math.max(1, Math.min(3, Math.round(Number(expiryCandles) || 1)));
  return `${assetId}|${tf}|E${horizon}`;
}

/** Versão da política que precisa coincidir com uma calibração salva. */
export function filterPolicySignature(cfg = {}) {
  // A calibração é válida somente para a mesma população de regras. Campos
  // ordenados evitam uma assinatura diferente apenas pela ordem do objeto salvo.
  const ordered = value => Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, typeof item === 'boolean' ? item : Number.isFinite(Number(item)) ? Number(item) : item]));
  const value = {
    // v6 invalida calibrações anteriores ao agrupamento das divergências de
    // pavio, VSA e contexto ausente. A população de sinais mudou e um limiar
    // escolhido com as travas independentes não pode ser reaproveitado.
    version: 6,
    // O replay de limiar desliga ML para não vazar futuro; portanto o modelo
    // não entra nesta assinatura de limiar técnico. Todos os demais parâmetros
    // que mudam população, score ou EV entram abaixo.
    replayModel: 'disabled-for-causality',
    decision: [cfg.mode || 'normal', Number(cfg.minScore ?? 0), Number(cfg.minConfluence ?? 0), Number(cfg.minSamples ?? 0), Number(cfg.minSetupSamples ?? 0), Number(cfg.maxDistance ?? 0), cfg.evGate || 'aviso', Number(cfg.minEv ?? 0)],
    score: [Number(cfg.scoreB0 ?? 0), Number(cfg.scoreB1 ?? 0), Number(cfg.minZoneAtr ?? 0), ordered(cfg.weights), ordered(cfg.toggles)],
    economics: [Number(cfg.payout ?? 0), Number(cfg.stake ?? 0), Number(cfg.operationCost ?? 0), cfg.tiePolicy || 'loss'],
    sample: [Number(cfg.deepCandles ?? 0)],
    wick: [cfg.wickFilter !== false, Number(cfg.wickOppositionRatio ?? 0.4)],
    htf: [cfg.higherTfZoneFilter !== false, Number(cfg.higherTfZoneMaxAtr ?? 1), Number(cfg.higherTfMinZoneStrength ?? 4), cfg.higherTfRequireContext !== false],
    vsa: [cfg.vsaFilter !== false, Number(cfg.vsaMinRelativeVolume ?? 0.8), cfg.vsaRequireRealVolume !== false, Number(cfg.vsaMinCandleProgress ?? 0.2)],
    expiry: [cfg.flexibleExpiry !== false, Number(cfg.maxExpiryCandles ?? 3)],
    news: [cfg.newsFilter !== false, Number(cfg.newsBlockBeforeMin ?? 5), Number(cfg.newsBlockAfterMin ?? 5), cfg.newsFailClosedForex !== false, cfg.newsApplyCryptoUsd === true],
    session: [cfg.sessionGuard !== false, cfg.sessionGuardForexOnly !== false, Number(cfg.sessionBlackoutMinutes ?? 10)],
    calibration: { requiredZoneContextCoverage: 0.95 }
  };
  return JSON.stringify(value);
}

export function effectiveMinScore(cfg, assetId, tf, expiryCandles = 1) {
  const key = thresholdScope(assetId, tf, expiryCandles);
  const v = cfg.thresholds && cfg.thresholds[key];
  // Uma calibração local nunca pode tornar o modo escolhido mais frouxo.
  // Ela só endurece o limiar quando a validação walk-forward justificou isso.
  return Number.isFinite(Number(v)) ? Math.max(Number(cfg.minScore), Number(v)) : Number(cfg.minScore);
}

/** Conjunto de snapshots rotulados (analogia histórica, ML, backtest e diagnóstico). */
export function buildSnapshotPool(candles, hasVolume, { from = MIN_WARMUP, stride = 1, zoneLookback = 160, max = 0 } = {}) {
  const series = buildSeries(candles, { hasVolume });
  const snaps = [];
  let start = Math.max(MIN_WARMUP, from);
  if (max && candles.length - start > max) start = candles.length - max;
  for (let i = start; i < candles.length; i += stride) {
    const s = snapshotAt(series, i, { zoneLookback });
    if (s) snaps.push(s);
  }
  labelSnapshots(snaps, candles);
  return { series, snaps };
}

/**
 * MOTOR ÚNICO — avalia UMA barra de forma estritamente causal.
 * @param snap      snapshot da barra t (features só de candles ≤ t)
 * @param mtf       [{tf, dir, isMain, unavailable}] já resolvido causalmente
 * @param pastSnaps snapshots anteriores a t (para analogia histórica) — pode ser []
 * @param opts      { cfg, model, setupRanking, brokerDivergence }
 */
export function evaluateBar(snap, mtf, pastSnaps, opts = {}) {
  const cfg = opts.cfg || DEFAULT_SETTINGS;
  const cond = marketCondition(snap);
  const score = computeScore(snap, mtf, cond, cfg);
  const dir = score.direction;
  const expiry = suggestExpiry(snap, dir, cfg);
  const horizon = expiry.candles;
  const decisionCfg = {
    ...cfg,
    minScore: opts.assetId && opts.tfKey ? effectiveMinScore(cfg, opts.assetId, opts.tfKey, horizon) : Number(cfg.minScore)
  };

  const precomputedHist = opts.historicalByHorizon && opts.historicalByHorizon[horizon];
  const hist = precomputedHist || (pastSnaps && pastSnaps.length
    ? historicalProbability(pastSnaps, snap, { minSamples: cfg.minSamples, maxDistance: cfg.maxDistance, maxNeighbors: opts.maxNeighbors || 300, horizon })
    : { insufficient: true, samples: 0, minSamples: cfg.minSamples, horizon, text: 'sem histórico comparável carregado', maxDistance: cfg.maxDistance, baseDistance: cfg.maxDistance });

  let ml = null;
  if (horizon === 1 && cfg.useMl && opts.model && opts.model.ok) {
    const p = predict(opts.model, snap.vector);
    ml = {
      p, usable: !!opts.model.usable && !opts.model.overfit, brier: opts.model.validMetrics ? opts.model.validMetrics.brier : null,
      validN: opts.model.validMetrics ? opts.model.validMetrics.n : null,
      baseBrier: opts.model.baseBrier ?? null,
      // O classificador é condicional às velas não neutras; a taxa de empate
      // do mesmo treino devolve a probabilidade para a escala da operação.
      tieP: Number.isFinite(Number(opts.model.tieRate)) ? Number(opts.model.tieRate) : null,
      gateReason: opts.model.gateReason || null
    };
  } else if (horizon > 1 && cfg.useMl) {
    // O modelo salvo hoje é treinado e validado apenas para E1. Não o
    // reutilizamos para E2/E3 sem validação independente por horizonte.
    ml = { p: null, usable: false, horizonLimited: true, gateReason: `modelo de 1 vela não é usado na expiração de ${horizon} velas` };
  }

  const fp = dir !== 0 ? fingerprint(snap, mtf, dir, horizon) : null;
  const rankingScope = opts.assetId && opts.tfKey ? thresholdScope(opts.assetId, opts.tfKey, horizon) : null;
  const setupRanking = rankingScope && opts.setupRankings ? opts.setupRankings[rankingScope] : opts.setupRanking;
  const setupStats = fp && setupRanking ? setupStatsFor(setupRanking, fp.id, cfg.minSetupSamples) : null;

  const tfSec = Math.max(1, Number(opts.tfSec) || 60);
  const entryAt = Number.isFinite(Number(opts.entryAt)) ? Number(opts.entryAt) : snap.t + tfSec * 1000;
  const expiresAt = entryAt + horizon * tfSec * 1000;
  const marketGuards = {
    wick: wickRejectionGuard(snap, dir, cfg),
    htfZone: higherTfZoneGuard(snap, opts.zoneContexts || mtf, dir, cfg),
    vsa: vsaGuard(snap, dir, cfg, { now: opts.now || Date.now(), timeframeSec: tfSec }),
    session: sessionGuard(opts.asset, entryAt, expiresAt, cfg),
    news: opts.historicalNewsUnavailable
      ? { enabled: cfg.newsFilter !== false, blocked: false, historicalUnavailable: true, text: 'calendário histórico não disponível; backtest não aplica agenda atual ao passado' }
      : calendarGuard(opts.asset, entryAt, expiresAt, cfg, opts.newsCalendar || null)
  };

  const decision = decide({ score, mtf, cond, hist, ml, setupStats: setupStats && setupStats.enough ? setupStats : null, cfg: decisionCfg, brokerDivergence: opts.brokerDivergence, dataFreshness: opts.dataFreshness || null, marketGuards, expiry });
  const softSafetyWarnings = ['wick', 'htfZone', 'vsa'].filter(key => marketGuards[key] && marketGuards[key].enabled !== false && marketGuards[key].blocked).length;
  const grade = setupGrade({
    score: score.score, confluence: score.confluence, cond, penaltyTotal: score.penaltyTotal,
    setupStats: setupStats && setupStats.enough ? { ...setupStats, ev: setupStats.ev, rate: setupStats.rate } : null,
    blocked: decision.blocked,
    warningCount: softSafetyWarnings
  });
  grade.softSafetyWarnings = softSafetyWarnings;

  return { snap, cond, score, hist, ml, fingerprint: fp, setupStats, decision, grade, expiry: { ...expiry, entryAt, expiresAt }, filters: marketGuards, minScoreUsed: decisionCfg.minScore, verdict: decision.verdict };
}

/* ------------------------------------------------------------------ análise ao vivo */
export async function analyzeAsset(asset, tfKey, settings, opts = {}) {
  const cfg = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const { light = false, model = null, setupRanking = null, setupRankings = null, brokerDivergence = null, onStage = () => {} } = opts;
  const tfs = [...new Set([...(MTF_MAP[tfKey] || [tfKey]), 'M15', 'H1', tfKey])];
  const zoneTfs = ['M15', 'H1'];
  const result = { asset, tfKey, at: Date.now(), errors: [], sources: {}, mtf: [], warnings: [], verdict: 'AGUARDAR' };

  onStage('Buscando candles reais…');
  const dataByTf = {};
  const mainDepth = light ? 'mid' : 'deep';
  const requestedHistoryTarget = Number(opts.historyTarget);
  const configuredHistoryTarget = Math.max(1500, Number(cfg.deepCandles) || DEPTH_TARGET.deep);
  // O scanner pode usar uma janela intermediária sem entrar no modo `light`,
  // preservando o mesmo motor, indicadores, zonas e fotografia que será aberta.
  // A análise escolhida pelo usuário continua usando todo o histórico configurado.
  const mainTarget = light
    ? DEPTH_TARGET.mid
    : (Number.isFinite(requestedHistoryTarget)
      ? Math.max(1500, Math.min(configuredHistoryTarget, Math.floor(requestedHistoryTarget)))
      : configuredHistoryTarget);
  const fetchOne = async (tf, depth, target, includeLive = opts.includeLive !== false, targetMap = dataByTf, writeSource = targetMap === dataByTf) => {
    try {
      const d = await getCandles(asset, tf, { depth, target, includeLive, onProgress: opts.onFetchProgress });
      targetMap[tf] = d;
      if (writeSource) result.sources[tf] = {
        source: d.source, aggregatedFrom: d.aggregatedFrom, count: d.count,
        latencyMs: d.latencyMs, updatedAt: d.updatedAt, lastCandleTime: d.lastCandleTime,
        dataAgeMs: d.dataAgeMs, candleAgeMs: d.candleAgeMs, latencyLimitMs: d.latencyLimitMs,
        cached: !!d.cached, stale: !!d.stale, hasVolume: d.hasVolume
      };
      if (d.error && writeSource) result.warnings.push(`${tf}: ${d.error}`);
    } catch (e) {
      if (writeSource) result.errors.push(`${tf}: ${e.message}`);
      else result.warnings.push(`zonas ${tf}: indisponíveis (${e.message})`);
    }
  };
  await fetchOne(tfKey, mainDepth, mainTarget);
  const main = dataByTf[tfKey];
  if (main) await Promise.all(tfs.filter(tf => tf !== tfKey).map(tf => fetchOne(tf, 'context', DEPTH_TARGET.context)));

  if (!main) {
    result.dataError = true;
    result.reasons = ['Fonte de dados indisponível para o ativo/timeframe selecionado — nenhuma análise foi feita (nenhum candle é simulado).'];
    return result;
  }
  const analyzedAt = Date.now();
  const inProgressCandle = !!(main.candles[main.candles.length - 1] && main.candles[main.candles.length - 1].live);
  const mainSource = result.sources[tfKey] || {};
  const latencyLimitMs = Number(mainSource.latencyLimitMs) || TIMEFRAMES[tfKey].sec * 1000 * 1.5;
  const yahooOnly = asset.kind === 'yahoo';
  const dataAgeMs = Math.max(0, Number(mainSource.dataAgeMs) || (mainSource.updatedAt ? analyzedAt - mainSource.updatedAt : 0));
  const candleAgeMs = Math.max(0, Number(mainSource.candleAgeMs) || (mainSource.lastCandleTime ? analyzedAt - mainSource.lastCandleTime : 0));
  const latencyBlocked = yahooOnly && Number(mainSource.latencyMs) > latencyLimitMs;
  const staleBlocked = !!mainSource.stale || (yahooOnly && dataAgeMs > latencyLimitMs);
  const missingLiveBlocked = !inProgressCandle;
  const freshnessReasons = [];
  if (latencyBlocked) freshnessReasons.push(`par exclusivo Yahoo respondeu em ${(Number(mainSource.latencyMs) / 1000).toFixed(1)}s; limite deste ${tfKey} é ${(latencyLimitMs / 1000).toFixed(1)}s`);
  if (staleBlocked) freshnessReasons.push(`fonte em cache/atrasada há ${(dataAgeMs / 1000).toFixed(1)}s`);
  if (missingLiveBlocked) freshnessReasons.push('a fonte não entregou a vela atual em formação; não é seguro programar a próxima entrada');
  result.dataFreshness = {
    source: mainSource.source || null,
    receivedAt: mainSource.updatedAt || null,
    dataAgeMs, candleAgeMs,
    latencyMs: Number(mainSource.latencyMs) || 0,
    latencyLimitMs,
    yahooOnly,
    cached: !!mainSource.cached,
    stale: !!mainSource.stale, hasLiveCandle: inProgressCandle,
    blocked: latencyBlocked || staleBlocked || missingLiveBlocked,
    reason: freshnessReasons.length ? freshnessReasons.join(' · ') : null
  };
  if (result.dataFreshness.stale) result.warnings.push('Dados em cache: confira a idade mostrada antes de operar.');
  if (main.candles.length < MIN_WARMUP + 30) {
    result.dataError = true;
    result.reasons = [`Histórico insuficiente (${main.candles.length} candles; mínimo ${MIN_WARMUP + 30} para todos os indicadores).`];
    return result;
  }

  onStage('Calculando indicadores e zonas…');
  const poolMax = light ? 500 : Math.min(main.candles.length, Math.max(1200, Number(cfg.poolMax) || 3000));
  // Ao vivo, a última vela disponível é a vela atual. O usuário pode analisar
  // no final dela para projetar a próxima; não devemos descartá-la.
  const candles = main.candles.slice(-poolMax);
  const { snaps } = buildSnapshotPool(candles, main.hasVolume, { zoneLookback: light ? 120 : 160 });
  if (!snaps.length) {
    result.dataError = true;
    result.reasons = ['Não foi possível calcular indicadores com o histórico disponível.'];
    return result;
  }
  const current = snaps[snaps.length - 1];
  result.candleCount = candles.length;
  result.totalCandles = main.candles.length;
  result.hasVolume = main.hasVolume;
  result.candles = candles;
  result.inProgressCandle = inProgressCandle;

  onStage('Analisando timeframes de contexto…');
  for (const tf of tfs) {
    const d = dataByTf[tf];
    if (!d) { result.mtf.push({ tf, dir: 0, isMain: tf === tfKey, unavailable: true }); continue; }
    const currentCtx = d.candles;
    if (currentCtx.length < MIN_WARMUP + 10) { result.mtf.push({ tf, dir: 0, isMain: tf === tfKey, unavailable: true }); continue; }
    let snap;
    if (tf === tfKey) snap = current;
    else {
      const s2 = buildSeries(currentCtx.slice(-400), { hasVolume: d.hasVolume });
      snap = snapshotAt(s2, s2.candles.length - 1, { zoneLookback: 120 });
    }
    if (!snap) { result.mtf.push({ tf, dir: 0, isMain: tf === tfKey, unavailable: true }); continue; }
    result.mtf.push({ tf, dir: tfDirection(snap), isMain: tf === tfKey, snap, regime: snap.structure.label });
  }

  const zoneContexts = [];
  for (const tf of zoneTfs) {
    const d = dataByTf[tf];
    // Reaproveita a mesma resposta de contexto e simplesmente remove a vela
    // em formação. Assim M15/H1 ficam fechados sem dobrar requisições no scan.
    const closed = d && d.candles ? d.candles.filter(k => !k.live) : [];
    if (!d || closed.length < MIN_WARMUP + 10) continue;
    const s2 = buildSeries(closed.slice(-400), { hasVolume: d.hasVolume });
    const snap = snapshotAt(s2, s2.candles.length - 1, { zoneLookback: 160 });
    if (snap) zoneContexts.push({ tf, dir: tfDirection(snap), snap, closedOnly: true });
  }

  let newsCalendar = null;
  if ((asset.group === 'Forex' || cfg.newsApplyCryptoUsd === true) && cfg.newsFilter !== false) {
    onStage('Conferindo calendário econômico…');
    newsCalendar = await highImpactCalendar(Date.now(), opts.calendarSnapshot || null);
    result.calendar = {
      source: newsCalendar.source || null, fetchedAt: newsCalendar.at || null,
      status: newsCalendar.events ? (newsCalendar.stale ? 'stale' : 'ready') : 'unavailable', error: newsCalendar.error || null,
      eventCount: Array.isArray(newsCalendar.events) ? newsCalendar.events.length : 0
    };
    if (Array.isArray(newsCalendar.events)) result.calendarSnapshot = {
      at: newsCalendar.at, events: newsCalendar.events, source: newsCalendar.source || null,
      stale: !!newsCalendar.stale
    };
  }

  onStage('Comparando com situações históricas…');
  // Em M1, a coleta de contextos/calendário pode atravessar a virada da vela.
  // Revalida o relógio antes de gerar qualquer entrada para não analisar uma
  // vela recém-fechada como se ainda estivesse em formação.
  const stillCurrent = !!(current.candle && current.candle.live && current.t + TIMEFRAMES[tfKey].sec * 1000 > Date.now());
  if (!stillCurrent) {
    result.inProgressCandle = false;
    result.dataFreshness.hasLiveCandle = false;
    result.dataFreshness.blocked = true;
    result.dataFreshness.reason = [result.dataFreshness.reason, 'a vela virou durante a análise; atualize para usar a nova vela atual'].filter(Boolean).join(' · ');
    result.warnings.push('A vela mudou durante o cálculo; a direção foi mantida com avaliação baixa até a próxima atualização.');
  }
  const entryWindow = candleWindow(TIMEFRAMES[tfKey].sec, Date.now());
  const evaluated = evaluateBar(current, result.mtf, snaps.slice(0, -1), {
    cfg, model, setupRanking, setupRankings, brokerDivergence, dataFreshness: result.dataFreshness,
    asset, assetId: asset.id, tfKey, tfSec: TIMEFRAMES[tfKey].sec, entryAt: entryWindow.open, zoneContexts, newsCalendar, maxNeighbors: light ? 150 : 400
  });
  Object.assign(result, evaluated);
  result.snapshot = current;
  result.probability = evaluated.hist;
  result.verdict = evaluated.verdict;
  result.confluence = evaluated.score.confluence;
  result.why = whyBullets({ score: evaluated.score, decision: evaluated.decision, cond: evaluated.cond, snap: current, mtf: result.mtf });
  result.candleWindow = { ...entryWindow, open: evaluated.expiry.entryAt, close: evaluated.expiry.expiresAt, expiryCandles: evaluated.expiry.candles };
  result.explanation = explain(result, cfg);
  result.minScoreUsed = evaluated.minScoreUsed;
  return result;
}

/** Explicação em português, montada só a partir do que realmente decidiu. */
export function explain(r, cfg) {
  const s = r.snapshot, sc = r.score, d = r.decision, cond = r.cond;
  if (!s || !sc) return 'Sem dados suficientes para explicar a análise.';
  const p = [];
  p.push(`No ${r.tfKey} de ${r.asset.name}, o preço no momento da análise foi ${fmtPrice(s.price)}; a condição de mercado é ${cond.label.toLowerCase()} (${cond.notes.join(' · ')}).`);
  const cats = sc.categories.slice().sort((a, b) => Math.abs(b.bias * b.weight) - Math.abs(a.bias * a.weight));
  p.push(`Categorias (0–100, 50 = neutro): ${cats.map(c => `${c.label} ${c.sub}`).join(' · ')} → viés final ${sc.bias100}/100 e score técnico ${sc.score}/100 (escala B0=${sc.scale.B0} B1=${sc.scale.B1}, penalidades −${sc.penaltyTotal}).`);
  p.push(`Confluência multi-timeframe: ${sc.confluence.text} (${r.mtf.map(m => `${m.tf} ${m.unavailable ? 'n/d' : m.dir > 0 ? 'alta' : m.dir < 0 ? 'baixa' : 'neutro'}`).join(', ')}).`);
  if (s.priceAction) p.push(s.priceAction.summary);
  const expText = r.expiry ? `${r.expiry.candles} vela${r.expiry.candles > 1 ? 's' : ''}` : '1 vela';
  if (r.hist.insufficient) p.push(`Análogos históricos para ${expText}: ${r.hist.text} — ${INSUFFICIENT}`);
  else p.push(`Análogos históricos para ${expText}: em ${r.hist.samples} situações semelhantes, o fechamento da expiração terminou em alta ${r.hist.up} vezes, em baixa ${r.hist.down} e empatado ${r.hist.ties || 0} vezes (taxa histórica de alta ${(r.hist.pUp * 100).toFixed(1)}%, IC95% ${(r.hist.ciLow * 100).toFixed(1)}–${(r.hist.ciHigh * 100).toFixed(1)}%).`);
  if (r.ml && r.ml.p !== null) p.push(`Modelo calibrado: ${(r.ml.p * 100).toFixed(1)}% de chance de alta${r.ml.usable ? ' (validado: participa da decisão)' : ` (não validado: ${r.ml.gateReason || 'travas de validação não atendidas'} — não participa)`}.`);
  if (d.estimate.p !== null) p.push(`Expectativa matemática líquida com payout ${(d.payout * 100).toFixed(0)}%, aposta de R$ ${d.stake} e custo de R$ ${d.operationCost.toFixed(2)}: ${d.ev >= 0 ? '+' : ''}R$ ${d.ev.toFixed(3)} por operação (vitória na direção = ${(d.estimate.p * 100).toFixed(1)}%, empate = ${(Math.max(0, Number(d.estimate.tieP) || 0) * 100).toFixed(1)}%, ${d.tiePolicy === 'refund' ? 'empate reembolsado' : d.tiePolicy === 'win' ? 'empate contado como acerto' : 'empate contado como perda'}; ${d.estimate.source}, N = ${d.estimate.samples || '—'}; equilíbrio em ${(d.breakEven * 100).toFixed(1)}%).`);
  else p.push(`${INSUFFICIENT} A decisão usou score técnico e travas de risco, sem estimativa de probabilidade.`);
  if (r.dataFreshness) {
    const f = r.dataFreshness;
    p.push(`Dados: recebidos há ${(f.dataAgeMs / 1000).toFixed(1)}s, latência de ${(f.latencyMs / 1000).toFixed(2)}s${f.yahooOnly ? ` (par exclusivo Yahoo; limite ${(f.latencyLimitMs / 1000).toFixed(1)}s)` : ''}${f.blocked ? ' — direção mantida com avaliação baixa pelo atraso.' : '.'}`);
  }
  if (!s.volume.available) p.push('A fonte deste ativo não fornece volume real: o fator volume foi neutralizado.');
  if (r.expiry) p.push(`Expiração sugerida: ${expText} (${r.expiry.reason}). A leitura usa a vela atual quando disponível; o histórico/backtest usa velas fechadas, portanto não é uma réplica intrabar exata.`);
  if (r.filters) p.push(`Filtros de qualidade: ${Object.values(r.filters).filter(Boolean).map(f => f.text).join(' · ')}.`);
  const displayedVerdict = sc.direction > 0 ? 'CALL' : sc.direction < 0 ? 'PUT' : 'AGUARDAR';
  if (r.verdict === 'AGUARDAR' && displayedVerdict !== 'AGUARDAR') p.push(`Conclusão: ${displayedVerdict} com avaliação baixa — ${(d.reasons.length ? d.reasons : ['confirmações insuficientes']).join('; ')}.`);
  else if (r.verdict === 'AGUARDAR') p.push('Conclusão: AGUARDAR — as categorias não definiram direção técnica.');
  else p.push(`Conclusão: ${r.verdict} para expiração de ${expText} em ${r.tfKey}, nota de setup ${r.grade.grade}. É leitura técnica e estatística, não garantia — confirme ativo, preço e horário na corretora.`);
  return p.join(' ');
}

export function shortReason(r) {
  if (r.dataError) return 'fonte indisponível';
  if (r.verdict !== 'AGUARDAR' || r.score && r.score.direction) {
    const c = r.score.categories.slice().sort((a, b) => Math.abs(b.bias * b.weight) - Math.abs(a.bias * a.weight))[0];
    return `${r.cond.label.toLowerCase()}; ${c ? c.label.toLowerCase() + ' ' + c.sub : ''}`;
  }
  return (r.decision && r.decision.reasons[0] ? r.decision.reasons[0] : 'sem confluência').slice(0, 80);
}
