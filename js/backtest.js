// backtest.js — backtest ESTRITAMENTE CAUSAL + diagnóstico de calibração + varredura de limiares
// + simulação de payout/banca. Features vêm de candles ≤ t; o resultado vem SEMPRE da vela t+1.
import { getCandles, resample, DEPTH_TARGET } from './data.js';
import { buildSnapshotPool, evaluateBar, DEFAULT_SETTINGS, thresholdScope, filterPolicySignature } from './analyze.js';
import { tfDirection } from './score.js';
import { TIMEFRAMES, MTF_MAP } from './assets.js';
import { buildSeries, snapshotAt } from './features.js';
import { rankSetups } from './setups.js';
import { breakEvenRate, expectancy, tieNet, normalizeTiePolicy } from './decision.js';
import { historicalProbability } from './probability.js';
import { loadCausalCalendarReplay } from './cloud-api.js';

function frozenConfig(settings) {
  const cfg = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  // Um modelo local normalmente foi treinado com o histórico disponível hoje.
  // Reutilizá-lo em todo o passado faria o backtest enxergar dados futuros.
  // Até existir um treino rolling/purged por janela, o replay mede somente as
  // regras causais não-ML; o modelo continua restrito ao sinal ao vivo.
  cfg.useMl = false;
  cfg.weights = Object.freeze({ ...(DEFAULT_SETTINGS.weights || {}), ...(cfg.weights || {}) });
  cfg.toggles = Object.freeze({ ...(DEFAULT_SETTINGS.toggles || {}), ...(cfg.toggles || {}) });
  return Object.freeze(cfg);
}

function latestClosedContext(source, evaluatedAt) {
  let lo = 0;
  let hi = source.snaps.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (source.snaps[mid].t + source.sec * 1000 <= evaluatedAt) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const snap = source.snaps[found];
  if (!source.dirCache.has(snap.t)) source.dirCache.set(snap.t, tfDirection(snap));
  return { tf: source.tf, dir: source.dirCache.get(snap.t), snap };
}

/**
 * Fase cara e independente dos pesos. Candles, indicadores, snapshots e
 * contextos multi-timeframe são construídos uma vez e reutilizados por todos
 * os candidatos. O objeto superior e suas coleções de contexto são congelados
 * para impedir que um replay contamine o seguinte.
 */
export async function buildReplayContext(asset, tfKey, settings, {
  hourFilter = null,
  maxTests = 600,
  onProgress = () => {},
  dataOverride = null,
  lowerZoneDataOverride = null,
  precomputeHistorical = false,
  historicalCalendarOverride = null,
} = {}) {
  const cfg = frozenConfig(settings);
  // Agenda atual não pode ser projetada para o passado. Isso só invalida a
  // transferência de limiar quando a regra de notícias realmente se aplica ao
  // ativo analisado; cripto sem filtro USD permanece calibrável.
  const newsHistoryRequired = cfg.newsFilter !== false && (asset.group === 'Forex' || cfg.newsApplyCryptoUsd === true);
  onProgress(0.02, 'Buscando histórico profundo…');
  const target = Math.max(1500, Number(cfg.deepCandles) || DEPTH_TARGET.deep);
  const d = dataOverride || await getCandles(asset, tfKey, { depth: 'deep', target });
  if (!d || d.candles.length < 400) throw new Error('histórico insuficiente para backtest (' + (d ? d.candles.length : 0) + ' candles)');

  onProgress(0.10, `Calculando indicadores em ${d.candles.length} candles…`);
  const candles = d.candles;
  const { snaps } = buildSnapshotPool(candles, d.hasVolume, { zoneLookback: 160 });
  if (snaps.length < 120) throw new Error('poucos pontos calculáveis para backtest');

  // ---- contexto multi-timeframe CAUSAL: TFs superiores reamostrados do mesmo histórico,
  // usando apenas a última vela do TF superior JÁ FECHADA em cada instante.
  const tfSec = TIMEFRAMES[tfKey].sec;
  // M15/H1 entram também como contextos de zona, quando podem ser reconstruídos
  // causalmente a partir do timeframe principal. Nunca se fabrica um TF menor.
  const ladder = [...new Set([...(MTF_MAP[tfKey] || [tfKey]), 'M15', 'H1'])]
    .filter(tf => tf !== tfKey && TIMEFRAMES[tf].sec > tfSec);
  const higher = [];
  for (const tf of ladder) {
    const hSec = TIMEFRAMES[tf].sec;
    const hc = resample(candles, hSec);
    if (hc.length < 240) continue;
    const series = buildSeries(hc, { hasVolume: d.hasVolume });
    const hsnaps = [];
    for (let i = 210; i < hc.length; i++) { const s = snapshotAt(series, i, { zoneLookback: 120 }); if (s) hsnaps.push(s); }
    if (hsnaps.length < 10) continue;
    higher.push({ tf, sec: hSec, snaps: hsnaps, dirCache: new Map() });
  }

  // Para H1/H4, M15/H1 podem ser timeframes MENORES e não podem ser fabricados
  // por reamostragem. Buscamos candles fechados e os liberamos apenas depois do
  // fechamento correspondente. Se faltar cobertura, a trava de zona bloqueia o
  // trecho em vez de inventar um contexto.
  const lowerZoneSources = [];
  for (const zoneTf of ['M15', 'H1']) {
    const zoneSec = TIMEFRAMES[zoneTf].sec;
    if (zoneTf === tfKey || zoneSec >= tfSec) continue;
    try {
      const override = lowerZoneDataOverride && lowerZoneDataOverride[zoneTf];
      const zd = override || await getCandles(asset, zoneTf, { depth: 'deep', target, includeLive: false });
      if (!zd || !zd.candles || zd.candles.length < 240) continue;
      const zoneSeries = buildSeries(zd.candles, { hasVolume: zd.hasVolume });
      const zoneSnaps = [];
      for (let i = 210; i < zd.candles.length; i++) {
        const zoneSnap = snapshotAt(zoneSeries, i, { zoneLookback: 160 });
        if (zoneSnap) zoneSnaps.push(zoneSnap);
      }
      if (zoneSnaps.length) lowerZoneSources.push({ tf: zoneTf, sec: zoneSec, snaps: zoneSnaps, dirCache: new Map(), source: zd.source });
    } catch (_) {
      // A indisponibilidade aparece explicitamente como contexto ausente.
    }
  }
  const lowerTf = (MTF_MAP[tfKey] || []).find(tf => TIMEFRAMES[tf].sec < tfSec) || null;
  const startIdx = Math.max(60, snaps.length - maxTests);
  const historicalMaxNeighbors = 250;
  const historicalByIndex = new Array(snaps.length).fill(null);
  if (precomputeHistorical) {
    onProgress(0.105, 'Pré-calculando analogias históricas E1/E2/E3…');
    for (let n = startIdx; n < snaps.length - 1; n++) {
      const past = snaps.slice(0, n);
      historicalByIndex[n] = Object.freeze(Object.fromEntries([1, 2, 3].map(horizon => [
        horizon,
        historicalProbability(past, snaps[n], {
          minSamples: cfg.minSamples,
          maxDistance: cfg.maxDistance,
          maxNeighbors: historicalMaxNeighbors,
          horizon,
        })
      ])));
    }
  }
  const contexts = snaps.map(snap => {
    const evaluatedAt = snap.t + tfSec * 1000;
    const higherMtf = higher.map(source => {
      const found = latestClosedContext(source, evaluatedAt);
      return found || { tf: source.tf, dir: 0, unavailable: true };
    });
    const lowerZones = lowerZoneSources.map(source => {
      const found = latestClosedContext(source, evaluatedAt);
      return found ? { ...found, closedOnly: true, source: source.source } : null;
    }).filter(Boolean);
    return Object.freeze({ evaluatedAt, higherMtf: Object.freeze(higherMtf), lowerZones: Object.freeze(lowerZones) });
  });
  const replayTimes = snaps.slice(startIdx, -1).map(snap => snap.t);

  // O replay consulta a fotografia completa que já era conhecida no instante
  // de cada decisão. A política só é reproduzida quando TODOS os pontos têm
  // cobertura; misturar trechos com e sem calendário mudaria silenciosamente
  // a população usada na calibração.
  const calendarByIndex = new Array(snaps.length).fill(null);
  let calendarCoverage = Object.freeze({
    required: newsHistoryRequired,
    requested: 0,
    covered: 0,
    ratio: newsHistoryRequired ? 0 : null,
    sufficient: !newsHistoryRequired,
    source: newsHistoryRequired ? 'unavailable' : 'not-applicable',
    errors: Object.freeze([]),
  });
  if (newsHistoryRequired) {
    const beforeMs = Math.max(0, Number(cfg.newsBlockBeforeMin ?? 5)) * 60_000;
    const afterMs = Math.max(0, Number(cfg.newsBlockAfterMin ?? 5)) * 60_000;
    const points = [];
    for (let n = startIdx; n < snaps.length - 1; n++) {
      const snap = snaps[n];
      const entry = candles[snap.i + 1];
      if (!entry) continue;
      points.push({
        key: String(n),
        knownAt: contexts[n].evaluatedAt,
        from: entry.t - beforeMs,
        to: entry.t + 3 * tfSec * 1000 + afterMs,
      });
    }
    onProgress(0.108, 'Reconstruindo calendário econômico causal…');
    let loaded;
    try {
      loaded = typeof historicalCalendarOverride === 'function'
        ? await historicalCalendarOverride(points)
        : historicalCalendarOverride || await loadCausalCalendarReplay(points);
    } catch (error) {
      loaded = { requested: points.length, covered: 0, snapshots: [], errors: [error && error.message || String(error)] };
    }
    const snapshots = Array.isArray(loaded && loaded.snapshots) ? loaded.snapshots : [];
    const byKey = new Map(snapshots.map(snapshot => [String(snapshot && snapshot.key), snapshot]));
    let covered = 0;
    for (const point of points) {
      const snapshot = byKey.get(point.key);
      if (!snapshot || snapshot.status !== 'ready' || !Number.isFinite(Number(snapshot.fetchedAt)) || !Array.isArray(snapshot.events)) continue;
      const index = Number(point.key);
      calendarByIndex[index] = Object.freeze({
        at: Number(snapshot.fetchedAt),
        events: Object.freeze(snapshot.events.map(event => Object.freeze({ ...event }))),
        source: snapshot.source || 'arquivo causal',
        stale: false,
        historical: true,
      });
      covered++;
    }
    const requested = points.length;
    const sufficient = requested > 0 && covered === requested;
    if (!sufficient) calendarByIndex.fill(null);
    calendarCoverage = Object.freeze({
      required: true,
      requested,
      covered,
      ratio: requested ? covered / requested : 0,
      sufficient,
      source: sufficient ? 'arquivo causal versionado' : 'cobertura histórica incompleta',
      errors: Object.freeze(Array.isArray(loaded && loaded.errors) ? [...loaded.errors] : []),
    });
  }
  const historicalNewsUnavailable = newsHistoryRequired && !calendarCoverage.sufficient;

  return Object.freeze({
    asset,
    tfKey,
    tfSec,
    target,
    data: d,
    candles: Object.freeze([...candles]),
    snaps: Object.freeze([...snaps]),
    contexts: Object.freeze(contexts),
    startIdx,
    replayTimes: Object.freeze(replayTimes),
    baseCfg: cfg,
    defaultHourFilter: hourFilter,
    historicalNewsUnavailable,
    calendarByIndex: Object.freeze(calendarByIndex),
    calendarCoverage,
    historicalByIndex: Object.freeze(historicalByIndex),
    historicalConfig: Object.freeze({
      precomputed: !!precomputeHistorical,
      minSamples: cfg.minSamples,
      maxDistance: cfg.maxDistance,
      maxNeighbors: historicalMaxNeighbors,
    }),
    higherTfs: Object.freeze(higher.map(source => source.tf)),
    lowerTf,
    lowerZoneContextTfs: Object.freeze(lowerZoneSources.map(source => source.tf)),
  });
}

/**
 * Fase barata e dependente da configuração. Nenhum indicador é recalculado.
 * startT/endT permitem avaliar janelas independentes sem abrir o holdout final.
 */
export function replayWithConfig(context, candidateCfg = {}, {
  hourFilter = context.defaultHourFilter,
  startT = null,
  endT = null,
  onProgress = () => {},
  model = null,
  includeSummary = true,
} = {}) {
  const cfg = frozenConfig({
    ...context.baseCfg,
    ...candidateCfg,
    weights: { ...(context.baseCfg.weights || {}), ...(candidateCfg.weights || {}) },
    toggles: { ...(context.baseCfg.toggles || {}), ...(candidateCfg.toggles || {}) },
  });
  const { asset, tfKey, tfSec, candles, snaps, data: d } = context;
  const newsHistoryRequired = cfg.newsFilter !== false && (asset.group === 'Forex' || cfg.newsApplyCryptoUsd === true);
  const historicalNewsUnavailable = newsHistoryRequired && !(
    context.calendarCoverage && context.calendarCoverage.required && context.calendarCoverage.sufficient
  );
  const bars = [];
  // Cada expiração tem ranking próprio. E1/E2/E3 nunca compartilham acertos.
  const resolvedByExpiry = { 1: [], 2: [], 3: [] };
  const pendingResolved = [];
  const rankings = {};
  const total = snaps.length - 1 - context.startIdx;

  for (let n = context.startIdx; n < snaps.length - 1; n++) {
    const snap = snaps[n];
    if (startT !== null && Number.isFinite(Number(startT)) && snap.t < Number(startT)) continue;
    if (endT !== null && Number.isFinite(Number(endT)) && snap.t > Number(endT)) break;
    const hour = new Date(snap.t).getHours();
    if (hourFilter && hourFilter.length && !hourFilter.includes(hour)) continue;

    // O motor toma a decisão no fechamento da vela principal, não na abertura.
    // Contextos fechados até este instante são causais e menos defasados.
    const evaluatedAt = context.contexts[n].evaluatedAt;
    const mtf = [{ tf: tfKey, dir: tfDirection(snap), isMain: true }].concat(context.contexts[n].higherMtf);
    if (context.lowerTf) mtf.unshift({ tf: context.lowerTf, dir: 0, unavailable: true }); // TF menor não é reconstruível do TF maior — marcado como n/d
    const past = snaps.slice(0, n);

    // Só ativa resultado depois do FECHAMENTO da expiração no relógio simulado.
    // Sem isso, E2/E3 contaminariam o ranking de candles intermediários.
    let rankingDirty = false;
    for (let idx = pendingResolved.length - 1; idx >= 0; idx--) {
      const pending = pendingResolved[idx];
      if (pending.availableAtI <= snap.i) {
        resolvedByExpiry[pending.expiryCandles].push(pending.record);
        pendingResolved.splice(idx, 1);
        rankingDirty = true;
      }
    }

    // Rankings walk-forward: somente sinais JÁ resolvidos antes de t e separados por E1/E2/E3.
    if (rankingDirty || (n - context.startIdx) % 25 === 0 || !Object.keys(rankings).length) {
      for (const horizon of [1, 2, 3]) {
        const resolved = resolvedByExpiry[horizon];
        const scope = thresholdScope(asset.id, tfKey, horizon);
        if (resolved.length) rankings[scope] = rankSetups(resolved, {
          minSamples: cfg.minSetupSamples,
            payout: (cfg.payout || 85) / 100,
            stake: Number(cfg.stake) || 5,
            operationCost: Math.max(0, Number(cfg.operationCost) || 0), tiePolicy: cfg.tiePolicy
        });
        else delete rankings[scope];
      }
    }

    const futureEntry = candles[snap.i + 1];
    const zoneContexts = mtf.filter(m => m.tf === 'M15' || m.tf === 'H1');
    // Quando o próprio timeframe principal é M15/H1, ele já é uma vela fechada
    // no replay e pode servir como contexto de zona (sem inventar TF menor).
    if ((tfKey === 'M15' || tfKey === 'H1') && !zoneContexts.some(m => m.tf === tfKey)) {
      zoneContexts.push({ tf: tfKey, dir: tfDirection(snap), snap, closedOnly: true });
    }
    for (const zoneContext of context.contexts[n].lowerZones) {
      if (!zoneContexts.some(item => item.tf === zoneContext.tf)) zoneContexts.push(zoneContext);
    }
    // Registra a cobertura do contexto ANTES de rodar a trava. Assim a
    // calibração não pode se declarar válida depois de ter avaliado apenas o
    // pedaço recente do histórico onde M15/H1 estavam disponíveis.
    const zoneContextAvailable = zoneContexts.some(context =>
      context && context.snap && (context.tf === 'M15' || context.tf === 'H1')
    );
    const zoneContextTfs = zoneContexts
      .filter(context => context && context.snap && (context.tf === 'M15' || context.tf === 'H1'))
      .map(context => context.tf);
    const ev = evaluateBar(snap, mtf, past, {
      cfg, model, setupRankings: rankings, maxNeighbors: 250,
      asset, assetId: asset.id, tfKey, tfSec, zoneContexts,
      entryAt: futureEntry ? futureEntry.t : snap.t + tfSec * 1000,
      historicalNewsUnavailable, now: evaluatedAt,
      newsCalendar: historicalNewsUnavailable ? null : context.calendarByIndex[n],
      historicalByHorizon: context.historicalConfig.precomputed
        && Number(cfg.minSamples) === Number(context.historicalConfig.minSamples)
        && Number(cfg.maxDistance) === Number(context.historicalConfig.maxDistance)
        ? context.historicalByIndex[n]
        : null
    });
    const dir = ev.score.direction;
    const expiryCandles = ev.expiry.candles;
    const target = candles[snap.i + expiryCandles];
    if (!futureEntry || !target) continue;
    const futureDir = Math.sign(target.c - futureEntry.o);
    const hit = dir !== 0 && ((dir > 0 && futureDir > 0) || (dir < 0 && futureDir < 0));
    const doji = futureDir === 0;
    const bar = {
      t: snap.t, hour, price: snap.price, dir,
      verdict: ev.verdict, score: ev.score.score, bias: ev.score.bias, bias100: ev.score.bias100,
      grade: ev.grade.grade, condition: ev.cond.label, blocked: !!ev.decision.blocked,
      eligibleWithoutScore: !!ev.decision.eligibleWithoutScore,
      confluence: ev.score.confluence.text, penalties: ev.score.penaltyTotal,
      prob: ev.decision.estimate.p === null ? null : ev.decision.estimate.p * 100,
      probSource: ev.decision.estimate.source, probSamples: ev.decision.estimate.samples,
      histRate: ev.hist.insufficient ? null : (dir > 0 ? ev.hist.pUp : ev.hist.pDown) * 100,
      histSamples: ev.hist.samples,
      setupId: ev.fingerprint ? ev.fingerprint.id : null,
      setupLabel: ev.fingerprint ? ev.fingerprint.label : null,
      expiryCandles, expiryReason: ev.expiry.reason, entryAt: futureEntry.t, entryPrice: futureEntry.o, expiresAt: target.t + tfSec * 1000,
      nextDir: futureDir, changePct: ((target.c - futureEntry.o) / futureEntry.o) * 100,
      wickBlocked: !!(ev.filters && ev.filters.wick && ev.filters.wick.blocked),
      htfZoneBlocked: !!(ev.filters && ev.filters.htfZone && ev.filters.htfZone.blocked),
      zoneContextAvailable,
      zoneContextTfs,
      vsaBlocked: !!(ev.filters && ev.filters.vsa && ev.filters.vsa.blocked),
      newsBlocked: !!(ev.filters && ev.filters.news && ev.filters.news.blocked),
      sessionBlocked: !!(ev.filters && ev.filters.session && ev.filters.session.blocked),
      filterReasons: Object.fromEntries(Object.entries(ev.filters || {}).map(([key, value]) => [key, value && value.text])),
      newsHistoricalUnavailable: historicalNewsUnavailable,
      newsSnapshotAt: context.calendarByIndex[n] ? context.calendarByIndex[n].at : null,
      result: dir === 0 ? null : (doji ? 'NEUTRO' : (hit ? 'ACERTO' : 'ERRO')),
      signal: dir > 0 ? 'CALL' : dir < 0 ? 'PUT' : null
    };
    bars.push(bar);
    if (bar.verdict !== 'AGUARDAR' && bar.result) {
      pendingResolved.push({
        expiryCandles,
        // O snapshot do alvo representa a vela de expiração já fechada.
        availableAtI: snap.i + expiryCandles,
        record: { setupId: bar.setupId, setupLabel: bar.setupLabel, signal: bar.signal, result: bar.result }
      });
    }

    if ((n - context.startIdx) % 10 === 0) {
      onProgress(0.12 + 0.8 * (n - context.startIdx) / Math.max(1, total), `Avaliando vela ${n - context.startIdx + 1} de ${total}…`);
    }
  }

  onProgress(0.95, 'Consolidando estatísticas…');
  const payout = (Number(cfg.payout) || 85) / 100;
  const distribution = distribute(bars);
  const signals = bars.filter(b => b.verdict !== 'AGUARDAR');
  const operationCost = Math.max(0, Number(cfg.operationCost) || 0);
  // A trava M15/H1 é uma parte da população de sinais. Para H4 (em especial
  // quando a fonte limita o histórico de M15/H1), não aceitamos transferir um
  // limiar que tenha sido medido apenas no trecho com contexto disponível.
  // A base são barras direcionais com futuro observável; barras neutras não
  // precisariam de zona para uma entrada e não diluem artificialmente a taxa.
  const zoneCoverageRequired = cfg.higherTfZoneFilter !== false && cfg.higherTfRequireContext !== false;
  const zoneCoverageEligible = bars.filter(bar => bar.dir !== 0);
  const zoneCoverageCovered = zoneCoverageEligible.filter(bar => bar.zoneContextAvailable).length;
  const zoneCoverageRatio = zoneCoverageEligible.length ? zoneCoverageCovered / zoneCoverageEligible.length : null;
  const zoneCoverage = {
    required: zoneCoverageRequired,
    basis: 'barras direcionais com resultado observável',
    eligible: zoneCoverageEligible.length,
    covered: zoneCoverageCovered,
    ratio: zoneCoverageRatio,
    minimum: 0.95,
    sufficient: !zoneCoverageRequired || (zoneCoverageRatio !== null && zoneCoverageRatio >= 0.95)
  };
  const meta = {
    asset, tfKey, source: d.source, candles: candles.length, evaluated: bars.length,
    from: bars.length ? bars[0].t : null, to: bars.length ? bars[bars.length - 1].t : null,
    cfg: { ...cfg }, hasVolume: d.hasVolume, aggregatedFrom: d.aggregatedFrom,
    contextTfs: [...context.higherTfs], lowerTfUnavailable: context.lowerTf, lowerZoneContextTfs: [...context.lowerZoneContextTfs],
    zoneCoverage,
    newsCoverage: context.calendarCoverage,
    filterPolicySignature: filterPolicySignature(cfg),
    newsHistoricalUnavailable: historicalNewsUnavailable,
    mlDisabledForCausality: true
  };
  if (!includeSummary) return { bars, signals, meta };
  const stats = summarize(signals, { payout, stake: Number(cfg.stake) || 5, banca: Number(cfg.banca) || 250, operationCost, tiePolicy: cfg.tiePolicy });
  const sweepByExpiry = {};
  const statsByExpiry = {};
  const setupRankingBacktest = {};
  for (const horizon of [1, 2, 3]) {
    const horizonBars = bars.filter(bar => bar.expiryCandles === horizon);
    const horizonSignals = signals.filter(bar => bar.expiryCandles === horizon);
    statsByExpiry[horizon] = summarize(horizonSignals, { payout, stake: Number(cfg.stake) || 5, banca: Number(cfg.banca) || 250, operationCost, tiePolicy: cfg.tiePolicy });
    sweepByExpiry[horizon] = thresholdSweep(horizonBars, {
      payout, stake: Number(cfg.stake) || 5, operationCost, tiePolicy: cfg.tiePolicy,
      minSignals: Math.max(20, Math.round(horizonBars.length * 0.02)),
      // Embargo entre seleção antiga e validação recente: o resultado de uma
      // operação E2/E3 no fim do período antigo não pode cair no holdout.
      purgeBars: horizon
    });
    setupRankingBacktest[thresholdScope(asset.id, tfKey, horizon)] = rankSetups(horizonSignals, {
      minSamples: cfg.minSetupSamples, payout, stake: Number(cfg.stake) || 5, operationCost, tiePolicy: cfg.tiePolicy
    });
  }
  // A UI mantém a visão E1 como resumo principal; as demais expirações ficam
  // explicitamente separadas em sweepByExpiry/statsByExpiry.
  const sweep = sweepByExpiry[1];

  onProgress(1, 'Concluído');
  return {
    bars, signals, distribution, stats, statsByExpiry, sweep, sweepByExpiry, setupRankingBacktest,
    meta
  };
}

/**
 * API histórica preservada: a UI e o scanner continuam chamando runBacktest.
 */
export async function runBacktest(asset, tfKey, settings, opts = {}) {
  const context = await buildReplayContext(asset, tfKey, settings, opts);
  return replayWithConfig(context, {}, opts);
}

/* ------------------------------------------------------- diagnóstico de calibração */
export function distribute(bars) {
  const count = { CALL: 0, PUT: 0, AGUARDAR: 0 };
  const reasons = new Map();
  const byHour = new Map();
  const byGrade = new Map();
  const scores = [];
  for (const b of bars) {
    count[b.verdict] = (count[b.verdict] || 0) + 1;
    scores.push(b.score);
    if (!byHour.has(b.hour)) byHour.set(b.hour, { key: String(b.hour).padStart(2, '0') + 'h', CALL: 0, PUT: 0, AGUARDAR: 0 });
    byHour.get(b.hour)[b.verdict]++;
    byGrade.set(b.grade, (byGrade.get(b.grade) || 0) + 1);
  }
  scores.sort((a, b) => a - b);
  const q = p => scores.length ? scores[Math.floor(p * (scores.length - 1))] : null;
  const n = bars.length || 1;
  return {
    n: bars.length,
    call: count.CALL, put: count.PUT, wait: count.AGUARDAR,
    callPct: count.CALL / n * 100, putPct: count.PUT / n * 100, waitPct: count.AGUARDAR / n * 100,
    scoreMin: q(0), scoreP25: q(0.25), scoreMedian: q(0.5), scoreP75: q(0.75), scoreP90: q(0.9), scoreMax: q(1),
    byHour: [...byHour.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byGrade: [...byGrade.entries()].map(([k, v]) => ({ key: k, total: v, pct: v / n * 100 })).sort((a, b) => a.key.localeCompare(b.key)),
    reasons: [...reasons.entries()]
  };
}

/* ------------------------------------------------------- estatísticas dos sinais */
function outcomeNet(result, payout, stake, cost, tiePolicy) {
  if (result === 'ACERTO') return stake * payout - cost;
  if (result === 'NEUTRO') return tieNet(payout, stake, cost, tiePolicy);
  return -(stake + cost);
}

function streakClass(result, tiePolicy) {
  if (result === 'ACERTO') return 'win';
  if (result === 'ERRO') return 'loss';
  if (normalizeTiePolicy(tiePolicy) === 'win') return 'win';
  if (normalizeTiePolicy(tiePolicy) === 'loss') return 'loss';
  return 'flat';
}

export function summarize(signals, { payout = 0.85, stake = 5, banca = 250, operationCost = 0, tiePolicy = 'loss' } = {}) {
  const safeStake = Math.max(0.000001, Number(stake) || 1);
  const safePayout = Math.max(0, Number(payout) || 0);
  const cost = Math.max(0, Number(operationCost) || 0);
  const policy = normalizeTiePolicy(tiePolicy);
  // Empates não são descartados: entram no denominador da taxa e no EV segundo
  // a regra escolhida para a corretora. Isso evita inflar setups marginalmente positivos.
  const valid = signals.filter(t => ['ACERTO', 'ERRO', 'NEUTRO'].includes(t.result));
  const hits = valid.filter(t => t.result === 'ACERTO').length;
  const ties = valid.filter(t => t.result === 'NEUTRO').length;
  const errs = valid.length - hits - ties;
  const rate = valid.length ? hits / valid.length * 100 : null;
  const p = valid.length ? (hits + 1) / (valid.length + 3) : null;
  const tieP = valid.length ? (ties + 1) / (valid.length + 3) : null;
  const ev = p === null ? null : expectancy(p, safePayout, safeStake, cost, tieP, policy);
  const winNet = safeStake * safePayout - cost;
  const lossNet = -(safeStake + cost);
  const neutralNet = tieNet(safePayout, safeStake, cost, policy);
  const pnls = valid.map(t => outcomeNet(t.result, safePayout, safeStake, cost, policy));
  const grossWin = pnls.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = pnls.filter(value => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null);

  // Curva de banca sem martingale: uma unidade fixa por operação.
  let bal = Number(banca) || 0, peak = bal, maxDD = 0, maxDDpct = 0;
  const equity = [{ t: valid.length ? valid[0].t : Date.now(), bal }];
  let bestWin = 0, bestLoss = 0, cw = 0, cl = 0;
  for (const t of valid) {
    bal += outcomeNet(t.result, safePayout, safeStake, cost, policy);
    const cls = streakClass(t.result, policy);
    if (cls === 'win') { cw++; cl = 0; }
    else if (cls === 'loss') { cl++; cw = 0; }
    else { cw = 0; cl = 0; }
    bestWin = Math.max(bestWin, cw); bestLoss = Math.max(bestLoss, cl);
    peak = Math.max(peak, bal);
    maxDD = Math.max(maxDD, peak - bal);
    maxDDpct = Math.max(maxDDpct, peak > 0 ? (peak - bal) / peak * 100 : 0);
    equity.push({ t: t.t, bal });
  }

  const byKey = (keyFn) => {
    const m = new Map();
    for (const t of valid) {
      const k = keyFn(t);
      if (!m.has(k)) m.set(k, { key: k, total: 0, hits: 0, ties: 0 });
      const o = m.get(k); o.total++;
      if (t.result === 'ACERTO') o.hits++;
      if (t.result === 'NEUTRO') o.ties++;
    }
    return [...m.values()].map(o => {
      const r = o.total ? o.hits / o.total * 100 : null;
      const pp = (o.hits + 1) / (o.total + 3);
      const tp = (o.ties + 1) / (o.total + 3);
      return { ...o, errs: o.total - o.hits - o.ties, rate: r, tieRate: o.total ? o.ties / o.total * 100 : null, ev: expectancy(pp, safePayout, safeStake, cost, tp, policy) };
    }).sort((a, b) => String(a.key).localeCompare(String(b.key), 'pt-BR', { numeric: true }));
  };
  const band = t => t.score >= 85 ? '85-100' : t.score >= 75 ? '75-84' : t.score >= 65 ? '65-74' : t.score >= 58 ? '58-64' : '<58';

  return {
    total: signals.length, valid: valid.length, neutros: ties,
    hits, ties, errs, rate, tieRate: valid.length ? ties / valid.length * 100 : null, profitFactor, ev, evPerReal: ev === null ? null : ev / safeStake,
    breakEven: breakEvenRate(safePayout, safeStake, cost, tieP || 0, policy) * 100, payout: safePayout, stake: safeStake, operationCost: cost, banca: Number(banca) || 0, tiePolicy: policy,
    winNet, tieNet: neutralNet, lossNet,
    finalBalance: bal, net: bal - (Number(banca) || 0), maxDD, maxDDpct, equity,
    bestWin, bestLoss,
    call: { total: valid.filter(t => t.signal === 'CALL').length, hits: valid.filter(t => t.signal === 'CALL' && t.result === 'ACERTO').length, ties: valid.filter(t => t.signal === 'CALL' && t.result === 'NEUTRO').length },
    put: { total: valid.filter(t => t.signal === 'PUT').length, hits: valid.filter(t => t.signal === 'PUT' && t.result === 'ACERTO').length, ties: valid.filter(t => t.signal === 'PUT' && t.result === 'NEUTRO').length },
    byHour: byKey(t => String(t.hour).padStart(2, '0') + 'h'),
    byScore: byKey(band),
    byGrade: byKey(t => t.grade),
    byCondition: byKey(t => t.condition)
  };
}

/* ------------------------------------------------------- varredura de limiares */
/**
 * Para cada limiar de score (e opcionalmente de probabilidade), mede nº de sinais, taxa de acerto,
 * profit factor, drawdown máximo e EXPECTATIVA MATEMÁTICA com o payout configurado.
 *
 * FUNÇÃO OBJETIVO do "MELHOR EQUILÍBRIO": retorno total esperado = EV por sinal × nº de sinais,
 * restrito a nº de sinais ≥ minSignals (amostra mínima para a estatística ter sentido).
 */
export function thresholdSweep(bars, {
  payout = 0.85, stake = 5, operationCost = 0, tiePolicy = 'loss',
  thresholds = [50, 55, 58, 60, 62, 65, 70, 75, 80, 85, 90],
  probThresholds = [0], minSignals = 20, validationFraction = 0.30, purgeBars = 0
} = {}) {
  const cost = Math.max(0, Number(operationCost) || 0);
  const policy = normalizeTiePolicy(tiePolicy);
  if (!Array.isArray(bars) || bars.length < 2) {
    return {
      rows: [], best: null, bestCandidate: null, minSignals: Math.max(20, Math.round(minSignals)),
      minCalibrationSignals: Math.max(20, Math.round(minSignals)), minValidationSignals: Math.max(20, Math.round(minSignals)),
       calibrationCount: 0, validationCount: 0, payout, stake, operationCost: cost, tiePolicy: policy,
      validationFraction: Math.max(0.20, Math.min(0.40, Number(validationFraction) || 0.30)), purgeBars: Math.max(0, Math.round(purgeBars || 0)), embargoCount: 0,
       breakEven: breakEvenRate(payout, stake, cost, 0, policy) * 100,
      objective: 'amostra insuficiente para separar calibração e validação'
    };
  }
  // A escolha é feita na parte antiga. O trecho mais recente fica lacrado para
  // validação fora da amostra; ele não escolhe um segundo "melhor" limiar.
  const safeFraction = Math.max(0.20, Math.min(0.40, Number(validationFraction) || 0.30));
  const cut = Math.max(1, Math.min(bars.length - 1, Math.floor(bars.length * (1 - safeFraction))));
  const safePurge = Math.max(0, Math.min(cut - 1, Math.round(Number(purgeBars) || 0)));
  const calibrationBars = bars.slice(0, Math.max(0, cut - safePurge));
  const validationBars = bars.slice(cut);
  const minCalibrationSignals = Math.max(20, Math.round(minSignals));
  const minValidationSignals = Math.max(20, Math.round(minSignals));

  const measure = (source, thr, pthr, required) => {
    const picked = source.filter(b =>
      b.dir !== 0 && b.eligibleWithoutScore !== false && b.score >= thr &&
      (pthr <= 0 || (b.prob !== null && b.prob >= pthr)) && b.result
    );
    const valid = picked.filter(b => ['ACERTO', 'ERRO', 'NEUTRO'].includes(b.result));
    const hits = valid.filter(b => b.result === 'ACERTO').length;
    const ties = valid.filter(b => b.result === 'NEUTRO').length;
    const errs = valid.length - hits - ties;
    const rate = valid.length ? hits / valid.length * 100 : null;
    const p = valid.length ? (hits + 1) / (valid.length + 3) : null;
    const tieP = valid.length ? (ties + 1) / (valid.length + 3) : null;
    const ev = p === null ? null : expectancy(p, payout, stake, cost, tieP, policy);
    const winNet = stake * payout - cost;
    const lossNet = -(stake + cost);
    const neutralNet = tieNet(payout, stake, cost, policy);
    const pnls = valid.map(b => outcomeNet(b.result, payout, stake, cost, policy));
    const grossWin = pnls.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLoss = pnls.filter(value => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null);
    let net = 0, peak = 0, maxDD = 0;
    for (const b of valid) {
      net += outcomeNet(b.result, payout, stake, cost, policy);
      peak = Math.max(peak, net); maxDD = Math.max(maxDD, peak - net);
    }
    return {
      signals: valid.length, neutros: ties, hits, ties, errs, rate, tieRate: valid.length ? ties / valid.length * 100 : null,
      profitFactor, ev, evPerReal: ev === null ? null : ev / stake,
      totalExpected: ev === null ? null : ev * valid.length, net, maxDD, winNet, neutralNet, lossNet,
      enough: valid.length >= required
    };
  };

  const rows = [];
  for (const thr of thresholds) {
    for (const pthr of probThresholds) {
      const calibration = measure(calibrationBars, thr, pthr, minCalibrationSignals);
      const validation = measure(validationBars, thr, pthr, minValidationSignals);
      // Campos de topo espelham sempre a validação, para não induzir a leitura
      // de desempenho dentro da amostra como se fosse resultado futuro.
      rows.push({
        threshold: thr, probThreshold: pthr, calibration, validation,
        ...validation,
        enoughCalibration: calibration.enough,
        enoughValidation: validation.enough,
        accepted: calibration.enough && calibration.ev > 0 && validation.enough && validation.ev > 0
      });
    }
  }
  const selectionPool = rows.filter(r => r.enoughCalibration && r.calibration.totalExpected !== null && r.calibration.ev > 0);
  const bestCandidate = selectionPool.slice().sort((a, b) => b.calibration.totalExpected - a.calibration.totalExpected)[0] || null;
  // Se a melhor escolha do período antigo falhar no futuro reservado, não
  // procuramos outra depois de ver o futuro: nenhuma configuração é aplicada.
  const best = bestCandidate && bestCandidate.accepted ? bestCandidate : null;
  return {
    rows, best, bestCandidate, minSignals, minCalibrationSignals, minValidationSignals,
    calibrationCount: calibrationBars.length, validationCount: validationBars.length, purgeBars: safePurge, embargoCount: safePurge,
    payout, stake, operationCost: cost, tiePolicy: policy, validationFraction: safeFraction,
    breakEven: breakEvenRate(payout, stake, cost, 0, policy) * 100,
    objective: `limiar escolhido no período antigo (${Math.round((1 - safeFraction) * 100)}%), com embargo de ${safePurge} vela(s), e aceito somente se mantiver EV líquido positivo em pelo menos ${minValidationSignals} sinais do período recente (${Math.round(safeFraction * 100)}%)`
  };
}

/* ------------------------------------------------------- teste de causalidade (sem lookahead) */
/**
 * Recalcula o snapshot do índice i usando SOMENTE candles[0..i] e compara com o snapshot
 * calculado sobre a série completa. Se algum número diferir, existe vazamento de futuro.
 */
export function assertNoLookahead(candles, hasVolume, indices = null) {
  const full = buildSeries(candles, { hasVolume });
  const idxs = indices || [Math.floor(candles.length * 0.5), Math.floor(candles.length * 0.7), candles.length - 5];
  const checks = [];
  for (const i of idxs) {
    if (i < 220 || i >= candles.length) continue;
    const a = snapshotAt(full, i, { zoneLookback: 160 });
    const truncated = buildSeries(candles.slice(0, i + 1), { hasVolume });
    const b = snapshotAt(truncated, i, { zoneLookback: 160 });
    if (!a || !b) { checks.push({ i, ok: false, diff: 'snapshot nulo' }); continue; }
    const fields = ['price', 'atr', 'rsi', 'alignment', 'adx', 'atrPercentile', 'distR', 'distS', 'emaCompression'];
    const diffs = [];
    for (const f of fields) {
      const va = a[f], vb = b[f];
      if (va === null && vb === null) continue;
      if (typeof va === 'number' && typeof vb === 'number') { if (Math.abs(va - vb) > Math.max(1e-9, Math.abs(va) * 1e-9)) diffs.push(`${f}: ${va} ≠ ${vb}`); }
      else if (va !== vb) diffs.push(`${f}: ${va} ≠ ${vb}`);
    }
    const vd = a.vector.map((v, j) => Math.abs(v - b.vector[j]) > 1e-9 ? j : -1).filter(j => j >= 0);
    if (vd.length) diffs.push('vetor difere nos índices ' + vd.join(','));
    const recentA = (a.recentCandles || []).map(k => [k.t, k.o, k.h, k.l, k.c].join(':')).join('|');
    const recentB = (b.recentCandles || []).map(k => [k.t, k.o, k.h, k.l, k.c].join(':')).join('|');
    if (recentA !== recentB) diffs.push('janela de pavios recente difere');

    // Exercita o mesmo motor das travas sem permitir agenda atual no passado.
    // Com o mesmo candle t, pavio, expiração, sessão e a marca de calendário
    // histórico indisponível devem ser idênticos em série cheia e truncada.
    const auditCfg = { ...DEFAULT_SETTINGS, minConfluence: 0, vsaRequireRealVolume: false };
    const auditOpts = { cfg: auditCfg, asset: { id: 'EURUSD', group: 'Forex' }, assetId: 'EURUSD', tfKey: 'M1', tfSec: 60, historicalNewsUnavailable: true };
    const ea = evaluateBar(a, [{ tf: 'M1', dir: tfDirection(a), isMain: true }], [], auditOpts);
    const eb = evaluateBar(b, [{ tf: 'M1', dir: tfDirection(b), isMain: true }], [], auditOpts);
    const guardFields = [
      ['expiração', ea.expiry.candles, eb.expiry.candles],
      ['pavio', ea.filters.wick.aggregateRatio, eb.filters.wick.aggregateRatio],
      ['zona HTF', ea.filters.htfZone.blocked, eb.filters.htfZone.blocked],
      ['VSA', ea.filters.vsa.blocked, eb.filters.vsa.blocked],
      ['sessão', ea.filters.session.blocked, eb.filters.session.blocked],
      ['calendário', ea.filters.news.historicalUnavailable, eb.filters.news.historicalUnavailable]
    ];
    for (const [name, va, vb] of guardFields) {
      if (typeof va === 'number' && typeof vb === 'number') {
        if (Math.abs(va - vb) > 1e-9) diffs.push(`${name} difere`);
      } else if (va !== vb) diffs.push(`${name} difere`);
    }
    checks.push({ i, ok: diffs.length === 0, diff: diffs.join(' | ') });
  }
  return { ok: checks.every(c => c.ok), checks };
}
