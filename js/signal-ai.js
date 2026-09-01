import { allAssets, getAsset, TF_LIST, TIMEFRAMES, universe } from './assets.js';
import { DEFAULT_SETTINGS, MODE_PRESETS, thresholdScope, filterPolicySignature } from './analyze.js';
import { clearCache, getCandles } from './data.js';
import { loadModel as loadLegacyModel, saveModel as saveLegacyModel, normalizeModel, VALIDATION_POLICY_VERSION, FEATURE_SCHEMA_VERSION, MIN_VALIDATION_SAMPLES } from './ml.js';
import { rankSetups } from './setups.js';
import { fmt, fmtPct, fmtPrice, fmtTime, store, escapeHtml, signalLabel, downloadFile } from './util.js';
import { buildSeries } from './features.js';
import { cloudIsConfigured, loadCloudDashboard } from './cloud-api.js';
import { rankedOpportunitySnapshot } from './opportunity-selection.js';
import { latestResolvedRecord, settlePendingRecords, settlementTimes } from './history-settlement.js';
import { isOperationalHistoryEntry, isVisibleGradeHistoryEntry, normalizeOperationalGrade, partitionVisibleGradeHistory } from './history-policy.js';
import {
  initializePersistence, list as listPersisted, STORES,
  getSettings as loadPersistedSettings, saveSettings as savePersistedSettings,
  getModelRegistry as loadPersistedRegistry, saveModelRegistry as savePersistedRegistry,
  getSignalHistory as loadPersistedHistory, saveSignalHistory as savePersistedHistory,
  getFeedback as loadPersistedFeedback, saveFeedback as savePersistedFeedback,
  getFeedbackMeta as loadPersistedFeedbackMeta, saveFeedbackMeta as savePersistedFeedbackMeta,
  saveModel as savePersistedModel, getKv, setKv, saveThresholdCalibration as savePersistedThresholdCalibration
} from './persistence.js';

const SETTINGS_KEY = 'signal_atlas_settings_v1';
const REGISTRY_KEY = 'signal_atlas_models_v1';
const HISTORY_KEY = 'signal_atlas_signal_history_v1';
const FEEDBACK_KEY = 'signal_atlas_feedback_v1';
const FEEDBACK_META_KEY = 'signal_atlas_feedback_meta_v1';
const $ = s => document.querySelector(s);

const defaults = {
  assetId: 'BTCUSDT', tf: 'M5', deepCandles: 10000,
  autoRefresh: true, refreshEvery: 60, autoScan: true, scanEvery: 300,
  scanMarket: 'Ambos', scanCount: 10, mode: 'neutro', scannerListVersion: 2,
  operationCost: 0, tiePolicy: 'loss', thresholds: {}, thresholdCalibrations: {},
  safety: {
    wickFilter: true, wickOppositionRatio: 0.40,
    higherTfZoneFilter: true, higherTfZoneMaxAtr: 1, higherTfMinZoneStrength: 4, higherTfRequireContext: true,
    vsaFilter: true, vsaMinRelativeVolume: 0.8, vsaRequireRealVolume: true, vsaMinCandleProgress: 0.20,
    flexibleExpiry: true, maxExpiryCandles: 3,
    newsFilter: true, newsBlockBeforeMin: 5, newsBlockAfterMin: 5, newsFailClosedForex: true, newsApplyCryptoUsd: false,
    sessionGuard: true, sessionGuardForexOnly: true, sessionBlackoutMinutes: 10
  }
};
const stored = store.get(SETTINGS_KEY, {});
const state = {
  ...defaults, ...stored, result: null, busy: false, analyzing: false, training: false, backtesting: false, scanning: false,
  refreshTimer: null, scanTimer: null, clockTimer: null, candleTrainTimer: null, cloudTimer: null, historyTimer: null, lastCandleBucket: null, candleTrainQueued: false, learningCursor: 0, scannerRows: [],
  initialScanStarted: false, feedbackQueued: new Set(),
  models: {}, modelRegistry: store.get(REGISTRY_KEY, {}), signalHistory: store.get(HISTORY_KEY, []),
  feedback: store.get(FEEDBACK_KEY, []), feedbackMeta: store.get(FEEDBACK_META_KEY, {}),
  setupRankingReal: {}, setupRankingBacktest: {},
  persistenceReady: false, persistenceError: null, workers: {}, workerSequence: 0,
  scannerProgress: { current: 0, total: 0, assetName: '', updatedAt: null, started: false }, scannerPromotedKey: null, calendarSnapshot: null,
  historyResolving: false,
  cloud: { loading: false, snapshot: null, lastAttemptAt: null, focusedId: null }
};
// A interface e o backend usam uma única política daqui em diante. Mantemos
// os campos legados apenas para abrir dados antigos sem reescrever histórico.
state.mode = 'neutro';
state.operationCost = 0;

function baseCfg() {
  const presetKey = 'normal';
  const safety = { ...defaults.safety, ...(state.safety || {}) };
  const modeVsaMinimum = 0.9;
  return {
    ...DEFAULT_SETTINGS, ...MODE_PRESETS.normal, ...safety,
    vsaMinRelativeVolume: Math.max(Number(safety.vsaMinRelativeVolume) || 0.8, modeVsaMinimum), mode: presetKey,
    deepCandles: Number(state.deepCandles), autoRefresh: state.autoRefresh,
    refreshSec: Number(state.refreshEvery), scannerAuto: state.autoScan,
    scannerIntervalSec: Number(state.scanEvery), scannerMarket: state.scanMarket,
    scannerCount: Number(state.scanCount), operationCost: 0, tiePolicy: state.tiePolicy || 'loss'
  };
}

function thresholdsValidForCurrentCost(policy = baseCfg()) {
  const currentCost = 0;
  const signature = filterPolicySignature(policy);
  const out = {};
  for (const [scope, threshold] of Object.entries(state.thresholds || {})) {
    const calibration = state.thresholdCalibrations && state.thresholdCalibrations[scope];
    if (!calibration || !calibration.accepted) continue;
    if (Math.abs((Number(calibration.operationCost) || 0) - currentCost) > 0.000001) continue;
    if (calibration.policySignature !== signature) continue;
    out[scope] = threshold;
  }
  return out;
}

function cfg() {
  const base = baseCfg();
  return {
    ...base, thresholds: thresholdsValidForCurrentCost(base), useMl: true
  };
}
function modelKey(assetId, tf) { return `${assetId}|${tf}`; }
function setupScope(assetId, tf, expiryCandles = 1) { return thresholdScope(assetId, tf, expiryCandles); }

// Ranking usado no sinal: exclusivamente sinais publicados prospectivamente
// pela análise ou pelo scanner e resolvidos depois. Backtests ficam separados.
function refreshSetupRankingReal(assetId, tf, expiryCandles = 1) {
  const scope = setupScope(assetId, tf, expiryCandles);
  const records = feedbackLedger().filter(item =>
    item.asset === assetId && item.tf === tf && item.rankEligible === true &&
    (item.origin === 'live-emitted' || item.origin === 'scanner-emitted') &&
    isOperationalHistoryEntry(item) &&
    Number(item.expiryCandles || 1) === Number(expiryCandles) && item.setupId && ['ACERTO', 'ERRO', 'NEUTRO'].includes(item.outcome)
  ).map(item => ({ setupId: item.setupId, setupLabel: item.setupLabel, signal: item.verdict, result: item.outcome }));
  if (records.length) {
    state.setupRankingReal[scope] = rankSetups(records, {
      minSamples: cfg().minSetupSamples, payout: (cfg().payout || 85) / 100,
      stake: cfg().stake, operationCost: cfg().operationCost, tiePolicy: cfg().tiePolicy
    });
  } else delete state.setupRankingReal[scope];
  return state.setupRankingReal[scope] || null;
}
function realSetupRanking(assetId = state.assetId, tf = state.tf, expiryCandles = 1) {
  return state.setupRankingReal[setupScope(assetId, tf, expiryCandles)] || refreshSetupRankingReal(assetId, tf, expiryCandles);
}
function activeModel(assetId = state.assetId, tf = state.tf) {
  const key = modelKey(assetId, tf);
  return normalizeModel(state.models[key]) || loadLegacyModel(key);
}
function queuePersist(task) {
  Promise.resolve().then(task).catch(error => {
    if (!state.persistenceError) {
      state.persistenceError = error;
      const text = 'O armazenamento durável está indisponível; esta sessão continuará apenas neste navegador.';
      const host = $('#persistenceStatus');
      if (host) host.textContent = text;
    }
  });
}
function saveSettings() {
  const payload = {
    assetId: state.assetId, tf: state.tf, deepCandles: Number(state.deepCandles),
    autoRefresh: !!state.autoRefresh, refreshEvery: Number(state.refreshEvery),
    autoScan: !!state.autoScan, scanEvery: Number(state.scanEvery),
    scanMarket: state.scanMarket, scanCount: Number(state.scanCount), mode: 'neutro', scannerListVersion: state.scannerListVersion,
    operationCost: 0, tiePolicy: state.tiePolicy || 'loss', thresholds: state.thresholds || {}, thresholdCalibrations: state.thresholdCalibrations || {}, safety: state.safety || {}
  };
  store.set(SETTINGS_KEY, payload);
  if (state.persistenceReady) queuePersist(() => savePersistedSettings(payload));
}
function registry() { return state.modelRegistry || {}; }
function feedbackLedger() { return state.feedback || []; }
function feedbackMeta() { return state.feedbackMeta || {}; }
function persistRegistry(value = state.modelRegistry) {
  state.modelRegistry = value || {};
  store.set(REGISTRY_KEY, state.modelRegistry);
  if (state.persistenceReady) queuePersist(() => savePersistedRegistry(state.modelRegistry));
}
function persistFeedback(value = state.feedback) {
  state.feedback = Array.isArray(value) ? value.slice(-1000) : [];
  store.set(FEEDBACK_KEY, state.feedback);
  if (state.persistenceReady) queuePersist(() => savePersistedFeedback(state.feedback));
}
function persistFeedbackMeta(value = state.feedbackMeta) {
  state.feedbackMeta = value || {};
  store.set(FEEDBACK_META_KEY, state.feedbackMeta);
  if (state.persistenceReady) queuePersist(() => savePersistedFeedbackMeta(state.feedbackMeta));
}
function persistSignalHistory(value = state.signalHistory) {
  state.signalHistory = Array.isArray(value) ? value.slice(0, 250) : [];
  store.set(HISTORY_KEY, state.signalHistory);
  if (state.persistenceReady) queuePersist(() => savePersistedHistory(state.signalHistory));
}
function persistModel(key, model) {
  state.models[key] = model;
  // Espelho de compatibilidade: permite migrar dados de versões anteriores sem perdê-los.
  saveLegacyModel(key, model);
  if (state.persistenceReady) queuePersist(() => savePersistedModel(key, model));
}
function setStatus(text) { $('#analysisProgress').textContent = text; $('#feedStatus').textContent = text; }
function setGradeBadge(element, value) {
  if (!element) return;
  const grade = String(value || '').trim();
  const empty = !grade || grade === '—';
  element.textContent = empty ? '' : grade;
  element.dataset.empty = String(empty);
  element.setAttribute('aria-hidden', String(empty));
}
function setupWorkspaceDetails() {
  const details = $('#workspaceDetails');
  if (!details) return;
  const completed = store.get('market_analyzer_first_analysis_v1', false) === true;
  details.open = completed;
  const status = $('#workspaceDetailsStatus');
  if (status) status.textContent = completed ? 'Histórico e validação disponíveis' : 'Abra para acompanhar detalhes';
}
function revealWorkspaceAfterAnalysis() {
  const details = $('#workspaceDetails');
  if (!details) return;
  store.set('market_analyzer_first_analysis_v1', true);
  details.open = true;
  const status = $('#workspaceDetailsStatus');
  if (status) status.textContent = 'Análise concluída · detalhes atualizados';
}
function dirClass(verdict) { return verdict === 'CALL' ? 'buy' : verdict === 'PUT' ? 'sell' : 'neutral'; }
function dirText(verdict) { return verdict === 'CALL' ? 'COMPRA' : verdict === 'PUT' ? 'VENDA' : 'AGUARDAR'; }
function signalQualityCode(value) { return value === 'CONFIRMADO' || value === 'TECNICO' || value === 'BAIXA' ? value : 'LEGADO'; }
function signalQualityLabel(value) {
  const quality = signalQualityCode(value);
  return quality === 'CONFIRMADO' ? 'confirmado' : quality === 'TECNICO' ? 'técnico · estatística fraca' : quality === 'BAIXA' ? 'avaliação baixa' : 'registro legado';
}
function displaySignal(r) {
  const unreliableData = !!(r && r.dataFreshness && (r.dataFreshness.blocked || r.dataFreshness.stale));
  const entryAt = Number(r && r.expiry && r.expiry.entryAt);
  const entryMissed = Number.isFinite(entryAt) && entryAt <= Date.now();
  const decisionApproved = !!(r && (r.verdict === 'CALL' || r.verdict === 'PUT') && r.decision && !r.decision.blocked && !unreliableData && !entryMissed);
  const technicalDirection = Number(r && r.score && r.score.direction) || 0;
  const bias = decisionApproved ? r.verdict : technicalDirection > 0 ? 'CALL' : technicalDirection < 0 ? 'PUT' : 'AGUARDAR';
  const estimate = r && r.decision && r.decision.estimate;
  const hasRate = !!(estimate && estimate.p !== null && estimate.p !== undefined && Number.isFinite(Number(estimate.p)));
  const positiveEv = !!(r && r.decision && r.decision.ev !== null && r.decision.ev !== undefined && Number.isFinite(Number(r.decision.ev)) && Number(r.decision.ev) > 0);
  const evGate = r && r.decision && Array.isArray(r.decision.gates) ? r.decision.gates.find(gate => gate && gate.kind === 'ev') : null;
  const hasEvLowerBound = !!(evGate && evGate.evLow !== null && evGate.evLow !== undefined && Number.isFinite(Number(evGate.evLow)));
  const conservativeEvPositive = positiveEv && (!hasEvLowerBound || Number(evGate.evLow) > 0);
  const statisticallyQualified = decisionApproved && hasRate && conservativeEvPositive && r.decision.confirmationEligible !== false;
  const informational = !decisionApproved && bias !== 'AGUARDAR';
  const lowStatisticalConfidence = decisionApproved && !statisticallyQualified;
  return {
    approved: decisionApproved,
    statisticallyQualified,
    lowStatisticalConfidence,
    bias,
    informational,
    recordable: bias !== 'AGUARDAR' && !unreliableData && !entryMissed,
    entryMissed,
    label: statisticallyQualified
      ? `${bias === 'CALL' ? 'COMPRA' : 'VENDA'} · CONFIRMADA`
      : lowStatisticalConfidence
        ? `${bias === 'CALL' ? 'COMPRA' : 'VENDA'} · CONFIANÇA BAIXA`
        : bias === 'CALL'
          ? 'COMPRA · AVALIAÇÃO BAIXA'
          : bias === 'PUT'
            ? 'VENDA · AVALIAÇÃO BAIXA'
            : 'AGUARDAR'
  };
}
function primaryDecisionReason(r) {
  const gates = r && r.decision && Array.isArray(r.decision.gates) ? r.decision.gates : [];
  const hardSafety = gates.find(g => !g.ok && g.blocking && /NÃO OPERAR|RISCO ALTO|AVALIAÇÃO BAIXA/i.test(g.text || ''));
  const firstBlocking = gates.find(g => !g.ok && g.blocking);
  return (hardSafety && hardSafety.text) || (firstBlocking && firstBlocking.text) || (r && r.decision && r.decision.reasons && r.decision.reasons[0]) || 'força ou confirmação insuficiente';
}
function sourceText(result) {
  const main = result && result.sources && result.sources[result.tfKey];
  if (!main) return 'fonte pública';
  return `${main.source}${main.stale ? ' · possível atraso' : ''}`;
}
function durationLabel(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60), rest = sec % 60;
  return `${min}min${rest ? ` ${rest}s` : ''}`;
}
function freshnessText(freshness) {
  if (!freshness) return 'Dados: aguardando a primeira cotação.';
  const base = `Dados recebidos há ${durationLabel(freshness.dataAgeMs)} · latência ${durationLabel(freshness.latencyMs)}`;
  if (freshness.blocked) return `${base} · avaliação baixa: ${freshness.reason}`;
  if (freshness.stale) return `${base} · dados em cache, confira antes de operar`;
  return `${base}${freshness.cached ? ' · cache recente' : ''}`;
}
function renderFreshness(r = state.result) {
  const host = $('#signalFreshness'); if (!host) return;
  const freshness = r && r.dataFreshness;
  host.textContent = freshnessText(freshness);
  host.className = `data-freshness${freshness && freshness.blocked ? ' is-blocked' : freshness && freshness.stale ? ' is-warning' : ''}`;
}

async function hydratePersistedState() {
  try {
    await initializePersistence();
    const [savedSettings, savedRegistry, savedHistory, savedFeedback, savedFeedbackMeta, modelRows, calibrationRows, savedCalendar] = await Promise.all([
      loadPersistedSettings(), loadPersistedRegistry(), loadPersistedHistory(), loadPersistedFeedback(), loadPersistedFeedbackMeta(),
      listPersisted(STORES.MODELS, { prefix: 'ma_model_v2_', newestFirst: false }),
      listPersisted(STORES.CALIBRATION, { prefix: 'threshold-calibration:', newestFirst: false }),
      getKv('signal_atlas_calendar_v1', null)
    ]);
    if (savedSettings && Object.keys(savedSettings).length) Object.assign(state, defaults, stored, savedSettings);
    state.mode = 'neutro';
    state.operationCost = 0;
    state.safety = { ...defaults.safety, ...(state.safety || {}) };
    if (savedRegistry && typeof savedRegistry === 'object') state.modelRegistry = savedRegistry;
    if (Array.isArray(savedHistory)) state.signalHistory = savedHistory;
    if (Array.isArray(savedFeedback)) state.feedback = savedFeedback;
    if (savedFeedbackMeta && typeof savedFeedbackMeta === 'object') state.feedbackMeta = savedFeedbackMeta;
    if (savedCalendar && Array.isArray(savedCalendar.events)) state.calendarSnapshot = savedCalendar;
    // Registros legados foram resolvidos contra o preço de referência, não a
    // abertura efetiva da vela de entrada. Mantemos o histórico visível, mas
    // não deixamos esse método antigo bonificar o ranking real novo.
    let migratedFeedback = false;
    for (const item of state.feedback) {
      if (!item || !item.tf || !TIMEFRAMES[item.tf]) continue;
      const tfMs = TIMEFRAMES[item.tf].sec * 1000;
      if (!item.expiryCandles) { item.expiryCandles = 1; migratedFeedback = true; }
      if (!item.entryCandleAt) {
        item.entryCandleAt = Number(item.candleAt) + tfMs;
        item.targetCandleAt = item.entryCandleAt;
        item.expiresAt = item.entryCandleAt + tfMs;
        item.legacyOutcomeMethod = true;
        item.rankEligible = false;
        migratedFeedback = true;
      }
      const times = settlementTimes(item, tfMs);
      if (times && (item.targetCandleAt !== times.targetCandleAt || item.expiresAt !== times.expiresAt || item.dueAt !== times.expiresAt)) {
        item.targetCandleAt = times.targetCandleAt;
        item.expiresAt = times.expiresAt;
        // dueAt antigo apontava para a abertura da vela-alvo. O resultado só
        // fica disponível no fechamento, portanto o vencimento correto é expiresAt.
        item.dueAt = times.expiresAt;
        migratedFeedback = true;
      }
    }
    for (const row of modelRows) {
      const key = row.key.slice('ma_model_v2_'.length);
      if (key) state.models[key] = normalizeModel(row.value);
    }
    for (const row of calibrationRows) {
      const scope = row.key.slice('threshold-calibration:'.length);
      if (!scope || !row.value || typeof row.value !== 'object') continue;
      state.thresholdCalibrations = { ...(state.thresholdCalibrations || {}), [scope]: row.value };
      if (row.value.accepted && Number.isFinite(Number(row.value.threshold))) {
        state.thresholds = { ...(state.thresholds || {}), [scope]: Number(row.value.threshold) };
      }
    }
    for (const item of state.feedback) if (item && item.asset && item.tf) {
      refreshSetupRankingReal(item.asset, item.tf, Number(item.expiryCandles || 1));
    }
    state.persistenceReady = true;
    if (migratedFeedback) persistFeedback(state.feedback);
    const host = $('#persistenceStatus');
    if (host) host.textContent = 'Histórico e modelos salvos neste navegador.';
  } catch (error) {
    state.persistenceError = error;
    const host = $('#persistenceStatus');
    if (host) host.textContent = 'Armazenamento durável indisponível neste contexto.';
  }
}

function attachWorker(lane) {
  if (!('Worker' in window)) throw new Error('Este navegador não suporta processamento em segundo plano.');
  const worker = new Worker(new URL('./market-worker.js', import.meta.url), { type: 'module' });
  const laneState = { worker, jobs: new Map(), ready: false };
  state.workers[lane] = laneState;
  worker.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'ready') { laneState.ready = true; return; }
    const job = laneState.jobs.get(message.id);
    if (!job) return;
    if (message.type === 'progress') { if (job.onProgress) job.onProgress(message); return; }
    laneState.jobs.delete(message.id);
    if (message.type === 'result') job.resolve(message.result);
    else if (message.type === 'cancelled') job.reject(Object.assign(new Error('Tarefa cancelada.'), { name: 'AbortError' }));
    else if (message.type === 'error') job.reject(Object.assign(new Error(message.error && message.error.message || 'Falha no processamento em segundo plano.'), message.error || {}));
  });
  worker.addEventListener('error', event => {
    const error = new Error(event.message || 'Não foi possível iniciar o processamento em segundo plano.');
    laneState.jobs.forEach(job => job.reject(error)); laneState.jobs.clear();
  });
  const pingId = `${lane}-ping-${++state.workerSequence}`;
  worker.postMessage({ id: pingId, type: 'ping' });
}
function prepareWorkers() {
  try { attachWorker('interactive'); attachWorker('background'); }
  catch (error) { setStatus(`Processamento em segundo plano indisponível: ${error.message}`); }
}
function workerRequest(lane, type, payload = {}, onProgress = null) {
  const laneState = state.workers[lane];
  if (!laneState) return Promise.reject(new Error('O processamento em segundo plano não foi iniciado. Recarregue a página.'));
  const id = `${lane}-${Date.now()}-${++state.workerSequence}`;
  return new Promise((resolve, reject) => {
    laneState.jobs.set(id, { resolve, reject, onProgress });
    try { laneState.worker.postMessage({ id, type, ...payload }); }
    catch (error) { laneState.jobs.delete(id); reject(error); }
  });
}

async function init() {
  renderAssetSelect(); renderTimeframes(); bind();
  setStatus('Preparando armazenamento local e processamento em segundo plano…');
  await hydratePersistedState();
  if (state.scannerListVersion !== 2) { state.scanMarket = 'Ambos'; state.scannerListVersion = 2; saveSettings(); }
  syncControls(); renderModelSummary(); renderHistory(); prepareWorkers(); setupOnboarding(); setupWorkspaceDetails(); setupTradingViewObserver(); initializeCloudMonitor();
  state.clockTimer = setInterval(onClockTick, 1000); onClockTick();
  state.historyTimer = setInterval(() => resolvePendingHistory(), 45_000);
  setTimeout(() => resolvePendingHistory(), 2500);
  setStatus('Pronto. A primeira análise buscará candles reais.');
  analyzeCurrent({ auto: true });
}

function renderAssetSelect() {
  const grouped = ['Cripto', 'Forex'].map(group => {
    const opts = allAssets().filter(a => a.group === group)
      .map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
    return `<optgroup label="${group}">${opts}</optgroup>`;
  }).join('');
  $('#assetSelect').innerHTML = grouped;
}
function renderTimeframes() {
  $('#timeframes').innerHTML = TF_LIST.map(tf => `<button class="tf" type="button" data-tf="${tf}" aria-pressed="false">${TIMEFRAMES[tf].label}</button>`).join('');
}
function syncControls() {
  $('#assetSelect').value = state.assetId;
  $('#deepCandles').value = String(state.deepCandles);
  const tiePolicy = $('#tiePolicy'); if (tiePolicy) tiePolicy.value = state.tiePolicy || 'loss';
  $('#autoRefresh').checked = state.autoRefresh;
  $('#refreshEvery').value = String(state.refreshEvery);
  $('#autoScan').checked = state.autoScan;
  $('#scanEvery').value = String(state.scanEvery);
  $('#scanMarket').value = state.scanMarket;
  $('#scanCount').value = String(state.scanCount);
  document.querySelectorAll('.tf').forEach(b => { const on = b.dataset.tf === state.tf; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  const asset = getAsset(state.assetId);
  $('#assetMeta').textContent = asset ? `${asset.group} · feed público: ${asset.okx ? 'OKX com reservas' : asset.kraken ? 'Kraken/Yahoo' : 'Yahoo Finance'}` : '';
  renderLiveChart(asset, state.tf); renderNextCandle();
}
function bind() {
  $('#assetSelect').addEventListener('change', e => { state.assetId = e.target.value; syncControls(); saveSettings(); renderModelSummary(); analyzeCurrent(); });
  $('#timeframes').addEventListener('click', e => { const b = e.target.closest('[data-tf]'); if (!b) return; state.tf = b.dataset.tf; state.lastCandleBucket = Math.floor(Date.now() / (TIMEFRAMES[state.tf].sec * 1000)); syncControls(); saveSettings(); renderModelSummary(); analyzeCurrent(); });
  $('#deepCandles').addEventListener('change', e => { state.deepCandles = Number(e.target.value); saveSettings(); });
  const tiePolicy = $('#tiePolicy');
  if (tiePolicy) tiePolicy.addEventListener('change', e => {
    state.tiePolicy = ['loss', 'refund', 'win'].includes(e.target.value) ? e.target.value : 'loss';
    e.target.value = state.tiePolicy; saveSettings(); renderModelSummary(); analyzeCurrent();
  });
  $('#analyzeBtn').addEventListener('click', () => analyzeCurrent());
  $('#trainBtn').addEventListener('click', () => trainSelected(true));
  $('#backtestBtn').addEventListener('click', runCurrentBacktest);
  $('#scanBtn').addEventListener('click', () => scanMarket(true));
  $('#autoRefresh').addEventListener('change', e => { state.autoRefresh = e.target.checked; saveSettings(); scheduleRefresh(); updateAutomationStatus(); });
  $('#refreshEvery').addEventListener('change', e => { state.refreshEvery = Number(e.target.value); saveSettings(); scheduleRefresh(); updateAutomationStatus(); });
  $('#autoScan').addEventListener('change', e => { state.autoScan = e.target.checked; saveSettings(); scheduleScanner(); updateAutomationStatus(); });
  $('#scanEvery').addEventListener('change', e => { state.scanEvery = Number(e.target.value); saveSettings(); scheduleScanner(); updateAutomationStatus(); });
  $('#scanMarket').addEventListener('change', e => { state.scanMarket = e.target.value; saveSettings(); });
  $('#scanCount').addEventListener('change', e => { state.scanCount = Number(e.target.value); saveSettings(); });
  $('#historyFilter').addEventListener('change', renderHistory);
  const exportButton = $('#exportHistoryCsv');
  if (exportButton) exportButton.addEventListener('click', exportHistoryCsv);
  const cloudRefreshButton = $('#cloudRefreshBtn');
  if (cloudRefreshButton) cloudRefreshButton.addEventListener('click', () => refreshCloudMonitor({ manual: true }));
  const officialSignalOpen = $('#officialSignalOpen');
  if (officialSignalOpen) officialSignalOpen.addEventListener('click', () => {
    const snapshot = state.cloud.snapshot || {};
    const id = officialSignalOpen.dataset.decision;
    const rows = [...(snapshot.opportunities || []), ...(snapshot.canonicalSignals || []), ...(snapshot.latestDecisions || [])];
    focusCloudRecord(rows.find(item => item && item.id === id) || canonicalCloudRecord(snapshot));
  });
  const cloudOpportunityRows = $('#cloudOpportunityRows');
  if (cloudOpportunityRows) cloudOpportunityRows.addEventListener('click', e => {
    const button = e.target.closest('[data-cloud-open]');
    if (!button) return;
    const snapshot = state.cloud.snapshot || {};
    const rows = [...(snapshot.opportunities || []), ...(snapshot.canonicalSignals || []), ...(snapshot.latestDecisions || [])];
    focusCloudRecord(rows.find(item => item && item.id === button.dataset.cloudOpen));
  });
  $('#scannerRows').addEventListener('click', e => {
    const b = e.target.closest('[data-open]'); if (!b) return;
    const assetId = b.dataset.open;
    const tfKey = b.dataset.tf || state.tf;
    const ranked = rankedOpportunitySnapshot(state.scannerRows, assetId, tfKey);
    state.assetId = assetId;
    state.tf = tfKey;
    syncControls();
    saveSettings();
    // A lista já recebe do Worker a análise completa. Abrir essa mesma
    // fotografia evita que um segundo fetch troque COMPRA/VENDA por AGUARDAR
    // enquanto a tela ainda mostra força/nota pertencentes ao ranking anterior.
    // O botão "Analisar agora" continua disponível para pedir uma nova leitura.
    if (ranked && ranked.result) {
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
      const opened = ranked.result;
      state.result = opened;
      renderAnalysis(opened);
      setStatus(`Oportunidade #${ranked.rank} aberta sem recalcular · fotografia de ${fmtTime(opened.scannerSnapshotAt)}. Use “Analisar agora” para atualizar.`);
      scheduleRefresh();
    } else {
      analyzeCurrent();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function cloudDateTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '—';
  return new Date(time).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function cloudNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cloudMoney(value, { signed = false } = {}) {
  const number = cloudNumber(value);
  if (number === null) return '—';
  const prefix = signed && number > 0 ? '+' : '';
  return `R$ ${prefix}${fmt(number, 3)}`;
}

function cloudAge(value) {
  const milliseconds = cloudNumber(value);
  if (milliseconds === null || milliseconds < 0) return 'idade da vela não informada';
  if (milliseconds < 1_000) return 'vela atual recém-aberta';
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `vela atual com ${seconds}s`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (minutes < 60) return `vela atual com ${minutes}min${rest ? ` ${rest}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  return `vela atual com ${hours}h ${minutes % 60}min`;
}

function cloudModeLabel(mode) {
  const value = String(mode || 'neutro').toLowerCase();
  return value === 'conservador' ? 'conservador' : value === 'agressivo' ? 'agressivo' : 'neutro';
}

function cloudQualityLabel(value) {
  return value === 'CONFIRMADO' ? 'confirmado'
    : value === 'TECNICO' ? 'técnico · sem promoção comprovada'
      : value === 'BAIXA' ? 'avaliação baixa'
        : 'referência cloud';
}

function cloudCollectionTime(snapshot) {
  const healthTime = snapshot && snapshot.health && snapshot.health.lastCollectionAt;
  if (cloudNumber(healthTime) !== null) return Number(healthTime);
  const rows = [...(snapshot && snapshot.latestDecisions || []), ...(snapshot && snapshot.opportunities || [])];
  const times = rows.map(item => Number(item && item.decisionAt)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

function cloudResolvedCount(snapshot) {
  const metrics = snapshot && Array.isArray(snapshot.metrics) ? snapshot.metrics : [];
  if (metrics.length) return metrics.reduce((total, item) => total + (Number(item && item.resolved) || 0), 0);
  const direct = snapshot && snapshot.health && snapshot.health.resolvedProspective;
  return cloudNumber(direct) !== null ? Number(direct) : null;
}

function setCloudElementText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function cloudCriteriaDetails(reference, fallback) {
  const criteria = Array.isArray(reference && reference.criteria) ? reference.criteria.filter(Boolean) : [];
  const summary = criteria[0] || fallback || 'Critérios ainda não detalhados para este registro.';
  const checks = criteria.slice(1).filter(item => /^(APROVADO|PARCIAL|REPROVADO)\s+—/i.test(item)).slice(0, 8);
  if (!checks.length) return `<small>${escapeHtml(summary)}</small>`;
  const passed = checks.filter(item => /^APROVADO/i.test(item)).length;
  const partial = checks.filter(item => /^PARCIAL/i.test(item)).length;
  const failed = checks.filter(item => /^REPROVADO/i.test(item)).length;
  return `<details class="cloud-criteria"><summary>${escapeHtml(summary)}</summary><div class="cloud-criteria-counts"><span class="pass">${passed} aprovados</span><span class="partial">${partial} parciais</span><span class="fail">${failed} reprovados</span></div><ul>${checks.map(item => {
    const tone = /^APROVADO/i.test(item) ? 'pass' : /^PARCIAL/i.test(item) ? 'partial' : 'fail';
    return `<li class="${tone}">${escapeHtml(item)}</li>`;
  }).join('')}</ul></details>`;
}

function canonicalCloudRecord(snapshot) {
  const opportunities = snapshot && Array.isArray(snapshot.opportunities) ? snapshot.opportunities : [];
  const canonical = snapshot && Array.isArray(snapshot.canonicalSignals) ? snapshot.canonicalSignals : [];
  const canonicalById = new Map(canonical.filter(Boolean).map(item => [item.id, item]));
  const enrich = item => item ? { ...item, ...(canonicalById.get(item.id) || {}) } : null;
  const combined = [...opportunities.map(enrich), ...canonical];
  const focused = state.cloud.focusedId && combined.find(item => item && item.id === state.cloud.focusedId);
  if (focused) return focused;
  return enrich(opportunities[0]) || canonical[0] || null;
}

function cloudWindowText(record) {
  const entry = Number(record && record.entryAt), expiry = Number(record && record.expiryAt), now = Date.now();
  if (!Number.isFinite(entry)) return 'horário ainda não publicado';
  if (now < entry) return `entra ${cloudDateTime(entry)} · fecha ${cloudDateTime(expiry)}`;
  if (Number.isFinite(expiry) && now < expiry) return `entrada encerrada · acompanhando até ${cloudDateTime(expiry)}`;
  return `janela encerrada · última entrada ${cloudDateTime(entry)}`;
}

function renderOfficialCloudSignal(snapshot) {
  const card = $('#officialSignalCard');
  if (!card) return;
  const record = canonicalCloudRecord(snapshot);
  const openButton = $('#officialSignalOpen');
  if (!record) {
    card.className = 'panel official-signal-card waiting';
    $('#officialSignalName').textContent = snapshot && snapshot.configured ? 'Aguardando decisão oficial' : 'Backend ainda não conectado';
    $('#officialSignalTime').textContent = 'Nenhuma decisão cloud foi publicada pela política atual.';
    $('#officialSignalQuality').textContent = snapshot && snapshot.fromCache ? 'Cache indisponível' : 'Aguardando';
    setGradeBadge($('#officialSignalGrade'), null);
    $('#officialSignalDirection').className = 'direction neutral';
    $('#officialSignalDirection').textContent = 'AGUARDAR';
    $('#officialSignalSummary').textContent = 'A leitura local permanece complementar e não será apresentada como decisão oficial.';
    $('#officialSignalScore').textContent = '—';
    $('#officialSignalProbability').textContent = 'Modelo: —';
    $('#officialSignalEv').textContent = '—';
    $('#officialSignalSample').textContent = '—';
    $('#officialSignalWindow').textContent = '—';
    $('#officialSignalSource').textContent = 'Supabase 24/7';
    $('#officialSignalCriteria').textContent = 'Critérios aguardando atualização.';
    if (openButton) { openButton.disabled = true; delete openButton.dataset.asset; delete openButton.dataset.tf; }
    return;
  }
  const direction = record.verdict === 'CALL' ? 'buy' : record.verdict === 'PUT' ? 'sell' : 'neutral';
  const directionText = record.verdict === 'CALL' ? 'COMPRA' : record.verdict === 'PUT' ? 'VENDA' : 'AGUARDAR';
  const asset = getAsset(record.symbol);
  const isUpcoming = Number.isFinite(Number(record.entryAt)) && Date.now() < Number(record.entryAt);
  const isCached = !!(snapshot && snapshot.fromCache);
  const contractVersion = Number(record.qualityContractVersion) || 0;
  const isCurrentQualityContract = contractVersion >= 4;
  const displayQuality = isCurrentQualityContract ? record.quality : 'REFERENCIA';
  const quality = isCurrentQualityContract ? cloudQualityLabel(record.quality) : 'aguardando contrato estatístico v4';
  card.className = `panel official-signal-card ${direction}${record.quality === 'BAIXA' ? ' low-confidence' : ''}`;
  $('#officialSignalName').textContent = `${asset ? asset.name : record.symbol || 'Ativo'} · ${record.tf || '—'}`;
  $('#officialSignalTime').textContent = `${isUpcoming ? 'Oportunidade antes da entrada' : 'Última decisão congelada'} · ${cloudDateTime(record.decisionAt)}${isCached ? ' · exibindo cache' : ''}`;
  $('#officialSignalQuality').textContent = quality;
  $('#officialSignalQuality').dataset.quality = String(displayQuality || 'REFERENCIA').toLowerCase();
  setGradeBadge($('#officialSignalGrade'), record.grade || 'D');
  $('#officialSignalDirection').className = `direction ${direction}${record.quality === 'BAIXA' ? ' low-confidence' : ''}`;
  $('#officialSignalDirection').textContent = directionText;
  const promotionText = !isCurrentQualityContract
    ? 'Decisão anterior ao contrato v4: direção e nota continuam visíveis, mas a confirmação não é reaproveitada.'
    : record.confirmedPass
    ? `Champion promovido em revisão prospectiva com N=${Math.max(0, Math.round(Number(record.promotionPairedSamples) || 0))}.`
    : record.quality === 'TECNICO'
      ? 'Passou no gate técnico, mas o champion ainda não possui promoção prospectiva comprovada.'
      : 'A direção permanece visível, porém uma ou mais travas operacionais/estatísticas reduziram a qualidade.';
  $('#officialSignalSummary').textContent = `${promotionText} Nota técnica e qualidade estatística não são misturadas.`;
  $('#officialSignalScore').textContent = cloudNumber(record.score) === null ? '—' : `${fmt(Number(record.score), 1)}/100`;
  const probability = cloudNumber(record.modelConfidence) === null ? '—' : fmtPct(Number(record.modelConfidence));
  const probabilityLb = cloudNumber(record.probabilityLb) === null ? '—' : fmtPct(Number(record.probabilityLb));
  $('#officialSignalProbability').textContent = `Modelo ${probability} · limite conservador ${probabilityLb}`;
  $('#officialSignalEv').textContent = cloudNumber(record.evLb95) !== null
    ? `${cloudMoney(record.evLb95, { signed: true })} (LB95)`
    : cloudMoney(record.ev, { signed: true });
  $('#officialSignalSample').textContent = `N=${Math.max(0, Math.round(Number(record.validationSamples || record.samples) || 0)).toLocaleString('pt-BR')}`;
  $('#officialSignalWindow').textContent = cloudWindowText(record);
  $('#officialSignalSource').textContent = `${record.source || 'backend'} · política única`;
  $('#officialSignalCriteria').innerHTML = cloudCriteriaDetails(record, record.reason || 'Decisão congelada pelo motor backend.');
  if (openButton) {
    openButton.disabled = !asset || !TIMEFRAMES[record.tf];
    openButton.dataset.asset = asset ? asset.id : '';
    openButton.dataset.tf = record.tf || '';
    openButton.dataset.decision = record.id || '';
  }
}

function focusCloudRecord(record) {
  if (!record) return;
  state.cloud.focusedId = record.id || null;
  renderOfficialCloudSignal(state.cloud.snapshot);
  const asset = getAsset(record.symbol);
  if (asset && TIMEFRAMES[record.tf]) {
    state.assetId = asset.id;
    state.tf = record.tf;
    syncControls();
    saveSettings();
    renderLiveChart(asset, state.tf);
    analyzeCurrent({ auto: true });
  }
  $('#officialSignalCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCloudOpportunities(snapshot) {
  const body = $('#cloudOpportunityRows');
  if (!body) return;
  const records = snapshot && Array.isArray(snapshot.opportunities) && snapshot.opportunities.length
    ? snapshot.opportunities
    : snapshot && Array.isArray(snapshot.latestDecisions) ? snapshot.latestDecisions : [];
  if (!records.length) {
    const message = snapshot && snapshot.configured
      ? snapshot.fromCache ? 'O cache da nuvem ainda não contém oportunidades prospectivas.' : 'A nuvem ainda não publicou oportunidades prospectivas.'
      : 'Aguardando configuração opcional da nuvem. O modo local continua funcionando normalmente.';
    body.innerHTML = `<tr><td colspan="7" class="empty-row empty-awaiting">${escapeHtml(message)}</td></tr>`;
    return;
  }
  body.innerHTML = records.slice(0, 16).map(record => {
    // Defesa adicional: toda linha cloud permanece explicitamente fora do
    // ranking e do aprendizado locais, mesmo se o contrato remoto mudar.
    const reference = { ...record, origin: 'cloud-reference', rankEligible: false };
    const direction = reference.verdict === 'CALL' ? 'buy' : reference.verdict === 'PUT' ? 'sell' : 'neutral';
    const signal = reference.verdict === 'CALL' ? 'COMPRA' : reference.verdict === 'PUT' ? 'VENDA' : 'AGUARDAR';
    const realRate = cloudNumber(reference.historicalWinRate) !== null ? fmtPct(Number(reference.historicalWinRate)) : 'em construção';
    const realSamples = cloudNumber(reference.samples) !== null ? Math.max(0, Math.round(Number(reference.samples))) : 0;
    const sample = `N real=${realSamples}`;
    const modelRate = cloudNumber(reference.modelConfidence) !== null ? `modelo ${fmtPct(Number(reference.modelConfidence))}` : 'modelo sem taxa';
    const benchmarkRate = cloudNumber(reference.benchmarkWinRate) !== null ? fmtPct(Number(reference.benchmarkWinRate)) : '50,0%';
    const score = cloudNumber(reference.score) !== null ? `${fmt(Number(reference.score), 1)}/100` : '—';
    const ev = cloudNumber(reference.historicalEv) !== null
      ? cloudMoney(reference.historicalEv, { signed: true })
      : cloudMoney(reference.ev, { signed: true });
    const reason = reference.reason || 'Registro prospectivo independente do motor local.';
    const freshness = cloudAge(reference.dataAgeMs);
    return `<tr><td data-label="Ativo"><b>${escapeHtml(reference.symbol || '—')}</b><span class="cloud-reference-tag">OFICIAL 24/7</span></td><td data-label="Tempo">${escapeHtml(reference.tf || '—')}${reference.expiry ? `<small>${escapeHtml(reference.expiry)} · nota ${escapeHtml(reference.grade || 'D')}</small>` : ''}</td><td data-label="Sinal / qualidade" class="side-${direction}">${escapeHtml(signal)}<small>${escapeHtml(cloudQualityLabel(reference.quality))}</small></td><td data-label="Força">${escapeHtml(score)}<small>${escapeHtml(modelRate)}</small></td><td data-label="Taxa real / amostra"><b>${escapeHtml(realRate)}</b><small>${escapeHtml(sample)} · ref. ${escapeHtml(benchmarkRate)}</small></td><td data-label="EV simulado">${escapeHtml(ev)}<small>${realSamples >= 300 ? 'amostra prospectiva validada' : 'amostra ainda em formação'}</small></td><td data-label="Critérios / atualização"><time${reference.decisionAt ? ` datetime="${new Date(reference.decisionAt).toISOString()}"` : ''}>${escapeHtml(cloudDateTime(reference.decisionAt))}</time><small>${escapeHtml(freshness)}</small>${cloudCriteriaDetails(reference, reason)}<button type="button" class="row-action cloud-open-action" data-cloud-open="${escapeHtml(reference.id)}">Usar como sinal oficial</button></td></tr>`;
  }).join('');
}

function renderCloudQualityBreakdown(snapshot) {
  const target = $('#cloudQualityBreakdown');
  if (!target) return;
  const rows = snapshot && Array.isArray(snapshot.qualityPaper) ? snapshot.qualityPaper : [];
  const ordered = [
    { key: 'CONFIRMADO', label: 'Confirmado' },
    { key: 'TECNICO', label: 'Técnico' },
    { key: 'BAIXA', label: 'Avaliação baixa' }
  ];
  target.innerHTML = ordered.map(item => {
    const row = rows.find(value => value && value.quality === item.key);
    const trades = row ? Math.max(0, Math.round(Number(row.trades) || 0)) : 0;
    if (!row || !trades) {
      return `<div class="cloud-quality-card is-empty"><span>${escapeHtml(item.label)}</span><b>Sem amostra</b><small>Aguardando registros prospectivos resolvidos</small></div>`;
    }
    const rate = cloudNumber(row.winRate) === null ? '—' : fmtPct(Number(row.winRate));
    const ev = cloudMoney(row.ev, { signed: true });
    const edge = cloudMoney(row.edgeVsBenchmark, { signed: true });
    const sample = row.sampleStatus === 'prospective_validated' ? 'amostra validada' : 'amostra em formação';
    const tone = Number(row.edgeVsBenchmark) > 0 ? 'is-positive' : 'is-negative';
    return `<div class="cloud-quality-card ${tone}"><span>${escapeHtml(item.label)}</span><b>${escapeHtml(rate)} · ${escapeHtml(ev)}</b><small>N=${trades.toLocaleString('pt-BR')} · edge vs acaso ${escapeHtml(edge)} · ${escapeHtml(sample)}</small></div>`;
  }).join('');
}

function cloudOutcomePresentation(value) {
  const outcome = String(value || '').toUpperCase();
  if (outcome === 'ACERTO') return { label: 'Acerto', tone: 'win' };
  if (outcome === 'ERRO') return { label: 'Erro', tone: 'loss' };
  if (outcome === 'NEUTRO') return { label: 'Neutro', tone: 'tie' };
  if (outcome === 'DADOS_AUSENTES') return { label: 'Dado ausente', tone: 'unavailable' };
  return { label: 'Aguardando', tone: 'pending' };
}

function renderCloudGradeHistory(snapshot) {
  const overview = $('#cloudGradeHistoryOverview'), body = $('#cloudGradeHistoryRows');
  if (!overview || !body) return;
  const records = snapshot && Array.isArray(snapshot.gradeHistory) ? snapshot.gradeHistory : [];
  const resolved = records.filter(row => ['ACERTO', 'ERRO', 'NEUTRO'].includes(row.outcome));
  const hits = resolved.filter(row => row.outcome === 'ACERTO').length;
  const ties = resolved.filter(row => row.outcome === 'NEUTRO').length;
  const losses = resolved.length - hits - ties;
  const highQuality = records.filter(row => ['CONFIRMADO', 'TECNICO'].includes(row.quality)).length;
  const lowQuality = records.filter(row => row.quality === 'BAIXA').length;
  overview.innerHTML = `<div><span>A/A+ encontrados</span><b>${records.length.toLocaleString('pt-BR')}</b></div><div><span>Taxa observada · ref. 50%</span><b>${resolved.length ? `${fmtPct(hits / resolved.length * 100)} · 50%` : '— · 50%'}</b></div><div><span>Acertos / erros / empates</span><b>${hits} / ${losses} / ${ties}</b></div><div><span>Confirmado/técnico · baixa</span><b>${highQuality} · ${lowQuality}</b></div>`;
  if (!records.length) {
    const message = snapshot && snapshot.configured
      ? 'Ainda não existe sinal A ou A+ no histórico prospectivo da política atual.'
      : 'Aguardando conexão com o histórico prospectivo da nuvem.';
    body.innerHTML = `<tr><td colspan="8" class="empty-row empty-awaiting">${escapeHtml(message)}</td></tr>`;
    return;
  }
  body.innerHTML = records.map(record => {
    const direction = record.verdict === 'CALL' ? 'buy' : record.verdict === 'PUT' ? 'sell' : 'neutral';
    const signal = record.verdict === 'CALL' ? 'COMPRA' : record.verdict === 'PUT' ? 'VENDA' : 'AGUARDAR';
    const outcome = cloudOutcomePresentation(record.outcome);
    const score = cloudNumber(record.score) === null ? '—' : `${fmt(Number(record.score), 1)}/100`;
    const probability = cloudNumber(record.modelConfidence) === null ? 'modelo em formação' : `modelo ${fmtPct(Number(record.modelConfidence))}`;
    const prices = cloudNumber(record.entryPrice) !== null && cloudNumber(record.closePrice) !== null
      ? `${fmt(Number(record.entryPrice), 5)} → ${fmt(Number(record.closePrice), 5)}` : 'preços após resolução';
    const pnl = cloudNumber(record.pnl) === null ? '—' : cloudMoney(record.pnl, { signed: true });
    const reason = record.reason || 'Registro prospectivo congelado antes da entrada.';
    return `<tr><td data-label="Emissão"><time${record.decisionAt ? ` datetime="${new Date(record.decisionAt).toISOString()}"` : ''}>${escapeHtml(cloudDateTime(record.decisionAt))}</time></td><td data-label="Ativo / tempo"><b>${escapeHtml(record.symbol || '—')}</b><small>${escapeHtml(record.tf || '—')} · ${escapeHtml(record.expiry || 'E1')}</small></td><td data-label="Sinal / nota" class="side-${direction}">${escapeHtml(signal)}<small>nota ${escapeHtml(record.grade || '—')}</small></td><td data-label="Qualidade">${escapeHtml(cloudQualityLabel(record.quality))}<small>congelada na emissão</small></td><td data-label="Entrada / expiração">${escapeHtml(cloudDateTime(record.entryAt))}<small>fecha ${escapeHtml(cloudDateTime(record.expiryAt))}</small></td><td data-label="Força / modelo">${escapeHtml(score)}<small>${escapeHtml(probability)}</small></td><td data-label="Resultado"><span class="outcome-badge ${outcome.tone}">${escapeHtml(outcome.label)}</span><small>${escapeHtml(prices)}</small></td><td data-label="Paper P&amp;L / critérios">${escapeHtml(pnl)}${cloudCriteriaDetails(record, reason)}</td></tr>`;
  }).join('');
}

function renderCloudMonitor(snapshot = state.cloud.snapshot, { loading = state.cloud.loading } = {}) {
  const panel = $('#cloudMonitor'), badge = $('#cloudConnectionBadge'), detail = $('#cloudStatusDetail');
  if (!panel || !badge || !detail) return;
  const configured = snapshot ? snapshot.configured !== false : cloudIsConfigured();
  let visualState = 'local', label = 'Modo local', detailText = 'Nuvem não configurada · modo local ativo.';
  if (loading) {
    visualState = 'loading'; label = 'Consultando nuvem'; detailText = 'Buscando a coleta 24/7 sem interromper a análise local…';
  } else if (configured && snapshot && snapshot.status === 'online') {
    visualState = 'online'; label = 'Nuvem conectada'; detailText = `Monitoramento 24/7 · política única · atualizado em ${cloudDateTime(snapshot.fetchedAt)}. Métricas cloud continuam separadas das métricas locais.`;
  } else if (configured && snapshot && snapshot.status === 'partial') {
    const unavailable = Array.isArray(snapshot.errors) && snapshot.errors.length
      ? ` Endpoint temporariamente indisponível: ${snapshot.errors.join(' · ')}.` : '';
    visualState = 'partial'; label = 'Nuvem parcial'; detailText = `Parte do monitoramento respondeu em ${cloudDateTime(snapshot.fetchedAt)}.${unavailable} O restante não altera o modo local.`;
  } else if (configured && snapshot && snapshot.fromCache) {
    visualState = 'cached'; label = 'Cache da nuvem'; detailText = `Nuvem indisponível · exibindo somente o último cache de ${cloudDateTime(snapshot.fetchedAt)} · modo local ativo.`;
  } else if (configured) {
    visualState = 'offline'; label = 'Nuvem indisponível'; detailText = 'Nuvem indisponível · modo local ativo.';
  }
  panel.dataset.state = visualState;
  badge.textContent = label;
  detail.textContent = detailText;

  const health = snapshot && snapshot.health;
  const latest = snapshot && Array.isArray(snapshot.latestDecisions) ? snapshot.latestDecisions[0] : null;
  const processedAsset = health && health.processedAsset && health.processedAsset !== '—'
    ? `${health.processedAsset}${health.timeframe ? ` · ${health.timeframe}` : ''}`
    : latest ? `${latest.symbol}${latest.tf && latest.tf !== '—' ? ` · ${latest.tf}` : ''}` : '—';
  const resolved = cloudResolvedCount(snapshot);
  const paper = snapshot && snapshot.paper;
  setCloudElementText('#cloudProcessedAsset', processedAsset);
  setCloudElementText('#cloudLastCollection', cloudDateTime(cloudCollectionTime(snapshot)));
  setCloudElementText('#cloudResolvedCount', resolved === null ? '—' : Math.max(0, Math.round(resolved)).toLocaleString('pt-BR'));
  setCloudElementText('#cloudResolvedMode', 'prospectivos · política única');
  setCloudElementText('#cloudPaperEv', paper ? cloudMoney(paper.ev, { signed: true }) : '—');
  setCloudElementText('#cloudPaperMode', 'simulado · política única');
  setCloudElementText('#cloudPaperDrawdown', paper ? cloudMoney(paper.maxDrawdown) : '—');
  setCloudElementText('#cloudPaperBenchmark', paper ? cloudMoney(paper.benchmarkEv, { signed: true }) : '—');
  renderCloudQualityBreakdown(snapshot);
  renderCloudOpportunities(snapshot);
  renderCloudGradeHistory(snapshot);
  renderOfficialCloudSignal(snapshot);
}

function scheduleCloudMonitor() {
  if (state.cloudTimer) clearTimeout(state.cloudTimer);
  state.cloudTimer = null;
  if (!cloudIsConfigured()) return;
  state.cloudTimer = setTimeout(() => refreshCloudMonitor(), 60_000);
}

async function refreshCloudMonitor({ manual = false } = {}) {
  if (state.cloud.loading) return;
  if (!cloudIsConfigured()) {
    state.cloud.snapshot = null;
    renderCloudMonitor(null, { loading: false });
    scheduleCloudMonitor();
    return;
  }
  state.cloud.loading = true;
  state.cloud.lastAttemptAt = Date.now();
  const button = $('#cloudRefreshBtn');
  if (button) button.disabled = true;
  renderCloudMonitor(state.cloud.snapshot, { loading: true });
  try {
    const requestedMode = state.mode;
    const snapshot = await loadCloudDashboard({ limit: 16, timeoutMs: 5000, mode: requestedMode });
    // Snapshot remoto vive apenas neste ramo de UI; ele nunca é anexado a
    // state.feedback, state.result, modelos, rankings ou mensagens do Worker.
    if (requestedMode === state.mode) {
      state.cloud.snapshot = snapshot;
      renderCloudMonitor(snapshot, { loading: false });
    }
  } catch (_) {
    const previous = state.cloud.snapshot;
    const fallback = previous
      ? { ...previous, configured: true, status: 'offline', fromCache: true }
      : { configured: true, status: 'offline', fromCache: false, canonicalSignals: [], latestDecisions: [], opportunities: [], gradeHistory: [], metrics: [], paper: null, health: null };
    state.cloud.snapshot = fallback;
    renderCloudMonitor(fallback, { loading: false });
  } finally {
    state.cloud.loading = false;
    if (button) button.disabled = false;
    scheduleCloudMonitor();
    if (manual && state.cloud.snapshot && state.cloud.snapshot.status === 'online') button && button.blur();
  }
}

function initializeCloudMonitor() {
  renderCloudMonitor(null, { loading: false });
  refreshCloudMonitor();
  window.addEventListener('online', () => refreshCloudMonitor());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !cloudIsConfigured()) return;
    const last = Number(state.cloud.snapshot && state.cloud.snapshot.fetchedAt || state.cloud.lastAttemptAt || 0);
    if (Date.now() - last > 60_000) refreshCloudMonitor();
  });
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}
function exportHistoryCsv() {
  const filter = $('#historyFilter');
  const selected = filter ? filter.value : 'all';
  const entries = feedbackLedger().filter(entry =>
    isVisibleGradeHistoryEntry(entry) && (selected === 'all' || entry.asset === selected)
  );
  const groups = new Map();
  for (const entry of entries) {
    const quality = signalQualityCode(entry.quality);
    const key = `${entry.asset}|${entry.tf}|${entry.verdict}|E${Number(entry.expiryCandles || 1)}|${quality}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const rates = new Map();
  for (const [key, rows] of groups) {
    const resolved = rows.filter(row => ['ACERTO', 'ERRO', 'NEUTRO'].includes(row.outcome));
    const hits = resolved.filter(row => row.outcome === 'ACERTO').length;
    rates.set(key, resolved.length ? `${fmtPct(hits / resolved.length * 100)}` : '—');
  }
  const header = ['Ativo', 'Tempo gráfico', 'Expiração (velas)', 'Sinal', 'Classificação', 'Qualidade na emissão', 'Resultado', 'Taxa de acerto (empates inclusos)', 'Referência', 'Emitido em', 'Resolvido em', 'Preço de referência', 'Preço de entrada', 'Força', 'Probabilidade estimada', 'EV líquido estimado'];
  const rows = entries.slice().sort((a, b) => b.createdAt - a.createdAt).map(entry => {
    const quality = signalQualityCode(entry.quality);
    const key = `${entry.asset}|${entry.tf}|${entry.verdict}|E${Number(entry.expiryCandles || 1)}|${quality}`;
    return [
      getAsset(entry.asset)?.name || entry.asset, entry.tf, Number(entry.expiryCandles || 1), signalLabel(entry.verdict), normalizeOperationalGrade(entry.grade) || '', signalQualityLabel(quality), entry.outcome,
      rates.get(key) || '—', 'Escolha aleatória: 50%',
      entry.createdAt ? new Date(entry.createdAt).toLocaleString('pt-BR') : '',
      entry.resolvedAt ? new Date(entry.resolvedAt).toLocaleString('pt-BR') : '',
      Number.isFinite(entry.price) ? String(entry.price).replace('.', ',') : '', Number.isFinite(entry.entryPrice) ? String(entry.entryPrice).replace('.', ',') : '', entry.score ?? '',
      Number.isFinite(entry.estimatedProbability) ? String(entry.estimatedProbability).replace('.', ',') : '', Number.isFinite(entry.estimatedEv) ? String(entry.estimatedEv).replace('.', ',') : ''
    ];
  });
  const content = '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`market-analyzer-historico-${stamp}.csv`, content, 'text/csv;charset=utf-8');
}

function setupOnboarding() {
  const modal = $('#onboardingModal');
  if (!modal) return;
  const closeButton = $('#onboardingClose'), startButton = $('#onboardingStart'), skipButton = $('#onboardingSkip');
  let previousFocus = null;
  const close = () => {
    modal.hidden = true; modal.setAttribute('aria-hidden', 'true'); document.body.classList.remove('onboarding-open');
    store.set('signal_atlas_onboarding_seen_v1', true);
    if (state.persistenceReady) queuePersist(() => setKv('signal_atlas_onboarding_seen_v1', true));
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    previousFocus = null;
  };
  [closeButton, startButton, skipButton].filter(Boolean).forEach(button => button.addEventListener('click', close));
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  document.addEventListener('keydown', event => {
    if (modal.hidden) return;
    if (event.key === 'Escape') { close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(node => !node.hidden && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  const openIfFirstVisit = async () => {
    let seen = store.get('signal_atlas_onboarding_seen_v1', false);
    if (state.persistenceReady) {
      try { seen = await getKv('signal_atlas_onboarding_seen_v1', seen); } catch (_) { /* fallback já definido */ }
    }
    if (seen) return;
    previousFocus = document.activeElement;
    modal.hidden = false; modal.setAttribute('aria-hidden', 'false'); document.body.classList.add('onboarding-open');
    setTimeout(() => closeButton && closeButton.focus(), 0);
  };
  openIfFirstVisit();
}

async function analyzeCurrent({ auto = false } = {}) {
  if (state.analyzing) { state.pendingAnalyze = true; return; }
  const asset = getAsset(state.assetId); if (!asset) return;
  const tf = state.tf;
  state.analyzing = true; state.busy = true; setButtons(); clearCache();
  setStatus(auto ? 'Atualizando candles reais…' : 'Buscando candles reais…');
  renderAnalysisLoading();
  let feedbackChanged = [];
  try {
    const result = await workerRequest('interactive', 'analyze', {
      asset, tfKey: tf, settings: cfg(), model: activeModel(asset.id, tf),
      // Todos os rankings enviados são reais e separados por expiração. O
      // Worker escolhe E1/E2/E3 depois de a política causal definir o prazo.
      setupRankings: state.setupRankingReal, calendarSnapshot: state.calendarSnapshot, includeLive: true
    }, message => {
      if (message.text) setStatus(message.text);
      else if (message.stage === 'fetch' && message.count) setStatus(`Buscando candles reais: ${message.count} recebidos…`);
    });
    // Uma seleção nova nunca deve ser substituída por uma resposta antiga.
    if (asset.id !== state.assetId || tf !== state.tf) return;
    if (result.calendarSnapshot && Array.isArray(result.calendarSnapshot.events)) {
      state.calendarSnapshot = result.calendarSnapshot;
      if (state.persistenceReady) queuePersist(() => setKv('signal_atlas_calendar_v1', result.calendarSnapshot));
    }
    state.result = { ...result, openedFromScanner: false }; renderAnalysis(state.result); feedbackChanged = settleLearningRecords(result); recordSignal(result); setStatus(`${sourceText(result)} · nova leitura atualizada ${fmtTime(Date.now())}`);
    if (!auto) revealWorkspaceAfterAnalysis();
  } catch (err) {
    if (err && err.name !== 'AbortError') { setStatus(`Não foi possível analisar agora: ${err.message}`); renderError(err.message); }
  } finally {
    state.analyzing = false; state.busy = false; setButtons(); scheduleRefresh(); scheduleScanner(); updateAutomationStatus(); queueFeedbackRetrains(feedbackChanged);
    if (!state.initialScanStarted && state.autoScan) { state.initialScanStarted = true; setTimeout(() => scanMarket(), 700); }
    if (state.pendingAnalyze) { state.pendingAnalyze = false; analyzeCurrent({ auto: true }); }
  }
}
function setButtons() {
  $('#analyzeBtn').disabled = state.analyzing; $('#trainBtn').disabled = state.training;
  $('#backtestBtn').disabled = state.backtesting; $('#scanBtn').disabled = state.scanning;
}

function renderAnalysisLoading() {
  const reasons = $('#reasons'), details = $('#details');
  if (reasons) { reasons.className = 'reason-list empty-state empty-loading'; reasons.textContent = 'Buscando candles e aplicando filtros de precisão…'; reasons.setAttribute('aria-busy', 'true'); }
  if (details) { details.className = 'metric-grid empty-state empty-loading'; details.textContent = 'Processando indicadores, zonas e contexto multi-timeframe…'; details.setAttribute('aria-busy', 'true'); }
  if (!state.result) {
    $('#signalCard').className = 'panel signal-card waiting';
    $('#signalName').textContent = 'Analisando dados reais';
    $('#signalTime').textContent = 'Aguardando candles e validação dos filtros.';
  }
}

function renderAnalysis(r) {
  if (r.dataError || !r.snapshot) { renderError((r.reasons || ['Dados indisponíveis.']).join(' ')); return; }
  const verdict = r.verdict || 'AGUARDAR';
  const display = displaySignal(r);
  const estimate = r.decision && r.decision.estimate;
  const probability = estimate && estimate.p !== null && estimate.p !== undefined && Number.isFinite(Number(estimate.p)) ? fmtPct(Number(estimate.p) * 100) : 'Não validada';
  const risk = r.cond ? r.cond.label : '—';
  const conf = r.score && r.score.confluence ? r.score.confluence.text : '—';
  const expiryCandles = Math.max(1, Number(r.expiry && r.expiry.candles || r.decision && r.decision.expiryCandles || 1));
  const expiryText = `${expiryCandles} vela${expiryCandles > 1 ? 's' : ''}`;
  $('#signalCard').className = `panel signal-card ${dirClass(display.bias)}${display.informational || display.lowStatisticalConfidence ? ' low-confidence' : ''}`;
  $('#signalName').textContent = r.asset.name;
  const rankingOrigin = r.openedFromScanner
    ? ` · mesma fotografia do ranking #${Number(r.scannerRank) || '—'} (${fmtTime(r.scannerSnapshotAt || r.at)})`
    : '';
  $('#signalTime').textContent = `${r.tfKey} · ${sourceText(r)} · ${r.totalCandles || r.candleCount} candles recebidos · ${r.inProgressCandle ? 'vela em andamento' : 'última vela fechada'}${rankingOrigin}`;
  renderFreshness(r);
  setGradeBadge($('#signalGrade'), r.grade ? r.grade.grade : null);
  $('#signalGrade').style.color = display.statisticallyQualified && verdict === 'CALL' ? 'var(--green)' : display.statisticallyQualified && verdict === 'PUT' ? 'var(--red)' : display.informational || display.lowStatisticalConfidence ? 'var(--amber)' : '';
  $('#signalDirection').className = `direction ${dirClass(display.bias)}${display.informational || display.lowStatisticalConfidence ? ' low-confidence' : ''}`;
  $('#signalDirection').textContent = display.label;
  $('#signalSummary').textContent = display.informational
    ? `Sinal de ${display.bias === 'CALL' ? 'compra' : 'venda'} mantido com avaliação baixa. Os filtros não escondem a direção: reduzem a prioridade e deixam o risco explícito. ${display.recordable ? 'O resultado será acompanhado separadamente no histórico.' : display.entryMissed ? 'A janela teórica de entrada já passou; a leitura fica visível, mas não contamina o histórico nem o aprendizado.' : 'Como o dado está atrasado, esta leitura fica visível, mas não contamina o histórico nem o aprendizado.'} Motivo principal: ${primaryDecisionReason(r)}.`
    : display.lowStatisticalConfidence
      ? `O sinal técnico passou pelos filtros principais, mas ainda não tem taxa/EV positivos suficientemente sustentados. Ele fica registrado separadamente para construir uma taxa real. Entrada teórica na próxima vela, expiração em ${expiryText}.`
    : verdict === 'AGUARDAR'
      ? 'As categorias não definiram uma direção útil. Aguardar continua sendo a leitura mais segura neste momento.'
    : `Vela atual em formação + histórico: ${(r.why && r.why[0]) || 'confluência técnica suficiente'}. Entrada na próxima vela e expiração em ${expiryText}; confirme o preço no seu broker antes de agir.`;
  $('#signalScore').textContent = `${r.score.score}/100`;
  $('#signalConfidence').textContent = `Probabilidade: ${probability}`;
  $('#signalPrice').textContent = fmtPrice(r.snapshot.price);
  $('#signalRisk').textContent = risk;
  $('#signalConfluence').textContent = conf;
  $('#signalModel').textContent = r.ml && r.ml.usable ? `Validado · ${fmtPct(r.ml.p * 100)}` : 'Não validado';
  const badges = [
    display.statisticallyQualified ? 'SINAL CONFIRMADO · EV POSITIVO' : display.lowStatisticalConfidence ? 'SINAL TÉCNICO · ESTATÍSTICA FRACA' : display.informational ? 'SINAL MANTIDO · AVALIAÇÃO BAIXA' : 'SEM DIREÇÃO DEFINIDA',
    `Fonte: ${sourceText(r)}`,
    `${r.hasVolume ? 'volume disponível' : 'sem volume confiável'}`,
    'política única',
    r.inProgressCandle ? 'vela atual em formação' : 'vela atual indisponível',
    `expiração: ${expiryText}`,
    r.decision && r.decision.estimate && r.decision.estimate.p !== null ? `empate estimado: ${fmtPct((Number(r.decision.estimate.tieP) || 0) * 100)}` : null,
    freshnessText(r.dataFreshness),
    r.filters && r.filters.news && r.filters.news.status === 'ready' ? `calendário: ${r.filters.news.source || 'atualizado'}` : null,
    `análise: ${new Date(r.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
    estimate && estimate.samples ? `amostra: ${estimate.samples}` : 'sem estimativa estatística'
  ];
  $('#signalBadges').innerHTML = badges.filter(Boolean).map((x, index) => `<span class="badge${index === 0 && (display.informational || display.lowStatisticalConfidence) ? ' badge-warning' : ''}">${escapeHtml(x)}</span>`).join('');
  renderReasons(r); renderDetails(r); renderChart(r); renderModelSummary();
  renderLiveChart(r.asset, r.tfKey); renderNextCandle(r);
}
function renderError(message) {
  state.result = null;
  $('#signalCard').className = 'panel signal-card waiting';
  $('#signalName').textContent = 'Dados indisponíveis'; $('#signalTime').textContent = 'Nenhum candle é inventado.';
  renderFreshness(null);
  $('#signalDirection').className = 'direction neutral'; $('#signalDirection').textContent = 'AGUARDAR';
  $('#signalSummary').textContent = message; $('#signalScore').textContent = '—'; $('#signalConfidence').textContent = 'Confiança: —';
  $('#signalPrice').textContent = '—'; $('#signalRisk').textContent = '—'; $('#signalConfluence').textContent = '—'; $('#signalModel').textContent = 'Sem modelo'; setGradeBadge($('#signalGrade'), null);
  $('#signalBadges').innerHTML = ''; const canvas = $('#chartCanvas'); if (canvas) { const ctx = canvas.getContext('2d'); ctx && ctx.clearRect(0, 0, canvas.width, canvas.height); }
  $('#internalChartTitle').textContent = 'Candles, EMAs e zonas'; $('#chartRange').textContent = 'sem leitura atual';
  $('#reasons').className = 'reason-list empty-state empty-error'; $('#reasons').textContent = message; $('#reasons').setAttribute('aria-busy', 'false'); $('#details').className = 'metric-grid empty-state empty-error'; $('#details').textContent = 'Tente novamente em instantes ou escolha outro ativo.'; $('#details').setAttribute('aria-busy', 'false');
}
function renderReasons(r) {
  const reasons = r.why && r.why.length ? r.why : r.reasons || [];
  $('#reasons').className = 'reason-list';
  $('#reasons').setAttribute('aria-busy', 'false');
  $('#reasons').innerHTML = reasons.map((x, i) => {
    const k = /bloqueio|abaixo|negativa|aguardar|insuficiente|não operar|risco alto|avaliação baixa|cautela|não confirm/i.test(x) ? (i ? 'warn' : 'bad') : 'good';
    return `<div class="reason ${k}">${escapeHtml(x)}</div>`;
  }).join('') || '<div class="empty-state">Sem motivos suficientes.</div>';
}
function renderDetails(r) {
  const s = r.snapshot;
  const filters = r.filters || {};
  const guardText = (guard, fallback = '—') => guard ? (guard.blocked ? `AVALIAÇÃO BAIXA · ${guard.text}` : guard.text) : fallback;
  const rows = [
    ['RSI', s.rsi !== null ? fmt(s.rsi, 1) : '—'], ['MACD', s.macd && s.macd.hist !== null ? fmt(s.macd.hist, 4) : '—'],
    ['Tendência', s.structure ? s.structure.label : '—'], ['ATR', s.atr !== null ? fmtPct(s.atr * 100 / s.price, 2) : '—'],
    ['Volume relativo', s.volume && s.volume.rel !== null ? `${fmt(s.volume.rel, 2)}x` : '—'], ['Score técnico', `${r.score.score}/100`],
    ['Análogos', r.hist && r.hist.samples ? String(r.hist.samples) : 'insuficiente'], ['Fonte', sourceText(r)],
    ['Dados', freshnessText(r.dataFreshness)],
    ['Empate', `${r.decision.tiePolicy === 'refund' ? 'reembolso' : r.decision.tiePolicy === 'win' ? 'acerto' : 'perda (conservador)'} · estimado ${fmtPct((Number(r.decision.tieProbability) || 0) * 100)}`],
    ['Expiração', `${r.expiry && r.expiry.candles || r.decision.expiryCandles || 1} vela(s) · ${r.expiry && r.expiry.reason || r.decision.expiryReason || 'próxima vela'}`],
    ['Pavio (3 velas)', guardText(filters.wick)], ['Zona M15/H1', guardText(filters.htfZone)],
    ['VSA / volume', guardText(filters.vsa)], ['Notícias', guardText(filters.news)], ['Sessões', guardText(filters.session)]
  ];
  $('#details').className = 'metric-grid';
  $('#details').setAttribute('aria-busy', 'false');
  $('#details').innerHTML = rows.map(([a, b]) => `<div class="metric"><span>${escapeHtml(a)}</span><b>${escapeHtml(String(b))}</b></div>`).join('');
}

function renderChart(r) {
  const c = $('#chartCanvas'), ctx = c.getContext('2d');
  const rect = c.getBoundingClientRect(), scale = Math.max(1, window.devicePixelRatio || 1);
  if (!rect.width || !rect.height) return;
  c.width = Math.round(rect.width * scale); c.height = Math.round(rect.height * scale); ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const w = rect.width, h = rect.height, p = { l: 55, r: 12, t: 15, b: 24 }; ctx.clearRect(0, 0, w, h);
  const bars = (r.candles || []).slice(-90); if (!bars.length) return;
  const full = r.candles || [], offset = full.length - bars.length, series = buildSeries(full, { hasVolume: r.hasVolume });
  const emAs = [
    { values: (series.ind.ema9 || []).slice(offset), color: '#7be7ff' },
    { values: (series.ind.ema21 || []).slice(offset), color: '#ffc765' },
    { values: (series.ind.ema50 || []).slice(offset), color: '#ca8cff' }
  ];
  const zones = [r.snapshot && r.snapshot.zones && r.snapshot.zones.nearestSupport, r.snapshot && r.snapshot.zones && r.snapshot.zones.nearestResistance].filter(Boolean);
  const values = bars.flatMap(k => [k.l, k.h]).concat(emAs.flatMap(e => e.values.filter(Number.isFinite))).concat(zones.flatMap(z => [z.low, z.high]));
  let min = Math.min(...values), max = Math.max(...values); const pad = Math.max((max - min) * .08, max * .00003); min -= pad; max += pad;
  const range = Math.max(max - min, max * .00001);
  const y = v => p.t + (max - v) / range * (h - p.t - p.b); const step = (w - p.l - p.r) / bars.length;
  zones.forEach(z => { const support = z.kind === 'suporte'; const top = y(z.high), bottom = y(z.low); ctx.fillStyle = support ? '#42d39b22' : '#f25f7422'; ctx.fillRect(p.l, top, w - p.l - p.r, Math.max(1, bottom - top)); ctx.strokeStyle = support ? '#62e5ac99' : '#ff799099'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(p.l, y(z.mid)); ctx.lineTo(w - p.r, y(z.mid)); ctx.stroke(); ctx.setLineDash([]); });
  ctx.strokeStyle = '#284158'; ctx.lineWidth = 1; ctx.font = '10px system-ui'; ctx.fillStyle = '#7f99b2';
  for (let i = 0; i < 4; i++) { const yy = p.t + i * (h - p.t - p.b) / 3; ctx.beginPath(); ctx.moveTo(p.l, yy); ctx.lineTo(w - p.r, yy); ctx.stroke(); ctx.fillText(fmtPrice(max - range * i / 3), 3, yy + 3); }
  bars.forEach((k, i) => { const x = p.l + step * i + step / 2, up = k.c >= k.o, color = up ? '#48d6a0' : '#f05d72'; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x, y(k.h)); ctx.lineTo(x, y(k.l)); ctx.stroke(); const top = y(Math.max(k.o, k.c)), bh = Math.max(1, Math.abs(y(k.o) - y(k.c))); ctx.fillRect(x - Math.max(1, step * .28), top, Math.max(2, step * .56), bh); });
  emAs.forEach(ema => { ctx.strokeStyle = ema.color; ctx.lineWidth = 1.35; ctx.beginPath(); let started = false; ema.values.forEach((value, i) => { if (!Number.isFinite(value)) return; const x = p.l + step * i + step / 2; if (!started) { ctx.moveTo(x, y(value)); started = true; } else ctx.lineTo(x, y(value)); }); ctx.stroke(); });
  const last = bars[bars.length - 1].c; ctx.strokeStyle = '#c4d9ed77'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(p.l, y(last)); ctx.lineTo(w - p.r, y(last)); ctx.stroke(); ctx.setLineDash([]);
  if (bars[bars.length - 1].live) { ctx.fillStyle = '#c8f8e5'; ctx.font = '9px system-ui'; ctx.fillText('VELA EM FORMAÇÃO', w - 106, p.t + 11); }
  $('#internalChartTitle').textContent = `${r.asset.name} · ${r.tfKey}`; $('#chartRange').textContent = `${bars.length} candles · ${fmtPrice(min)} — ${fmtPrice(max)}`;
}

let tradingViewPending = null;
let tradingViewVisible = false;
function setupTradingViewObserver() {
  const wrap = $('#liveChartWrap');
  if (!wrap) return;
  if (!('IntersectionObserver' in window)) { tradingViewVisible = true; loadPendingTradingView(); return; }
  const observer = new IntersectionObserver(entries => {
    tradingViewVisible = entries.some(entry => entry.isIntersecting);
    if (tradingViewVisible) loadPendingTradingView();
  }, { rootMargin: '240px 0px' });
  observer.observe(wrap);
}
function loadPendingTradingView() {
  if (!tradingViewVisible || !tradingViewPending) return;
  const { asset, tf } = tradingViewPending;
  const symbol = asset.tv || asset.id;
  const host = $('#tradingViewContainer');
  if (!host) return;
  const signature = `${symbol}|${tf}`;
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature; host.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
  const script = document.createElement('script'); script.type = 'text/javascript'; script.async = true;
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.text = JSON.stringify({ autosize: true, symbol, interval: TIMEFRAMES[tf].tv || '5', timezone: 'America/Sao_Paulo', theme: 'dark', style: '1', locale: 'br', allow_symbol_change: true, calendar: false, hide_side_toolbar: true, withdateranges: true, save_image: false, studies: [], support_host: 'https://www.tradingview.com' });
  host.appendChild(script);
}
function renderLiveChart(asset, tf) {
  if (!asset || !TIMEFRAMES[tf]) return;
  tradingViewPending = { asset, tf };
  $('#liveChartTitle').textContent = `${asset.name} · ${tf}`;
  loadPendingTradingView();
}
function renderNextCandle(r = state.result) {
  const tf = TIMEFRAMES[state.tf]; if (!tf) return;
  const now = Date.now(), duration = tf.sec * 1000, next = (Math.floor(now / duration) + 1) * duration, left = Math.max(0, next - now);
  const expiryCandles = Math.max(1, Number(r && r.expiry && r.expiry.candles || r && r.decision && r.decision.expiryCandles || 1));
  const expires = next + expiryCandles * duration;
  const min = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
  $('#nextCandleLabel').textContent = `ENTRADA / EXPIRAÇÃO · ${state.tf}`;
  $('#nextCandleTime').textContent = `entra ${new Date(next).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · fecha ${new Date(expires).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  $('#nextCandleCountdown').textContent = `entrada em ${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')} · expiração de ${expiryCandles} vela${expiryCandles > 1 ? 's' : ''} · horário do seu navegador`;
}
function onClockTick() {
  renderNextCandle(state.result);
  if (state.result && state.result.dataFreshness) {
    // A idade aumenta mesmo sem nova busca, então a UI nunca parece mais nova do que o dado.
    const receivedAt = state.result.dataFreshness.receivedAt || state.result.at || Date.now();
    state.result.dataFreshness.dataAgeMs = Math.max(0, Date.now() - receivedAt);
    renderFreshness(state.result);
  }
  const tf = TIMEFRAMES[state.tf]; if (!tf) return;
  const bucket = Math.floor(Date.now() / (tf.sec * 1000));
  if (state.lastCandleBucket === null) { state.lastCandleBucket = bucket; return; }
  if (bucket === state.lastCandleBucket) return;
  state.lastCandleBucket = bucket;
  scheduleCandleTraining();
}
function scheduleCandleTraining() {
  if (!state.autoRefresh || state.candleTrainQueued) return;
  state.candleTrainQueued = true;
  state.candleTrainTimer = setTimeout(async () => {
    try {
      if (state.analyzing) { state.candleTrainQueued = false; state.candleTrainTimer = setTimeout(scheduleCandleTraining, 5000); return; }
      await analyzeCurrent({ auto: true });
      if (state.training) { state.candleTrainQueued = false; state.candleTrainTimer = setTimeout(scheduleCandleTraining, 5000); return; }
      await trainSelected(true, getAsset(state.assetId), state.tf, { epochs: 140, reason: 'Nova vela fechada: retreino incremental' });
    } finally { state.candleTrainQueued = false; }
  }, 1400);
}

async function trainSelected(force = false, asset = getAsset(state.assetId), tf = state.tf, options = {}) {
  if (!asset || state.training) return null;
  const key = modelKey(asset.id, tf), reg = registry(), previous = activeModel(asset.id, tf);
  if (!force && reg[key] && Date.now() - reg[key].trainedAt < 6 * 3600e3) return previous;
  state.training = true; setButtons();
  const showProgress = () => asset.id === state.assetId && tf === state.tf && !state.analyzing;
  const initialText = `Baixando até ${Number(state.deepCandles).toLocaleString('pt-BR')} candles fechados para treinamento…`;
  if (showProgress()) setStatus(initialText); else $('#automationStatus').textContent = initialText;
  try {
    const trained = await workerRequest('background', 'trainAsset', {
      asset, tfKey: tf, target: Number(state.deepCandles),
      options: { epochs: options.epochs || 350, minValid: MIN_VALIDATION_SAMPLES, progressEvery: 5, zoneLookback: 160 }
    }, message => {
      const text = options.reason && message.stage === 'training' ? `${options.reason} · ${message.text || 'Treinando…'}` : (message.text || 'Preparando treinamento…');
      if (showProgress()) setStatus(text); else $('#automationStatus').textContent = text;
    });
    const candidate = trained.model;
    // Não comparamos Brier de janelas diferentes por uma margem fixa: isso não
    // é um teste estatístico válido. Cada candidato só entra se superar a taxa
    // base no MESMO holdout cronológico com margem baseada no erro-padrão.
    const adopt = candidate.ok && candidate.usable && !candidate.overfit && candidate.validationPolicyVersion === VALIDATION_POLICY_VERSION && candidate.featureSchemaVersion === FEATURE_SCHEMA_VERSION && Number.isFinite(Number(candidate.tieRate));
    if (adopt) {
      persistModel(key, candidate); reg[key] = { trainedAt: candidate.trainedAt, samples: candidate.samples, brier: candidate.validMetrics.brier, usable: true }; persistRegistry(reg);
      const text = `Modelo atualizado · Brier ${candidate.validMetrics.brier.toFixed(4)} em ${candidate.validMetrics.n} candles de validação.`;
      if (showProgress()) setStatus(text); else $('#automationStatus').textContent = text;
    } else if (candidate.ok) {
      const why = candidate.overfit ? 'sinais de sobreajuste' : candidate.usable ? 'política de validação incompatível' : 'não passou nas travas de validação';
      const text = `Modelo novo não adotado (${why}); o modelo anterior foi preservado.`;
      if (showProgress()) setStatus(text); else $('#automationStatus').textContent = text;
    } else {
      const text = `Treino não concluído: ${candidate.reason}`;
      if (showProgress()) setStatus(text); else $('#automationStatus').textContent = text;
    }
    renderModelSummary(); return adopt ? candidate : previous;
  } catch (err) {
    const text = `Treino não concluído: ${err.message}`;
    if (showProgress()) setStatus(text); else $('#automationStatus').textContent = text;
    return previous;
  } finally { state.training = false; setButtons(); }
}
function renderModelSummary() {
  const m = activeModel(); const host = $('#modelSummary');
  const activeExpiry = Math.max(1, Number(state.result && state.result.expiry && state.result.expiry.candles || 1));
  const calibration = state.thresholdCalibrations && state.thresholdCalibrations[setupScope(state.assetId, state.tf, activeExpiry)];
  const calibrationMatchesCost = calibration && Math.abs((Number(calibration.operationCost) || 0) - (Number(state.operationCost) || 0)) <= 0.000001;
  const calibrationMatchesPolicy = calibration && calibration.policySignature === filterPolicySignature(cfg());
  const calibrationText = calibration
    ? (calibration.accepted
      ? (calibrationMatchesCost && calibrationMatchesPolicy ? `Limiar local ${calibration.threshold} confirmado em ${new Date(calibration.selectedAt).toLocaleDateString('pt-BR')}.` : 'Limiar local pausado: o custo ou a política de filtros mudou; rode novo backtest.')
      : `Última calibração não aplicada: ${calibration.reason}`)
    : 'Sem limiar local confirmado ainda.';
  if (!m || !m.ok) { host.className = 'model-summary'; host.innerHTML = `<span class="model-dot"></span><div><b>Nenhum modelo validado</b><p>Treine com dados históricos para calibrar a probabilidade local. ${escapeHtml(calibrationText)}</p></div>`; }
  else {
    const q = m.validMetrics || {}; const usable = m.usable && !m.overfit;
    host.className = `model-summary ${usable ? 'valid' : ''}`;
    const accuracy = Number.isFinite(q.acc) ? `${fmtPct(q.acc * 100)} · referência aleatória 50%` : 'taxa ainda não disponível';
    const policy = m.validationPolicyVersion === VALIDATION_POLICY_VERSION && m.featureSchemaVersion === FEATURE_SCHEMA_VERSION ? `validação rigorosa: mínimo ${m.minValid || MIN_VALIDATION_SAMPLES} candles, ganho Brier acima do erro-padrão e empate separado` : 'versão anterior de validação/indicadores: retreino necessário';
    const stamp = m.trainedAt ? `<time class="validation-stamp" datetime="${new Date(m.trainedAt).toISOString()}">Última validação do modelo: ${escapeHtml(new Date(m.trainedAt).toLocaleString('pt-BR'))}</time>` : '<span class="validation-stamp">Última validação: sem data</span>';
    const horizonNote = activeExpiry > 1 ? ` · E${activeExpiry}: este modelo E1 não participa da estimativa` : '';
    const tieText = Number.isFinite(Number(m.tieRate)) ? ` · empates observados ${fmtPct(Number(m.tieRate) * 100)}` : ' · empate ainda não medido';
    host.innerHTML = `<span class="model-dot"></span><div><b>${usable ? 'Modelo local validado' : 'Modelo local em observação'}</b><p>${m.samples || '—'} exemplos direcionais${tieText} · Brier ${q.brier !== null && q.brier !== undefined ? q.brier.toFixed(4) : '—'} · acerto na validação ${accuracy} · ${policy}${escapeHtml(horizonNote)} · ${escapeHtml(calibrationText)}</p>${stamp}</div>`;
  }
  renderFeedbackSummary();
}

function opportunityProfile(r) {
  const display = displaySignal(r);
  const directional = display.bias === 'CALL' || display.bias === 'PUT';
  const signalApproved = !!(display.approved && r.decision && r.decision.eligibleWithoutScore);
  const safetyEligible = !!(directional && r && r.decision && !r.decision.blocked && r.decision.eligibleWithoutScore);
  const hasNegativeEv = !!(r && r.decision && r.decision.ev !== null && r.decision.ev !== undefined && Number.isFinite(Number(r.decision.ev)) && Number(r.decision.ev) <= 0);
  const estimate = r && r.decision && r.decision.estimate;
  const samples = Math.max(0, Number(estimate && estimate.samples) || 0);
  const hasFiniteRate = !!(estimate && estimate.p !== null && estimate.p !== undefined && Number.isFinite(Number(estimate.p)));
  const rawRate = hasFiniteRate ? Math.max(0, Math.min(100, Number(estimate.p) * 100)) : null;
  // Um sinal de avaliação baixa com EV estatístico negativo ou sem taxa
  // mensurável continua auditável, mas não recebe o selo de confirmado.
  const verdictApproved = signalApproved && display.statisticallyQualified && !hasNegativeEv && rawRate !== null;
  // Quando há intervalo de confiança, o ranking usa a ponta inferior; quando a
  // fonte é um modelo validado sem IC, usa sua probabilidade apenas depois do
  // gate de Brier e aplica o peso da amostra. Sem estatística, não inventa 50%.
  const hasLowerBound = !!(estimate && estimate.ciLow !== null && estimate.ciLow !== undefined && Number.isFinite(Number(estimate.ciLow)));
  const lowerRate = hasLowerBound ? Math.max(0, Math.min(100, Number(estimate.ciLow) * 100)) : rawRate;
  const evidenceWeight = rawRate === null ? 0 : Math.min(1, samples / 100);
  const conservativeRate = rawRate === null ? null : 50 + ((lowerRate ?? rawRate) - 50) * evidenceWeight;
  const technical = Math.max(0, Math.min(100, Number(r && r.score && r.score.score) || 0));
  const grade = r && r.grade && r.grade.grade || 'C';
  const gradeScore = ({ 'A+': 100, A: 90, B: 78, C: 58, D: 42 })[grade] || 42;
  const confluence = r && r.score && r.score.confluence || {};
  const confluenceScore = confluence.total ? Math.max(0, Math.min(100, Number(confluence.agree || 0) / Math.max(1, Number(confluence.total)) * 100)) : 50;
  // A força exibida é uma média técnica transparente: score 55%, nota 25% e
  // confluência 20%. A taxa fica separada para que o usuário não confunda uma
  // estatística com força de gráfico.
  const forceAverage = technical * 0.55 + gradeScore * 0.25 + confluenceScore * 0.20;
  const evidenceScore = Math.min(100, samples);
  // Ranking geral: força média 55%, taxa conservadora 35% e robustez de amostra
  // 10%. Com pouco N, a taxa já é encolhida em direção a 50% acima.
  const overall = verdictApproved
    ? forceAverage * 0.55 + conservativeRate * 0.35 + evidenceScore * 0.10
    : directional
      ? forceAverage * 0.65 + (conservativeRate ?? 50) * 0.25 + evidenceScore * 0.10 - (r && r.decision && r.decision.blocked ? 12 : 5)
      : -Infinity;
  const tier = verdictApproved ? 3 : display.approved ? 2 : directional ? 1 : 0;
  return { approved: verdictApproved, signalApproved, safetyEligible, directional, tier, display, hasNegativeEv, overall, forceAverage, grade, gradeScore, technical, confluenceScore, evidenceScore, samples, rawRate, lowerRate, conservativeRate, estimate };
}
function updateScannerProgress({ current = 0, total = 0, assetName = '', text = '', at = Date.now(), started = null, stateName = null } = {}) {
  const hasStarted = started === null ? (state.scannerProgress.started || total > 0 || current > 0) : !!started;
  state.scannerProgress = { current, total, assetName, updatedAt: at, started: hasStarted };
  const readable = !hasStarted ? 'Aguardando primeira varredura…' : (text || (total ? `Analisando ${assetName || 'ativo'} — ativo ${current} de ${total}` : 'Preparando scanner…'));
  const scanStatus = $('#scanStatus'); if (scanStatus) scanStatus.textContent = readable;
  const progressText = $('#scannerProgressCurrent'); if (progressText) progressText.textContent = readable;
  const count = $('#scannerProgressCount'); if (count) { count.hidden = !hasStarted || !total; count.textContent = total ? `${current} de ${total} ativos` : ''; }
  const lastUpdated = $('#scannerLastUpdated'); if (lastUpdated) { lastUpdated.textContent = fmtTime(at); lastUpdated.dateTime = new Date(at).toISOString(); }
  const track = $('#scannerProgressTrack'); const percent = total ? Math.min(100, Math.round(current / total * 100)) : 0;
  const resolvedState = stateName || (!hasStarted ? 'idle' : (current >= total && total ? 'complete' : 'running'));
  if (track) { track.setAttribute('aria-valuenow', String(percent)); track.setAttribute('aria-valuetext', resolvedState === 'error' ? `Scanner com falha: ${readable}` : (hasStarted && total ? `${current} de ${total} ativos` : 'Scanner aguardando primeira varredura')); }
  const bar = $('#scannerProgressBar'); if (bar) bar.style.width = `${percent}%`;
  const box = $('#scannerProgress'); if (box) box.dataset.state = resolvedState;
}
async function scanMarket(manual = false) {
  if (state.scanning) return;
  const list = universe(state.scanMarket).slice(0, Number(state.scanCount));
  if (!list.length) return;
  state.scanning = true;
  state.scannerPromotedKey = null;
  setButtons();
  renderScanner([], { pendingAssets: list });
  updateScannerProgress({ total: list.length, text: 'Preparando consulta dos ativos…', started: true });
  const models = {};
  const partialRows = new Map();
  const feedbackChanged = new Set();
  let finishedList = null;
  for (const asset of list) { const model = activeModel(asset.id, state.tf); if (model) models[modelKey(asset.id, state.tf)] = model; }
  try {
    // A lista que recebe o selo de melhor oportunidade precisa usar exatamente
    // a mesma janela efetiva de cálculo da análise aberta. O Worker mantém a UI
    // livre mesmo nessa varredura completa; uma triagem curta poderia reordenar
    // o topo quando o usuário abrisse o ativo.
    const payload = await workerRequest('background', 'scan', {
      assets: list, tfKey: state.tf, settings: cfg(), models,
      setupRankings: state.setupRankingReal, calendarSnapshot: state.calendarSnapshot,
      // 3.000 candles mantêm a análise multi-timeframe e a janela estatística
      // sem repetir até 10.000 candles para cada item da lista. Ao abrir a linha,
      // a UI reutiliza exatamente esta fotografia; "Analisar agora" continua
      // sendo a coleta profunda com todo o histórico configurado.
      light: false, historyTarget: 3000, scanConcurrency: 3, returnFull: true, includeLive: true
    }, message => {
      const assetName = message.assetName || getAsset(message.assetId || '')?.name || '';
      const completed = Number.isFinite(Number(message.completed)) ? Number(message.completed) : Number(message.index);
      updateScannerProgress({ current: Number.isFinite(completed) ? completed : state.scannerProgress.current, total: message.total || list.length, assetName, text: message.text || '', at: message.at || Date.now() });
      const partial = message.partialRow;
      if (partial && partial.asset && partial.result && !partial.result.dataError && partial.result.snapshot) {
        partial.result.scanCompletedAt = Number(message.at) || Date.now();
        partialRows.set(partial.asset.id, partial);
        const visible = [...partialRows.values()].sort(compareOpportunityRows);
        state.scannerRows = visible;
        const pendingAssets = list.filter(asset => !partialRows.has(asset.id));
        renderScanner(visible, { pendingAssets });

        // Cada leitura passa a existir no instante em que aparece na lista.
        // Isso mantém o histórico prospectivo mesmo se as demais fontes ainda
        // estiverem respondendo ou se uma delas falhar no fim do ciclo.
        for (const key of settleLearningRecords(partial.result)) feedbackChanged.add(key);
        recordSignal(partial.result, { origin: 'scanner-emitted', rankEligible: true });
        promoteBestOpportunity(visible);
      }
    });
    const rows = (payload.rows || []).filter(row => row && row.result && !row.result.dataError && row.result.snapshot);
    for (const row of rows) {
      row.result.scanCompletedAt = row.result.scanCompletedAt || row.result.at || payload.completedAt || Date.now();
      if (row.result.calendarSnapshot && Array.isArray(row.result.calendarSnapshot.events)) {
        state.calendarSnapshot = row.result.calendarSnapshot;
        if (state.persistenceReady) queuePersist(() => setKv('signal_atlas_calendar_v1', row.result.calendarSnapshot));
      }
      for (const key of settleLearningRecords(row.result)) feedbackChanged.add(key);
      // O scanner publica a linha prospectivamente antes do desfecho. Por isso
      // ela pode aprender depois que a vela fechar, sem qualquer backfill.
      recordSignal(row.result, { origin: 'scanner-emitted', rankEligible: true });
    }
    rows.sort(compareOpportunityRows);
    state.scannerRows = rows; renderScanner(rows);
    promoteBestOpportunity(rows);
    updateScannerProgress({ current: list.length, total: list.length, text: `${rows.length}/${list.length} ativos com dados · atualizado ${fmtTime(Date.now())}` });
    queueFeedbackRetrains([...feedbackChanged]);
    finishedList = list;
  } catch (error) {
    if (error && error.name !== 'AbortError') {
      updateScannerProgress({ total: list.length, text: `Scanner indisponível: ${error.message}`, stateName: 'error' });
      $('#scannerRows').innerHTML = `<tr><td colspan="7" class="empty-row empty-error">Scanner indisponível: ${escapeHtml(error.message)}</td></tr>`;
    }
  } finally {
    state.scanning = false; setButtons();
    if (finishedList) setTimeout(() => resolvePendingHistory(), 0);
    if (state.autoScan && finishedList && finishedList.length) backgroundLearn(finishedList);
    if (manual) updateAutomationStatus();
  }
}
function compareOpportunityRows(a, b) {
  const pa = opportunityProfile(a.result), pb = opportunityProfile(b.result);
  return (pb.tier - pa.tier) || (pb.overall - pa.overall) || ((pb.conservativeRate ?? -1) - (pa.conservativeRate ?? -1)) || (pb.samples - pa.samples) || (pb.technical - pa.technical);
}
function promoteBestOpportunity(rows) {
  const top = (Array.isArray(rows) ? rows : []).find(row => opportunityProfile(row.result).directional);
  if (!top || !top.asset || !top.result) return;
  const snapshotAt = Number(top.result.scanCompletedAt || top.result.at || Date.now());
  const promotionKey = `${top.asset.id}|${top.result.tfKey}|${snapshotAt}`;
  if (state.scannerPromotedKey === promotionKey) return;
  const ranked = rankedOpportunitySnapshot(rows, top.asset.id, top.result.tfKey, snapshotAt);
  if (!ranked || !ranked.result) return;

  state.scannerPromotedKey = promotionKey;
  state.assetId = top.asset.id;
  state.tf = top.result.tfKey;
  syncControls();
  saveSettings();
  state.result = ranked.result;
  renderAnalysis(ranked.result);
  setStatus(`Melhor oportunidade do scanner atualizada: ${top.asset.name} · ${signalLabel(displaySignal(top.result).bias)} · análise de ${fmtTime(snapshotAt)}.`);
}
function renderScanner(rows, { pendingAssets = [] } = {}) {
  const body = $('#scannerRows');
  if (!rows.length && !pendingAssets.length) { body.innerHTML = '<tr><td colspan="7" class="empty-row empty-no-data">Nenhuma fonte respondeu com candles suficientes neste ciclo.</td></tr>'; return; }
  const completedHtml = rows.map(({ asset, result: r }, i) => {
    const profile = opportunityProfile(r);
    const side = dirClass(profile.display.bias);
    const reason = profile.hasNegativeEv
      ? 'EV líquido negativo: leitura somente informativa'
      : !profile.approved && r.decision && r.decision.reasons && r.decision.reasons.length
        ? primaryDecisionReason(r)
        : (r.why && r.why[0]) || 'sem leitura';
    const best = i === 0 && profile.approved;
    const bestTechnical = i === 0 && !profile.approved && profile.display.approved;
    const bestLow = i === 0 && !profile.approved && !profile.display.approved && profile.directional;
    const analyzedAt = Number(r.scanCompletedAt || r.at || Date.now());
    const updated = fmtTime(analyzedAt);
    const fresh = r.dataFreshness;
    const freshness = fresh ? `${durationLabel(fresh.dataAgeMs)} · ${fresh.blocked ? 'AVALIAÇÃO BAIXA' : `lat. ${durationLabel(fresh.latencyMs)}`}` : updated;
    const expiry = r.expiry && r.expiry.candles || r.decision && r.decision.expiryCandles || 1;
    const rateText = profile.rawRate === null ? 'sem taxa validada' : fmtPct(profile.rawRate);
    const rateDetail = profile.rawRate === null
      ? 'fica abaixo de sinais com amostra'
      : `${profile.estimate && profile.estimate.ciLow !== null && profile.estimate.ciLow !== undefined ? `IC95% ≥ ${fmtPct(profile.lowerRate)}` : 'modelo validado'} · N=${profile.samples || '—'}`;
    const shownSignal = profile.directional ? signalLabel(profile.display.bias) : 'AGUARDAR';
    const rankBadge = best
      ? `<span class="scanner-best">${state.scanning ? 'MELHOR ATÉ AGORA' : 'MELHOR OPORTUNIDADE'}</span>`
      : bestTechnical
        ? '<span class="scanner-best scanner-best-low">MELHOR SINAL TÉCNICO · ESTATÍSTICA FRACA</span>'
        : bestLow
          ? '<span class="scanner-best scanner-best-low">MELHOR SINAL DISPONÍVEL · AVALIAÇÃO BAIXA</span>'
          : '';
    const rateClass = profile.rawRate === null ? 'side-neutral' : profile.rawRate >= 50 ? 'side-buy' : 'side-sell';
    const qualityText = profile.approved ? 'confirmado' : profile.display.approved ? 'sinal técnico' : profile.directional ? `avaliação baixa${profile.display.recordable ? '' : ' · somente visível'}` : 'sem direção';
    return `<tr class="${best ? 'rank-best' : bestTechnical || bestLow ? 'rank-bias' : ''}"><td data-label="Ativo"><b>${escapeHtml(asset.name)}</b>${rankBadge}<br><span class="muted">#${i + 1} · ${r.tfKey} · E${expiry} · preço ${fmtPrice(r.snapshot.price)}</span></td><td data-label="Sinal / nota" class="side-${side}">${escapeHtml(shownSignal)}<small class="scanner-grade">${qualityText} · nota ${escapeHtml(profile.grade)}</small></td><td data-label="Força média"><b>${fmt(profile.forceAverage, 1)}</b>/100<small class="benchmark">técnica ${r.score.score} · confluência ${fmt(profile.confluenceScore, 0)}</small></td><td data-label="Taxa estimada / amostra" class="${rateClass}"><b>${escapeHtml(rateText)}</b><small class="benchmark">${escapeHtml(rateDetail)}</small></td><td data-label="Leitura" title="${escapeHtml(reason)}">${escapeHtml(reason.slice(0, 44))}${reason.length > 44 ? '…' : ''}</td><td data-label="Última análise" class="${fresh && fresh.blocked ? 'data-stale' : ''}"><time datetime="${new Date(analyzedAt).toISOString()}">${escapeHtml(updated)}</time><small class="benchmark">${escapeHtml(freshness)}</small></td><td data-label="Ação"><button class="row-action" data-open="${asset.id}" data-tf="${r.tfKey}">Abrir análise</button></td></tr>`;
  }).join('');
  const pendingHtml = pendingAssets.map(asset => `<tr class="scanner-pending-row"><td data-label="Ativo"><b>${escapeHtml(asset.name)}</b><small class="benchmark">aguardando processamento</small></td><td data-label="Sinal / nota" colspan="4"><span class="scanner-row-loader" aria-hidden="true"></span> Analisando candles e validações…</td><td data-label="Última análise">—</td><td data-label="Ação"><button class="row-action" type="button" disabled>Processando</button></td></tr>`).join('');
  body.innerHTML = completedHtml + pendingHtml;
}
async function backgroundLearn(list) {
  if (state.training || state.scanning) return;
  const asset = list[state.learningCursor++ % list.length];
  $('#automationStatus').textContent = `Scanner concluído. Próximo aprendizado local: ${asset.name}.`;
  // Um ativo rotativo é recalibrado a cada ciclo. A troca só acontece se a
  // validação cronológica melhorar, portanto repetir o treino não substitui
  // automaticamente um modelo saudável por um pior.
  await trainSelected(true, asset, state.tf, { epochs: 140, reason: `Aprendizado automático: ${asset.name}` });
  updateAutomationStatus();
}

function scheduleRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  if (!state.autoRefresh) return;
  state.refreshTimer = setTimeout(() => analyzeCurrent({ auto: true }), Math.max(30, Number(state.refreshEvery)) * 1000);
}
function scheduleScanner() {
  if (state.scanTimer) clearTimeout(state.scanTimer);
  if (!state.autoScan) return;
  state.scanTimer = setTimeout(() => scanMarket(), Math.max(90, Number(state.scanEvery)) * 1000);
}
function updateAutomationStatus() {
  if (state.scanning) return;
  const arr = [];
  arr.push(state.autoRefresh ? `sinal atual a cada ${Math.round(state.refreshEvery / 60)} min` : 'sinal atual manual');
  arr.push(state.autoScan ? `scanner a cada ${Math.round(state.scanEvery / 60)} min + treino rotativo` : 'scanner manual');
  arr.push(state.autoRefresh ? 'retreino do ativo aberto a cada vela fechada' : 'retreino por vela pausado');
  $('#automationStatus').textContent = arr.join(' · ') + '. Funciona enquanto esta aba estiver aberta.';
}

async function runCurrentBacktest() {
  if (state.backtesting) return;
  const asset = getAsset(state.assetId); state.backtesting = true; setButtons();
  $('#backtestResult').textContent = 'Preparando backtest causal com candles históricos…';
  try {
    const maxTests = Math.min(1800, Math.max(900, Math.round(Number(state.deepCandles || 10000) * 0.16)));
    // A calibração começa sem limiares antigos; reutilizá-los no replay faria a
    // seleção atual herdar decisões treinadas no mesmo histórico.
    const backtestCfg = { ...cfg(), thresholds: {} };
    const result = await workerRequest('background', 'backtest', {
      asset, tfKey: state.tf, settings: backtestCfg, options: { maxTests }
    }, message => { if (message.text) $('#backtestResult').textContent = message.text; });
    const s = result.stats;
    state.setupRankingBacktest = { ...(state.setupRankingBacktest || {}), ...(result.setupRankingBacktest || {}) };
    const nextCalibrations = { ...(state.thresholdCalibrations || {}) };
    const nextThresholds = { ...(state.thresholds || {}) };
    const calibrationLines = [];
    let anySelected = false;
    for (const expiryCandles of [1, 2, 3]) {
      const sw = result.sweepByExpiry && result.sweepByExpiry[expiryCandles] || (expiryCandles === 1 ? result.sweep : null);
      if (!sw) continue;
      const scope = setupScope(asset.id, state.tf, expiryCandles);
      const selected = sw.best, candidate = sw.bestCandidate;
      // Sem uma agenda econômica histórica versionada, o backtest não pode
      // reproduzir a população de sinais filtrada por notícias ao vivo. O
      // resultado continua educativo, mas não transfere limiar ao sinal real.
      const newsTransferable = !result.meta.newsHistoricalUnavailable || backtestCfg.newsFilter === false;
      const zoneCoverage = result.meta.zoneCoverage || { required: false, sufficient: true, eligible: 0, covered: 0, ratio: null, minimum: 0.95 };
      const zoneTransferable = !zoneCoverage.required || zoneCoverage.sufficient === true;
      const transferable = newsTransferable && zoneTransferable;
      const accepted = !!selected && transferable;
      const calibration = {
        scope, assetId: asset.id, tf: state.tf, expiryCandles, selectedAt: Date.now(), source: 'walk-forward',
        candles: result.meta.candles, minCalibrationSignals: sw.minCalibrationSignals,
        minValidationSignals: sw.minValidationSignals, operationCost: sw.operationCost,
        policySignature: result.meta.filterPolicySignature,
        accepted, transferable, newsTransferable, zoneTransferable, zoneCoverage, threshold: selected ? selected.threshold : null,
        candidateThreshold: candidate ? candidate.threshold : null,
        selectionStats: candidate ? candidate.calibration : null,
        validationStats: candidate ? candidate.validation : null,
        reason: !selected
          ? (candidate ? 'não aplicado: a validação recente não confirmou EV líquido positivo com amostra mínima' : 'não aplicado: nenhum limiar teve EV líquido positivo e amostra mínima no período antigo')
          : !newsTransferable && !zoneTransferable
            ? 'não aplicado: o replay não contém calendário econômico histórico e a cobertura de zonas M15/H1 ficou abaixo de 95%'
            : !newsTransferable
              ? 'não aplicado: o replay não contém calendário econômico histórico; usar este limiar junto do filtro de notícias seria estatisticamente inconsistente'
              : !zoneTransferable
                ? 'não aplicado: a cobertura temporal de zonas fechadas M15/H1 ficou abaixo de 95% das barras direcionais; o limiar não é transferível'
            : 'aplicado após validação recente independente'
      };
      nextCalibrations[scope] = calibration;
      if (accepted) { nextThresholds[scope] = selected.threshold; anySelected = true; }
      else delete nextThresholds[scope];
      if (state.persistenceReady) queuePersist(() => savePersistedThresholdCalibration(scope, calibration));
      calibrationLines.push(accepted
        ? `E${expiryCandles}: limiar ${selected.threshold}, confirmado em ${selected.validation.signals} sinais recentes.`
        : `E${expiryCandles}: não aplicado (${calibration.reason}).`);
    }
    state.thresholdCalibrations = nextCalibrations;
    state.thresholds = nextThresholds;
    saveSettings(); renderModelSummary();
    const byExpiry = [1, 2, 3].map(expiryCandles => {
      const stat = result.statsByExpiry && result.statsByExpiry[expiryCandles];
      if (!stat) return '';
      return `<div><span>E${expiryCandles} · sinais</span><b>${stat.valid}</b><small>${stat.rate === null ? '—' : `${fmtPct(stat.rate)} · ${stat.ties || 0} empate(s) · ref. 50%`}</small></div>`;
    }).join('');
    const tieRule = s.tiePolicy === 'refund' ? 'empate reembolsado' : s.tiePolicy === 'win' ? 'empate contado como acerto' : 'empate contado como perda';
    const calendarNote = result.meta.newsHistoricalUnavailable ? 'Como não há agenda econômica histórica versionada para esta regra, o limiar de Forex fica apenas como referência e não é transferido ao vivo.' : 'A regra de notícias não se aplica a este ativo, então o limiar pode ser avaliado normalmente.';
    const coverage = result.meta.zoneCoverage;
    const coverageNote = coverage && coverage.required
      ? `Cobertura de zonas fechadas M15/H1: ${coverage.ratio === null ? 'sem barras direcionais suficientes' : `${fmtPct(coverage.ratio * 100)} (${coverage.covered}/${coverage.eligible})`}. ${coverage.sufficient ? 'Atingiu o mínimo de 95% para transferência.' : 'Abaixo de 95%; o limiar fica apenas como referência.'}`
      : 'Cobertura de zonas M15/H1 não é exigida pela política atual.';
    $('#backtestResult').innerHTML = `<div class="backtest-stats">${byExpiry || `<div><span>Sinais avaliados</span><b>${s.valid}</b></div>`}</div><p><strong>Economia simulada:</strong> sem custo adicional · ${escapeHtml(tieRule)} · equilíbrio líquido ${fmtPct(s.breakEven)}.</p><p><strong>Calibração ${escapeHtml(asset.name)} ${state.tf}:</strong> ${escapeHtml(calibrationLines.join(' '))}</p><p><strong>Contexto de zonas:</strong> ${escapeHtml(coverageNote)}</p><p>As expirações E1, E2 e E3 foram medidas e calibradas separadamente, incluindo empates no denominador e no EV. O ranking de setups deste backtest é uma referência hipotética separada; ele não aumenta nem reduz o grade do sinal ao vivo. O modelo local foi desativado neste replay para não vazar dados futuros. ${escapeHtml(calendarNote)} Referência: uma escolha aleatória teria 50% de acerto esperado. Fonte: ${escapeHtml(result.meta.source)} · ${result.meta.candles} candles. Resultado histórico não garante desempenho futuro.</p>`;
    if (anySelected && asset.id === state.assetId && state.tf === result.meta.tfKey) analyzeCurrent({ auto: true });
  } catch (err) { $('#backtestResult').textContent = `Backtest indisponível: ${err.message}`; }
  finally { state.backtesting = false; setButtons(); }
}
function feedbackStats(assetId = state.assetId, tf = state.tf) {
  const all = feedbackLedger().filter(x => x.asset === assetId && x.tf === tf);
  const resolved = all.filter(x => ['ACERTO', 'ERRO', 'NEUTRO'].includes(x.outcome));
  const hits = resolved.filter(x => x.outcome === 'ACERTO').length;
  const ties = resolved.filter(x => x.outcome === 'NEUTRO').length;
  return { all, resolved, hits, ties, errors: resolved.length - hits - ties, pending: all.filter(x => x.outcome === 'PENDENTE').length, rate: resolved.length ? hits / resolved.length * 100 : null };
}
function renderHistory() {
  const filter = $('#historyFilter'), overview = $('#historyOverview'), body = $('#historyRows');
  if (!filter || !overview || !body) return;
  const rawLedger = feedbackLedger();
  const partition = partitionVisibleGradeHistory(rawLedger);
  const all = partition.visible;
  const assetIds = [...new Set(all.map(x => x.asset))].sort((a, b) => (getAsset(a)?.name || a).localeCompare(getAsset(b)?.name || b));
  const previous = filter.value || 'all'; const signature = assetIds.join('|');
  if (filter.dataset.signature !== signature) {
    filter.dataset.signature = signature;
    filter.innerHTML = '<option value="all">Todos os ativos</option>' + assetIds.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(getAsset(id)?.name || id)}</option>`).join('');
    filter.value = assetIds.includes(previous) ? previous : 'all';
  }
  const entries = filter.value === 'all' ? all : all.filter(x => x.asset === filter.value);
  const internalOnly = filter.value === 'all' ? partition.internalOnly : partition.internalOnly.filter(x => x.asset === filter.value);
  const resolved = entries.filter(x => ['ACERTO', 'ERRO', 'NEUTRO'].includes(x.outcome));
  const hits = resolved.filter(x => x.outcome === 'ACERTO').length, ties = resolved.filter(x => x.outcome === 'NEUTRO').length, errors = resolved.length - hits - ties, pending = entries.filter(x => x.outcome === 'PENDENTE').length;
  const qualified = entries.filter(isOperationalHistoryEntry).length;
  const lowQuality = entries.filter(x => signalQualityCode(x.quality) === 'BAIXA').length;
  overview.innerHTML = `<div><span>Sinais A/A+ resolvidos</span><b>${resolved.length}</b></div><div><span>Taxa observada · ref. 50%</span><b>${resolved.length ? `${fmtPct(hits / resolved.length * 100)} · 50%` : '— · 50%'}</b></div><div><span>Acertos / erros / empates</span><b>${hits} / ${errors} / ${ties}</b></div><div><span>Qualificados · baixa · internos</span><b>${qualified} · ${lowQuality} · ${internalOnly.length}</b><small>${pending} A/A+ aguardando</small></div>`;
  const groups = new Map();
  for (const entry of entries) {
    const expiryCandles = Number(entry.expiryCandles || 1);
    const quality = signalQualityCode(entry.quality);
    const grade = normalizeOperationalGrade(entry.grade);
    const key = `${entry.asset}|${entry.tf}|${entry.verdict}|E${expiryCandles}|${grade}|${quality}`;
    if (!groups.has(key)) groups.set(key, { asset: entry.asset, tf: entry.tf, verdict: entry.verdict, expiryCandles, grade, quality, entries: [] });
    groups.get(key).entries.push(entry);
  }
  const rows = [...groups.values()].map(g => {
    const done = g.entries.filter(x => ['ACERTO', 'ERRO', 'NEUTRO'].includes(x.outcome));
    const win = done.filter(x => x.outcome === 'ACERTO').length, ties = done.filter(x => x.outcome === 'NEUTRO').length, loss = done.length - win - ties;
    const lastResolved = latestResolvedRecord(g.entries);
    const pending = g.entries.filter(x => x.outcome === 'PENDENTE').length;
    return { ...g, done: done.length, win, loss, ties, pending, rate: done.length ? win / done.length * 100 : null, lastResolved };
  }).sort((a, b) => (a.grade === 'A+' ? -1 : 0) - (b.grade === 'A+' ? -1 : 0) || b.done - a.done || (b.rate || -1) - (a.rate || -1) || (getAsset(a.asset)?.name || a.asset).localeCompare(getAsset(b.asset)?.name || b.asset));
  if (!rows.length) { body.innerHTML = '<tr><td colspan="9" class="empty-row empty-awaiting">Ainda não há sinais A ou A+ congelados antes da entrada. Os demais continuam sendo avaliados internamente.</td></tr>'; return; }
  body.innerHTML = rows.map(g => {
    const last = g.lastResolved;
    const outcomeClass = !last ? 'pending' : last.outcome === 'ACERTO' ? 'win' : last.outcome === 'ERRO' ? 'loss' : 'tie';
    const outcomeLabel = !last ? 'Aguardando resultado' : last.outcome === 'ACERTO' ? 'Acerto' : last.outcome === 'ERRO' ? 'Erro' : 'Neutro';
    const outcomeTime = last ? fmtTime(last.resolvedAt || last.expiresAt || last.createdAt || last.t) : '';
    const pendingLabel = g.pending ? `${g.pending} pendente${g.pending > 1 ? 's' : ''}` : 'nenhum pendente';
    return `<tr><td data-label="Ativo"><b>${escapeHtml(getAsset(g.asset)?.name || g.asset)}</b></td><td data-label="Tempo">${escapeHtml(g.tf)}</td><td data-label="Expiração">${g.expiryCandles} vela${g.expiryCandles > 1 ? 's' : ''}</td><td data-label="Sinal" class="side-${dirClass(g.verdict)}">${escapeHtml(signalLabel(g.verdict))}<small class="signal-quality">nota ${escapeHtml(g.grade)} · ${escapeHtml(signalQualityLabel(g.quality))}</small></td><td data-label="Resolvidos">${g.done}<small class="benchmark">${escapeHtml(pendingLabel)}</small></td><td data-label="Acertos" class="side-buy">${g.win}</td><td data-label="Erros / empates" class="side-sell">${g.loss} / ${g.ties}</td><td data-label="Taxa"><b>${g.rate === null ? '—' : fmtPct(g.rate)}</b><small class="benchmark">ref. 50% · empates inclusos</small></td><td data-label="Último resultado"><span class="outcome-badge ${outcomeClass}">${escapeHtml(outcomeLabel)}</span>${outcomeTime ? `<small class="benchmark">resolvido ${escapeHtml(outcomeTime)}</small>` : `<small class="benchmark">fecha após E${g.expiryCandles}</small>`}</td></tr>`;
  }).join('');
}
function renderFeedbackSummary() {
  const host = $('#learningFeedback'); if (!host) return;
  const raw = feedbackStats();
  const visibleRows = raw.all.filter(isVisibleGradeHistoryEntry);
  const resolved = visibleRows.filter(x => ['ACERTO', 'ERRO', 'NEUTRO'].includes(x.outcome));
  const hits = resolved.filter(x => x.outcome === 'ACERTO').length;
  const ties = resolved.filter(x => x.outcome === 'NEUTRO').length;
  const errors = resolved.length - hits - ties;
  const pending = visibleRows.filter(x => x.outcome === 'PENDENTE').length;
  if (!raw.all.length) { host.textContent = 'Feedback: todo sinal emitido é congelado e resolvido internamente. A visão operacional começa quando surgir uma nota A ou A+; os demais níveis continuam alimentando a calibração.'; renderHistory(); return; }
  const rate = resolved.length ? `${hits} acertos / ${errors} erros / ${ties} empates (${fmtPct(hits / resolved.length * 100)} · referência aleatória 50%)` : 'ainda sem A/A+ resolvido';
  const qualified = visibleRows.filter(isOperationalHistoryEntry).length;
  const lowQuality = visibleRows.filter(x => signalQualityCode(x.quality) === 'BAIXA').length;
  host.textContent = `Histórico visível A/A+: ${rate} · ${pending} aguardando fechamento · ${qualified} qualificados e ${lowQuality} de avaliação baixa. Auditoria e treino preservam ${raw.all.length} sinais; sinais baixos aparecem na tela, mas continuam fora do ranking estatístico elegível.`;
  renderHistory();
}
function settleLearningRecords(r) {
  if (!r || !r.asset || !Array.isArray(r.candles) || !TIMEFRAMES[r.tfKey]) return [];
  const items = feedbackLedger(); const changedModels = new Set(), changedRankings = new Map(); let touched = false;
  const changed = settlePendingRecords(items, {
    assetId: r.asset.id,
    tfKey: r.tfKey,
    timeframeMs: TIMEFRAMES[r.tfKey].sec * 1000,
    candles: r.candles,
    now: Date.now(),
    source: r.source || r.dataSource || null
  });
  for (const item of changed) {
    touched = true;
    const expiryCandles = Number(item.expiryCandles || 1);
    changedRankings.set(setupScope(item.asset, item.tf, expiryCandles), { assetId: item.asset, tf: item.tf, expiryCandles });
    if (expiryCandles === 1 && item.actualDirection) changedModels.add(modelKey(item.asset, item.tf));
  }
  if (touched) {
    persistFeedback(items);
    for (const item of changedRankings.values()) refreshSetupRankingReal(item.assetId, item.tf, item.expiryCandles);
    renderFeedbackSummary();
  }
  return [...changedModels];
}
async function resolvePendingHistory() {
  if (state.historyResolving || state.scanning || state.analyzing) return;
  const now = Date.now();
  const due = feedbackLedger().filter(item => {
    if (!item || item.outcome !== 'PENDENTE' || !TIMEFRAMES[item.tf]) return false;
    const times = settlementTimes(item, TIMEFRAMES[item.tf].sec * 1000);
    return times && now >= times.expiresAt;
  });
  const status = $('#historyResolutionStatus');
  if (!due.length) {
    if (status) status.textContent = 'Resultados conferidos automaticamente · nenhum sinal vencido aguardando.';
    return;
  }

  state.historyResolving = true;
  if (status) status.textContent = `Conferindo ${due.length} resultado${due.length > 1 ? 's' : ''} vencido${due.length > 1 ? 's' : ''}…`;
  const groups = new Map();
  for (const item of due) {
    const key = `${item.asset}|${item.tf}`;
    if (!groups.has(key)) groups.set(key, { asset: getAsset(item.asset), tf: item.tf });
  }
  const changedModels = new Set();
  let resolvedCount = 0;
  let failedGroups = 0;
  const jobs = [...groups.values()];
  try {
    // Lotes pequenos evitam pressionar os provedores públicos. As requisições
    // são assíncronas e não bloqueiam cliques, rolagem ou o scanner.
    for (let index = 0; index < jobs.length; index += 3) {
      const batch = jobs.slice(index, index + 3);
      await Promise.all(batch.map(async group => {
        if (!group.asset || !TIMEFRAMES[group.tf]) return;
        try {
          const data = await getCandles(group.asset, group.tf, { depth: 'context', target: 800, force: true, includeLive: false });
          const before = feedbackLedger().filter(item => item.asset === group.asset.id && item.tf === group.tf && item.outcome === 'PENDENTE').length;
          for (const key of settleLearningRecords({ asset: group.asset, tfKey: group.tf, candles: data.candles, source: data.source })) changedModels.add(key);
          const after = feedbackLedger().filter(item => item.asset === group.asset.id && item.tf === group.tf && item.outcome === 'PENDENTE').length;
          resolvedCount += Math.max(0, before - after);
        } catch (_) {
          failedGroups += 1;
        }
      }));
    }
    queueFeedbackRetrains([...changedModels]);
    renderHistory();
    const unavailable = failedGroups ? ` · ${failedGroups} fonte${failedGroups > 1 ? 's' : ''} ${failedGroups > 1 ? 'indisponíveis' : 'indisponível'}` : '';
    if (status) status.textContent = resolvedCount
      ? `${resolvedCount} resultado${resolvedCount > 1 ? 's' : ''} atualizado${resolvedCount > 1 ? 's' : ''} agora${unavailable}.`
      : `Nenhuma vela exata nova encontrada ainda${unavailable}. Nova tentativa automática em breve.`;
  } finally {
    state.historyResolving = false;
  }
}
function queueFeedbackRetrains(keys) {
  if (!keys || !keys.length) return;
  const meta = feedbackMeta(); let dirty = false;
  for (const key of keys) {
    const [assetId, tf] = key.split('|'); const f = feedbackStats(assetId, tf); const last = meta[key] && meta[key].lastFeedbackTrainAttempt || 0;
    const newOutcomes = f.resolved.filter(x => x.resolvedAt > last).length;
    if (newOutcomes < 12 || Date.now() - last < 90 * 60e3 || state.feedbackQueued.has(key)) continue;
    meta[key] = { ...meta[key], lastFeedbackTrainAttempt: Date.now() }; dirty = true; state.feedbackQueued.add(key);
    setTimeout(async () => {
      try { await trainSelected(true, getAsset(assetId), tf); }
      finally { state.feedbackQueued.delete(key); renderFeedbackSummary(); }
    }, 1200);
  }
  if (dirty) persistFeedbackMeta(meta);
}
function recordSignal(r, { origin = 'live-emitted', rankEligible = true } = {}) {
  if (!r || r.dataError || !r.snapshot || !r.asset) return;
  const displayed = displaySignal(r);
  const recordedVerdict = displayed.bias;
  if ((recordedVerdict !== 'CALL' && recordedVerdict !== 'PUT') || !displayed.recordable || !TIMEFRAMES[r.tfKey]) return;
  const createdAt = Date.now();
  const expiryCandles = Math.max(1, Number(r.expiry && r.expiry.candles || r.decision && r.decision.expiryCandles || 1));
  const tfMs = TIMEFRAMES[r.tfKey].sec * 1000;
  // A identidade é a janela atual do relógio, não o timestamp potencialmente
  // atrasado do último candle recebido. Só congelamos previsões feitas antes da
  // abertura teórica; isso impede lookahead na taxa prospectiva.
  const entryCandleAt = Number(r.expiry && r.expiry.entryAt);
  if (!Number.isFinite(entryCandleAt) || entryCandleAt <= createdAt) return;
  const candleAt = entryCandleAt - tfMs;
  const sourceCandleAt = r.snapshot.t || (r.snapshot.candle && r.snapshot.candle.t) || null;
  const targetCandleAt = entryCandleAt + (expiryCandles - 1) * tfMs;
  const expiresAt = entryCandleAt + expiryCandles * tfMs;
  const quality = displayed.statisticallyQualified ? 'CONFIRMADO' : displayed.approved ? 'TECNICO' : 'BAIXA';
  const grade = String(r.grade && r.grade.grade || '').trim().toUpperCase();
  const operationalEligible = isOperationalHistoryEntry({ grade, quality });
  const rankingEligible = !!rankEligible && operationalEligible;
  const rawProbability = r.decision && r.decision.estimate ? r.decision.estimate.p : null;
  const rawEv = r.decision ? r.decision.ev : null;
  const estimatedProbability = rawProbability !== null && rawProbability !== undefined && Number.isFinite(Number(rawProbability)) ? Number(rawProbability) : null;
  const estimatedEv = rawEv !== null && rawEv !== undefined && Number.isFinite(Number(rawEv)) ? Number(rawEv) : null;
  const item = { t: createdAt, candleAt, sourceCandleAt, asset: r.asset.id, tf: r.tfKey, verdict: recordedVerdict, score: r.score.score, grade, price: r.snapshot.price, expiryCandles, quality, operationalEligible, estimatedProbability, estimatedEv };
  const ledger = feedbackLedger();
  const existing = ledger.find(x => x.asset === r.asset.id && x.tf === r.tfKey && x.candleAt === candleAt);
  if (existing) {
    // Regra de integridade: a primeira publicação (análise ou scanner) fica
    // congelada para a vela. Uma leitura posterior nunca a sobrescreve; isso
    // evita escolher depois a versão que ficou melhor e inflar a taxa observada.
    return;
  }
  const nextSignalHistory = [item, ...state.signalHistory.filter(x => !(x.asset === r.asset.id && x.tf === r.tfKey && x.candleAt === candleAt))];
  persistSignalHistory(nextSignalHistory);
  ledger.push({
    id: `${r.asset.id}|${r.tfKey}|${candleAt}`, asset: r.asset.id, tf: r.tfKey,
    candleAt, sourceCandleAt, entryCandleAt, targetCandleAt, expiresAt, dueAt: expiresAt, price: r.snapshot.price, entryPrice: null,
    expiryCandles,
    direction: recordedVerdict === 'CALL' ? 1 : -1, verdict: recordedVerdict, score: r.score.score,
    grade, quality, operationalEligible, estimatedProbability, estimatedEv,
    // Proveniência explícita: apenas estes sinais efetivamente exibidos podem
    // melhorar/piorar o ranking ao vivo quando forem resolvidos.
    origin, rankEligible: rankingEligible,
    setupId: r.fingerprint ? r.fingerprint.id : null,
    setupLabel: r.fingerprint ? r.fingerprint.label : null,
    createdAt, outcome: 'PENDENTE'
  });
  persistFeedback(ledger); renderFeedbackSummary();
}

window.addEventListener('resize', () => { if (state.result) renderChart(state.result); });
window.addEventListener('beforeunload', () => { if (state.refreshTimer) clearTimeout(state.refreshTimer); if (state.scanTimer) clearTimeout(state.scanTimer); if (state.clockTimer) clearInterval(state.clockTimer); if (state.candleTrainTimer) clearTimeout(state.candleTrainTimer); if (state.cloudTimer) clearTimeout(state.cloudTimer); if (state.historyTimer) clearInterval(state.historyTimer); });
init();
