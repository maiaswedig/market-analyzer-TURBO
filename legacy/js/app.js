// app.js — interface do MARKET ANALYZER v2 (pt-BR)
import { $, $$, store, storageState, fmt, fmtPct, fmtPrice, fmtTime, fmtHM, fmtDateTime, toast, downloadFile, escapeHtml, clamp, signalLabel, signalTag } from './util.js';
import { ASSETS, GROUPS, TF_LIST, TIMEFRAMES, getAsset, addCustomAsset, allAssets, universe, universeSize } from './assets.js';
import { providerHealth, candleWindow, clearCache, getCandles } from './data.js';
import { analyzeAsset, DEFAULT_SETTINGS, MODE_PRESETS, shortReason, buildSnapshotPool, effectiveMinScore } from './analyze.js';
import { runBacktest, assertNoLookahead, distribute } from './backtest.js';
import { trainLogistic, saveModel, loadModel } from './ml.js';
import { rankSetups } from './setups.js';
import { INSUFFICIENT, breakEvenRate, expectancy } from './decision.js';
import { renderAdvancedChart } from './tv.js';
import { PriceChart } from './chart.js';
import * as H from './history.js';
import * as B from './broker.js';
import { fireAlert, requestNotifications, notifState, beep } from './alerts.js';
import { startBackendStatus } from './backend-status.js';

const SETTINGS_KEY = 'ma_settings_v2';
const state = {
  settings: Object.assign({}, DEFAULT_SETTINGS, store.get(SETTINGS_KEY, {}) || {}),
  asset: null, tf: 'M5', result: null, models: {}, busy: false, autoTimer: null,
  lastAlertKey: null, chartView: 'own', charts: {}, setupRankingReal: {}, setupRankingBacktest: {},
  backtest: null, analysisLog: [], learning: null, learningTimer: null,
  scannerTimer: null, scanLearnCursor: 0
};

/* ============================ inicialização ============================ */
function init() {
  store.probe();
  if (!storageState.ok) {
    const n = $('#storageNotice');
    n.hidden = false;
    n.innerHTML = '<strong>Modo sessão:</strong> este ambiente bloqueia o armazenamento local (pré-visualização em iframe). Histórico e configurações valem só nesta aba — use <strong>Exportar JSON</strong> no HISTÓRICO.';
  }
  state.settings = Object.assign({}, DEFAULT_SETTINGS, store.get(SETTINGS_KEY, {}) || {});
  state.tf = TIMEFRAMES[state.settings.defaultTf] ? state.settings.defaultTf : 'M5';
  state.asset = getAsset(state.settings.defaultAsset) || ASSETS[0];
  applySavedLearning(state.asset, state.tf);
  applyTheme(state.settings.theme);

  ['#assetSelect', '#btAsset', '#cfgAsset'].forEach(sel => buildAssetSelect($(sel)));
  ['#btTf', '#cfgTf', '#hTf', '#bkTf'].forEach(sel => buildTfSelect($(sel), sel === '#hTf'));
  buildTfButtons();
  buildScanTfs();
  buildHistoryAssetFilter();
  $('#assetSelect').value = state.asset.id;
  $('#btAsset').value = state.asset.id;
  $('#cfgAsset').value = state.settings.defaultAsset;
  $('#btTf').value = state.tf; $('#cfgTf').value = state.settings.defaultTf; $('#bkTf').value = state.tf;
  $('#scanMarket').value = state.settings.scannerMarket || 'Cripto';
  $('#scanCount').value = String([10,15,20].includes(Number(state.settings.scannerCount)) ? state.settings.scannerCount : 10);
  $('#scanScoreMin').value = String(state.settings.scannerScoreMin || 75);
  $('#scanGrade').value = state.settings.scannerGrade || 'AA+';
  $('#scanOnly').value = state.settings.scannerOnly || 'signals';
  $('#autoRefresh').checked = !!state.settings.autoRefresh;
  syncScannerControls();
  $('#alertToggle').checked = !!state.settings.alertVisual || !!state.settings.alertSound;
  $('#btBanca').value = state.settings.banca;
  $('#btStake').value = state.settings.stake;
  $('#btPayout').value = state.settings.payout;
  $('#btCandles').value = state.settings.deepCandles;
  const autoLearnToggleEl = document.getElementById('cfgAutoLearn');
  if (autoLearnToggleEl) autoLearnToggleEl.checked = state.settings.autoLearn !== false;

  bindEvents();
  renderConfig();
  const savedLearn = loadLearning()[learningKey(state.asset, state.tf)];
  renderAutoLearningStatus(savedLearn);
  renderHistory();
  refreshSetupRanking();
  renderHealth();
  startBackendStatus();
  updateScanNote();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => { H.checkPending().then(n => { if (n) { renderHistory(); refreshSetupRanking(); } }); }, 30000);
  H.checkPending().then(n => { if (n) renderHistory(); refreshSetupRanking(); });
  loadModelFor(state.asset, state.tf);
  analyze();
  if (state.settings.autoRefresh) startAuto();
  if (state.settings.autoLearn !== false) { setTimeout(() => autoLearn(false), 3500); startLearningLoop(); }
  if (state.settings.scannerAuto !== false) startAutoScanner({ initial: true });
}

function buildAssetSelect(sel) {
  if (!sel) return;
  sel.innerHTML = '';
  for (const g of GROUPS) {
    const og = document.createElement('optgroup');
    og.label = g;
    for (const a of allAssets().filter(x => x.group === g)) {
      const o = document.createElement('option');
      o.value = a.id; o.textContent = `${a.name} (${a.id})`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}
function buildTfSelect(sel, withAll = false) {
  if (!sel) return;
  sel.innerHTML = (withAll ? '<option value="">todos</option>' : '') + TF_LIST.map(t => `<option value="${t}">${t}</option>`).join('');
}
function buildTfButtons() {
  $('#tfButtons').innerHTML = TF_LIST.map(t => `<button class="tfbtn${t === state.tf ? ' is-active' : ''}" data-tf="${t}" type="button">${t}</button>`).join('');
}
function buildScanTfs() {
  const sel = new Set(state.settings.scannerTfs && state.settings.scannerTfs.length ? state.settings.scannerTfs : ['M5']);
  $('#scanTfs').innerHTML = TF_LIST.map(t => `<button class="tfbtn${sel.has(t) ? ' is-active' : ''}" data-scantf="${t}" type="button">${t}</button>`).join('');
}
function syncScannerControls() {
  const enabled = state.settings.scannerAuto !== false;
  const every = clamp(Number(state.settings.scannerIntervalSec) || 300, 180, 900);
  $('#scanAuto').checked = enabled;
  $('#scanEvery').value = String([180, 300, 600, 900].includes(every) ? every : 300);
  updateAutoScannerStatus();
}
function buildHistoryAssetFilter() {
  const ids = [...new Set(H.loadHistory().map(r => r.assetId))];
  $('#hAsset').innerHTML = '<option value="">todos</option>' + ids.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  $('#themeBtn').textContent = theme === 'light' ? 'Tema escuro' : 'Tema claro';
}
function saveSettings() { store.set(SETTINGS_KEY, state.settings); }
function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString('pt-BR');
  updateCountdown();
}

/* ============================ eventos ============================ */
function bindEvents() {
  $$('.tab').forEach(btn => btn.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.toggle('is-active', b === btn));
    $$('.tabpanel').forEach(p => p.classList.toggle('is-active', p.id === 'tab-' + btn.dataset.tab));
    if (btn.dataset.tab === 'historico') { buildHistoryAssetFilter(); renderHistory(); }
    if (btn.dataset.tab === 'analise' && state.result && !state.result.dataError) renderCharts(state.result);
    if (btn.dataset.tab === 'corretora' && state.result && !state.result.dataError) renderBrokerChart(state.result);
  }));

  $('#themeBtn').addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
    applyTheme(state.settings.theme); saveSettings();
    for (const k in state.charts) { state.charts[k].destroy(); delete state.charts[k]; }
    if (state.result) renderCharts(state.result);
  });

  $('#assetSelect').addEventListener('change', e => {
    state.asset = getAsset(e.target.value) || state.asset;
    applySavedLearning(state.asset, state.tf); loadModelFor(state.asset, state.tf); analyze();
  });
  $('#assetSearch').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const hit = allAssets().find(a => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
    if (hit) $('#assetSelect').value = hit.id;
  });
  $('#assetSearch').addEventListener('change', () => {
    const id = $('#assetSelect').value;
    if (id !== state.asset.id) { state.asset = getAsset(id); applySavedLearning(state.asset, state.tf); loadModelFor(state.asset, state.tf); analyze(); }
  });
  $('#addCustom').addEventListener('click', () => {
    const v = $('#customAsset').value.trim();
    if (!v) return;
    const a = addCustomAsset(v);
    if (!a) return;
    ['#assetSelect', '#btAsset', '#cfgAsset'].forEach(sel => buildAssetSelect($(sel)));
    $('#assetSelect').value = a.id; state.asset = a; $('#customAsset').value = '';
    toast(`Ativo ${a.id} adicionado. Se a fonte não tiver esse símbolo, aparecerá "fonte indisponível".`, 'info');
    analyze();
  });
  $('#tfButtons').addEventListener('click', e => {
    const b = e.target.closest('.tfbtn'); if (!b) return;
    state.tf = b.dataset.tf; buildTfButtons(); applySavedLearning(state.asset, state.tf); loadModelFor(state.asset, state.tf); analyze(); if (state.settings.autoLearn !== false) setTimeout(() => autoLearn(false), 1800);
  });
  $('#scanTfs').addEventListener('click', e => {
    const b = e.target.closest('.tfbtn'); if (!b) return;
    b.classList.toggle('is-active');
    state.settings.scannerTfs = $$('#scanTfs .tfbtn.is-active').map(x => x.dataset.scantf);
    if (!state.settings.scannerTfs.length) { b.classList.add('is-active'); state.settings.scannerTfs = [b.dataset.scantf]; }
    saveSettings(); restartAutoScanner();
  });
  $('#analyzeBtn').addEventListener('click', () => analyze(true));
  $('#autoRefresh').addEventListener('change', e => {
    state.settings.autoRefresh = e.target.checked; saveSettings();
    e.target.checked ? startAuto() : stopAuto();
  });
  $('#alertToggle').addEventListener('change', e => {
    state.settings.alertVisual = e.target.checked;
    state.settings.alertSound = e.target.checked;
    saveSettings(); renderConfig();
    toast(e.target.checked ? 'Alertas ligados (somente setups A e A+).' : 'Alertas desligados.', 'info');
  });
  $$('[data-chartview]').forEach(b => b.addEventListener('click', () => {
    state.chartView = b.dataset.chartview;
    $$('[data-chartview]').forEach(x => x.classList.toggle('is-active', x === b));
    $('#ownChart').hidden = state.chartView !== 'own';
    $('#tvChart').hidden = state.chartView !== 'tv';
    if (state.result) renderCharts(state.result);
  }));
  $('#scanBtn').addEventListener('click', () => runScanner({ automatic: false }));
  $('#scanGrade').addEventListener('change', renderScanner);
  $('#scanOnly').addEventListener('change', renderScanner);
  $('#scanMarket').addEventListener('change', () => { state.settings.scannerMarket = $('#scanMarket').value; saveSettings(); updateScanNote(); restartAutoScanner(); });
  $('#scanCount').addEventListener('change', () => { state.settings.scannerCount = Number($('#scanCount').value); saveSettings(); updateScanNote(); restartAutoScanner(); });
  $('#scanScoreMin').addEventListener('change', () => { state.settings.scannerScoreMin = Number($('#scanScoreMin').value); saveSettings(); renderScanner(); });
  $('#scanGrade').addEventListener('change', () => { state.settings.scannerGrade = $('#scanGrade').value; saveSettings(); renderScanner(); });
  $('#scanOnly').addEventListener('change', () => { state.settings.scannerOnly = $('#scanOnly').value; saveSettings(); renderScanner(); });
  $('#scanAuto').addEventListener('change', e => {
    state.settings.scannerAuto = e.target.checked;
    saveSettings();
    e.target.checked ? startAutoScanner() : stopAutoScanner();
  });
  $('#scanEvery').addEventListener('change', e => {
    state.settings.scannerIntervalSec = clamp(Number(e.target.value) || 300, 180, 900);
    saveSettings();
    restartAutoScanner();
  });
  $('#btRun').addEventListener('click', backtest);
  const autoLearnToggle = document.getElementById('cfgAutoLearn');
  if (autoLearnToggle) autoLearnToggle.addEventListener('change', e => { state.settings.autoLearn = e.target.checked; saveSettings(); if (e.target.checked) { autoLearn(false); startLearningLoop(); } else if (state.learningTimer) { clearInterval(state.learningTimer); state.learningTimer = null; } });
  $('#btCausal').addEventListener('click', causalityTest);
  $('#trainBtn').addEventListener('click', train);
  $('#learnBtn').addEventListener('click', () => { refreshSetupRanking(true); });

  ['#hAsset', '#hTf', '#hSignal', '#hGrade', '#hStatus', '#hMinScore', '#hMaxScore', '#hFrom', '#hTo']
    .forEach(sel => $(sel).addEventListener('change', renderHistory));
  $('#hCheck').addEventListener('click', async () => {
    const n = await H.checkPending();
    renderHistory();
    toast(n ? `${n} sinal(is) verificado(s).` : 'Nenhum sinal pendente com vela já fechada.', 'info');
  });
  $('#hExportJson').addEventListener('click', () => downloadFile(`market-analyzer-historico-${Date.now()}.json`, H.exportJson()));
  $('#hExportCsv').addEventListener('click', () => downloadFile(`market-analyzer-historico-${Date.now()}.csv`, H.exportCsv(), 'text/csv'));
  $('#hImport').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { const n = H.importJson(r.result); buildHistoryAssetFilter(); renderHistory(); toast(`${n} registro(s) importado(s).`, 'ok'); }
      catch (err) { toast('Falha ao importar: ' + err.message, 'err'); }
    };
    r.readAsText(f);
  });
  $('#hClear').addEventListener('click', () => { if (confirm('Apagar todo o histórico de sinais?')) { H.clearHistory(); renderHistory(); } });

  // corretora
  const dz = $('#dropZone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('is-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('is-over'); handleBrokerFile(e.dataTransfer.files[0]); });
  $('#brokerFile').addEventListener('change', e => handleBrokerFile(e.target.files[0]));
  $('#bkCompare').addEventListener('click', compareBroker);
  $('#bkReset').addEventListener('click', () => { B.reset(); renderBrokerResult(); updateBrokerFlag(); analyze(); });

  $('#notifPerm').addEventListener('click', async () => {
    const ok = await requestNotifications();
    $('#notifStatus').textContent = ok ? 'Notificações permitidas.' : `Notificações não disponíveis: ${notifState.error || notifState.permission}.`;
  });
  $('#testAlert').addEventListener('click', () => { beep('call'); toast('🔔 Alerta de teste — som e toast funcionando.', 'ok'); });
  $('#cfgReset').addEventListener('click', () => {
    state.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    saveSettings(); renderConfig(); syncScannerControls(); restartAutoScanner(); toast('Configurações restauradas.', 'info'); analyze();
  });
  $$('#modeBtns .btn').forEach(b => b.addEventListener('click', () => {
    Object.assign(state.settings, MODE_PRESETS[b.dataset.mode], { mode: b.dataset.mode });
    saveSettings(); renderConfig(); toast(`Modo ${b.dataset.mode} aplicado.`, 'info'); analyze();
  }));
}

function startAuto() {
  stopAuto();
  const sec = clamp(Number(state.settings.refreshSec) || 30, 10, 600);
  state.autoTimer = setInterval(() => { if (!state.busy) analyze(true); }, sec * 1000);
}
function stopAuto() { if (state.autoTimer) clearInterval(state.autoTimer); state.autoTimer = null; }

/* Scanner contínuo: só existe enquanto esta guia estiver aberta. As varreduras são
   sequenciais para respeitar os limites dos provedores públicos de candles. */
function scannerEverySec() { return clamp(Number(state.settings.scannerIntervalSec) || 300, 180, 900); }
function updateAutoScannerStatus(message = '') {
  const el = document.getElementById('scanAutoStatus');
  if (!el) return;
  if (state.settings.scannerAuto === false) { el.textContent = 'desligado'; return; }
  el.textContent = message || `ativo · novo ciclo a cada ${Math.round(scannerEverySec() / 60)} min`;
}
function stopAutoScanner() {
  if (state.scannerTimer) clearTimeout(state.scannerTimer);
  state.scannerTimer = null;
  updateAutoScannerStatus();
}
function scheduleAutoScanner(delayMs = scannerEverySec() * 1000) {
  if (state.settings.scannerAuto === false) { stopAutoScanner(); return; }
  if (state.scannerTimer) clearTimeout(state.scannerTimer);
  const sec = Math.max(1, Math.round(delayMs / 1000));
  updateAutoScannerStatus(`ativo · próximo ciclo em ${sec}s`);
  state.scannerTimer = setTimeout(() => runScanner({ automatic: true }), delayMs);
}
function startAutoScanner({ initial = false } = {}) {
  if (state.settings.scannerAuto === false) { stopAutoScanner(); return; }
  scheduleAutoScanner(initial ? 9000 : 1200);
}
function restartAutoScanner() {
  if (state.settings.scannerAuto === false) { stopAutoScanner(); return; }
  startAutoScanner();
}

const LEARN_KEY = 'ma_learning_v3';
function loadLearning() { return store.get(LEARN_KEY, {}) || {}; }
function saveLearning(v) { store.set(LEARN_KEY, v); state.learning = v; }
function learningKey(asset, tf) { return `${asset.id}|${tf}`; }
function applySavedLearning(asset, tf) {
  const all = loadLearning();
  const item = all[learningKey(asset, tf)];
  if (!item) return null;
  // Resultado do backtest é referência hipotética; jamais é restaurado como
  // insumo da análise ao vivo.
  if (item.setupRankingBacktest || item.setupRanking) state.setupRankingBacktest[learningKey(asset, tf)] = item.setupRankingBacktest || item.setupRanking;
  return item;
}
function startLearningLoop() {
  if (state.learningTimer) clearInterval(state.learningTimer);
  state.learningTimer = setInterval(() => { if (!state.busy && state.settings.autoLearn !== false) autoLearn(false); }, 30 * 60 * 1000);
}
function shouldPromoteModel(candidate, current) {
  if (!candidate || !candidate.ok || !candidate.usable) return { accept: false, reason: candidate?.gateReason || 'candidato não passou na validação' };
  if (candidate.overfit) return { accept: false, reason: 'candidato reprovado por diferença excessiva entre treino e validação' };
  if (candidate.validationPolicyVersion !== 2) return { accept: false, reason: 'candidato não segue a política estatística atual' };
  // Brier de janelas diferentes não é comparável por uma margem fixa. O
  // candidato já passou no teste pareado contra a taxa base do mesmo holdout.
  return { accept: true, reason: current && current.usable ? 'candidato validado novamente em holdout cronológico' : 'primeiro modelo validado' };
}

async function autoLearn(force = false) {
  return autoLearnAsset(state.asset, state.tf, { force });
}

async function autoLearnAsset(asset, tf, { force = false } = {}) {
  if (state.busy || state.settings.autoLearn === false) return;
  const key = learningKey(asset, tf);
  const all = loadLearning(), old = all[key];
  if (!force && old && Date.now() - old.trainedAt < 6 * 60 * 60 * 1000) {
    if (old.setupRankingBacktest || old.setupRanking) state.setupRankingBacktest[key] = old.setupRankingBacktest || old.setupRanking;
    return old;
  }
  const prevBusy = state.busy; state.busy = true;
  try {
    const maxTests = Math.min(1800, Math.max(1200, Math.floor((Number(state.settings.deepCandles) || 10000) * 0.18)));
    const res = await runBacktest(asset, tf, state.settings, {
      maxTests, model: null, onProgress: () => {}
    });
    const target = Math.max(6000, Number(state.settings.deepCandles) || 10000);
    const trainData = await getCandles(asset, tf, { depth: 'deep', target });
    // Usa todo o histórico que a fonte realmente disponibilizar dentro do limite escolhido.
    const pool = buildSnapshotPool(trainData.candles, trainData.hasVolume, { max: target }).snaps;
    const samples = pool.filter(x => x.nextDir === 1 || x.nextDir === -1).map(x => ({ vector: x.vector, label: x.nextDir > 0 ? 1 : 0 }));
    let model = null, promotion = { accept: false, reason: 'amostras insuficientes' };
    if (samples.length >= 400) {
      const minValid = 400;
      model = await trainLogistic(samples, { minValid, epochs: 350, onProgress: () => {} });
      const k = modelKey(asset, tf);
      const current = state.models[k] || loadModel(k);
      promotion = shouldPromoteModel(model, current);
      if (promotion.accept) { saveModel(k, model); state.models[k] = model; }
    }
    const recordCount = res.signals.filter(x => x.result === 'ACERTO' || x.result === 'ERRO').length;
    const item = {
      trainedAt: Date.now(), asset: asset.id, tf, tests: res.bars.length, resolved: recordCount,
      candles: trainData.candles.length, setupRankingBacktest: res.setupRankingBacktest || res.setupRanking || null,
      model: model && model.ok ? {
        samples: model.samples, validN: model.validMetrics?.n || 0, usable: !!model.usable,
        brier: model.validMetrics?.brier ?? null, promoted: promotion.accept, reason: promotion.reason
      } : null
    };
    all[key] = item; saveLearning(all);
    if (asset.id === state.asset.id && tf === state.tf) {
      state.backtest = res; state.setupRankingBacktest[key] = res.setupRankingBacktest || res.setupRanking || null;
      refreshSetupRanking(); renderAutoLearningStatus(item);
      renderMlPanel(state.models[modelKey(asset, tf)]);
    }
    return item;
  } catch (e) {
    if (asset.id === state.asset.id && tf === state.tf) renderAutoLearningStatus(old, e.message);
    return null;
  } finally { state.busy = prevBusy; }
}
function renderAutoLearningStatus(item, error = '') {
  const el = document.getElementById('autoLearnStatus');
  if (!el) return;
  if (error) { el.textContent = `aprendizado: ${error}`; return; }
  if (!item) { el.textContent = 'aprendizado automático: aguardando'; return; }
  const when = item.trainedAt ? new Date(item.trainedAt).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }) : '—';
  const model = item.model;
  const quality = model ? ` · ${model.promoted ? 'modelo atualizado' : 'modelo anterior preservado'}` : '';
  el.textContent = `aprendizado ${item.asset} ${item.tf} · ${item.candles || '—'} candles · ${item.tests || 0} testes · ${item.resolved || 0} sinais resolvidos${quality} · ${when}`;
}
function updateScanNote() {
  const market = $('#scanMarket').value;
  const real = market === 'Ambos' ? universeSize('Ambos') : universeSize(market);
  const wanted = Number($('#scanCount').value);
  $('#scanUniverseNote').textContent = `universo real disponível nos feeds gratuitos: ${real} ativos${wanted > real ? ` — o pedido de ${wanted} será limitado a ${real}` : ''}`;
}

/* ============================ análise ============================ */
function modelKey(asset, tf) { return `${asset.id}_${tf}`; }
function loadModelFor(asset, tf) {
  const k = modelKey(asset, tf);
  if (!state.models[k]) { const m = loadModel(k); if (m) state.models[k] = m; }
  renderMlPanel(state.models[k]);
  syncServerModel(asset, tf, k);
}

// Quando a página é aberta pelo servidor 24/7, utiliza a última versão que passou
// pelas travas de validação no backend. Se a página for aberta como arquivo, falha
// silenciosamente e o modo local continua igual ao original.
async function syncServerModel(asset, tf, key) {
  if (location.protocol === 'file:' && !globalThis.MARKET_ANALYZER_API_URL) return;
  const base = (globalThis.MARKET_ANALYZER_API_URL || '/api/v1').replace(/\/$/, '');
  try {
    const q = new URLSearchParams({ asset: asset.id, tf });
    const response = await fetch(`${base}/model/active?${q}`, { cache: 'no-store' });
    if (!response.ok) return;
    const remote = await response.json();
    if (!remote.model || !remote.model.ok || state.asset.id !== asset.id || state.tf !== tf) return;
    state.models[key] = remote.model;
    saveModel(key, remote.model);
    renderMlPanel(remote.model);
    if (state.busy) state.pending = { force: false };
    else analyze();
  } catch {
    // Backend opcional indisponível: o modelo salvo no navegador permanece em uso.
  }
}

function refreshSetupRanking(notify = false) {
  const stats = H.historyStats(H.loadHistory(), { payout: (state.settings.payout || 85) / 100, stake: state.settings.stake || 5, operationCost: state.settings.operationCost || 0 });
  const grouped = new Map();
  for (const record of stats.setupRecords) {
    const key = `${record.assetId}|${record.tf}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  const real = {};
  for (const [key, records] of grouped) {
    real[key] = rankSetups(records, {
      minSamples: state.settings.minSetupSamples, payout: (state.settings.payout || 85) / 100,
      stake: state.settings.stake || 5, operationCost: state.settings.operationCost || 0
    });
  }
  state.setupRankingReal = real;
  const key = learningKey(state.asset, state.tf);
  const active = state.setupRankingReal[key] || null;
  renderSetupPanel(stats.setupRecords.length, active, state.setupRankingBacktest[key] || null);
  if (notify) toast(active ? `Ranking real atualizado com ${stats.setupRecords.length} sinais verificados.` : 'Ainda não há sinais reais verificados para aprender.', 'info');
}

async function analyze(force = false) {
  // Se uma análise está em andamento, agenda a próxima (evita a UI mostrar um TF/ativo
  // diferente do resultado exibido).
  if (state.busy) { state.pending = { force }; return; }
  state.pending = null;
  state.busy = true;
  $('#analyzeBtn').disabled = true;
  $('#verdictCard').innerHTML = '<div class="skeleton skeleton--verdict"></div>';
  $('#opScreen').innerHTML = '<div class="skeleton skeleton--verdict"></div>';
  ['whyCard', 'metricsCard', 'catCard', 'mtfCard', 'paCard', 'zoneCard', 'penaltyCard', 'explainCard', 'detailCard', 'diagCard']
    .forEach(id => { $('#' + id).innerHTML = '<div class="skeleton skeleton--line"></div><div class="skeleton skeleton--line" style="width:70%"></div>'; });
  if (force) clearCache();
  const model = state.models[modelKey(state.asset, state.tf)] || null;
  try {
    const r = await analyzeAsset(state.asset, state.tf, state.settings, {
      model, setupRanking: state.setupRankingReal[learningKey(state.asset, state.tf)] || null,
      brokerDivergence: B.brokerState.divergent ? { divergent: true, reason: B.brokerState.reason } : null,
      onStage: msg => { $('#srcMeta').textContent = msg; }
    });
    state.result = r;
    if (r.dataError) { renderFatal(new Error((r.errors && r.errors.join(' | ')) || (r.reasons && r.reasons.join(' ')) || 'fonte indisponível')); renderSources(r); return; }
    state.analysisLog.push({ t: Date.now(), asset: r.asset.id, tf: r.tfKey, verdict: r.verdict, score: r.score.score, grade: r.grade.grade, hour: new Date().getHours() });
    if (state.analysisLog.length > 400) state.analysisLog.shift();
    renderResult(r);
    const rec = H.addSignal(r);
    if (rec) { buildHistoryAssetFilter(); renderHistory(); }
    const key = `${r.asset.id}|${r.tfKey}|${r.verdict}|${r.candleWindow.open}`;
    if (state.lastAlertKey !== key) { state.lastAlertKey = key; fireAlert(r, state.settings); }
  } catch (e) {
    renderFatal(e);
  } finally {
    state.busy = false;
    $('#analyzeBtn').disabled = false;
    renderHealth();
    if (state.pending) { const p = state.pending; state.pending = null; setTimeout(() => analyze(p.force), 50); }
  }
}

function renderFatal(e) {
  const msg = escapeHtml(e.message || String(e));
  $('#verdictCard').innerHTML = `<div class="v2verdict"><div class="v2verdict__badge v-wait"><b>—</b><span>fonte indisponível</span></div>
    <div class="verdict__body"><div class="errbox"><b>Não foi possível obter candles reais.</b><p class="small">${msg}</p>
    <p class="small muted">Nenhum dado é inventado: sem candles reais não há análise. Tente outro ativo/timeframe ou repita em alguns segundos — os proxies CORS públicos usados para o Yahoo falham com frequência.</p></div></div></div>`;
  $('#opScreen').innerHTML = `<div class="opcard"><div class="op__pair">${escapeHtml(state.asset.name)} <small>${state.tf}</small></div>
    <div class="op__badge v-wait">—</div><p class="muted">fonte indisponível — nenhuma análise foi feita</p><p class="small muted">${msg}</p></div>`;
  ['whyCard', 'metricsCard', 'catCard', 'mtfCard', 'paCard', 'zoneCard', 'penaltyCard', 'explainCard', 'detailCard'].forEach(id => $('#' + id).innerHTML = '');
  renderCharts(null);
  renderDiag();
}

function fmtSmall(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1) return fmt(v, a >= 1000 ? 1 : 3);
  if (a >= 0.001) return fmt(v, 5);
  return v.toExponential(2);
}
const vClass = v => v === 'CALL' ? 'v-call' : v === 'PUT' ? 'v-put' : 'v-wait';
const vIcon = v => signalTag(v);
const gClass = g => 'g-' + String(g).replace('+', 'plus');
const dirLabel = d => d > 0 ? '<span class="pos">ALTA</span>' : d < 0 ? '<span class="neg">BAIXA</span>' : '<span class="neu">NEUTRO</span>';
function summary(id, title, extra = '') { return `<summary>${title}${extra ? `<span class="muted small">${extra}</span>` : ''}</summary>`; }

function renderResult(r) {
  const sc = r.score, s = r.snapshot, d = r.decision, g = r.grade, cond = r.cond;
  const win = r.candleWindow;

  /* ---- 1) veredito grande + 2) score/qualidade/confluência/próxima vela ---- */
  $('#verdictCard').innerHTML = `
    <div class="v2verdict">
      <div class="asset-hero"><strong>${escapeHtml(r.asset.name)}</strong><span>${escapeHtml(r.asset.id)} · ${r.tfKey}</span></div>
      <div class="v2verdict__badge ${vClass(r.verdict)}">
        <b>${signalLabel(r.verdict)}</b>
        <span>próxima vela de ${r.tfKey}</span>
        <span class="gradepill ${gClass(g.grade)}" title="${escapeHtml(g.detail.join(' · '))}">setup ${g.grade}</span>
      </div>
      <div class="verdict__body">
        <div class="kpis">
          <div class="kpi"><span>Score técnico</span><b>${fmt(sc.score, 1)}<small class="muted">/100</small></b></div>
          <div class="kpi"><span>Qualidade</span><b class="${gClass(g.grade)}">${g.grade}</b></div>
          <div class="kpi"><span>Confluência</span><b>${sc.confluence.text}</b></div>
          <div class="kpi countdown"><span>Fecha em</span><b id="cdVal">—</b></div>
          <div class="kpi"><span>Próxima vela</span><b>${fmtHM(win.open)}→${fmtHM(win.close)}</b></div>
          <div class="kpi"><span>Preço (últ. fech.)</span><b>${fmtPrice(s.price)}</b></div>
        </div>
        <div class="bar ${r.verdict === 'PUT' ? 'bar--put' : r.verdict === 'AGUARDAR' ? 'bar--wait' : ''}"><i style="width:${clamp(sc.score, 0, 100)}%"></i></div>
        <p class="small muted">Score é <strong>força de confluência técnica</strong> (50 = mercado neutro), <strong>não</strong> taxa de acerto. Condição: <strong>${escapeHtml(cond.text)}</strong>${cond.abnormal ? ' <span class="badge badge--warn">⚠️ CONDIÇÃO ANORMAL</span>' : ''}</p>
        <div class="chiprow">${d.gates.map(x => `<span class="badge ${x.warn ? 'badge--warn' : x.ok ? 'badge--ok' : (x.blocking ? 'badge--err' : 'badge--warn')}">${x.warn ? '⚠️' : x.ok ? '✓' : '×'} ${escapeHtml(x.text)}</span>`).join('')}</div>
      </div>
    </div>`;

  /* ---- 3) Por quê? ---- */
  $('#whyCard').innerHTML = `<div class="card__head"><h2>Por quê?</h2><span class="muted small">${r.verdict === 'AGUARDAR' ? 'o que falta para virar sinal' : 'o que está sustentando o sinal'}</span></div>
    <ul class="bullets">${r.why.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`;

  /* ---- métricas honestas (3 separadas) ---- */
  const histRate = r.hist.insufficient ? null : (sc.direction > 0 ? r.hist.pUp : r.hist.pDown) * 100;
  const mlOk = r.ml && r.ml.usable && r.ml.p !== null && r.ml.p !== undefined;
  $('#metricsCard').innerHTML = summary('metrics', 'Três métricas separadas (score ≠ probabilidade ≠ histórico)', `${r.candleCount} candles analisados de ${r.totalCandles} carregados`) + `
    <div class="details__body">
      <div class="metric"><div class="metric__top"><span class="metric__lbl">Score técnico</span><span class="metric__val">${fmt(sc.score, 1)}/100</span></div>
        <p class="metric__src">Origem: média ponderada das categorias (viés ${sc.bias100}/100) na escala B0=${sc.scale.B0} / B1=${sc.scale.B1}, menos ${fmt(sc.penaltyTotal, 1)} de penalidades. Não é taxa de acerto.</p></div>
      <div class="metric ${mlOk ? '' : 'metric--insuf'}"><div class="metric__top"><span class="metric__lbl">Probabilidade estimada (modelo)</span><span class="metric__val">${mlOk ? fmtPct(r.ml.p * 100) : '—'}</span></div>
        <p class="metric__src">${mlOk
      ? `Origem: regressão logística calibrada, validação fora da amostra com ${r.ml.validN} amostras e Brier ${r.ml.brier === null ? '—' : r.ml.brier.toFixed(4)} melhor que a taxa base. É P(alta) da próxima vela.`
      : `${INSUFFICIENT} ${r.ml ? escapeHtml('Modelo treinado mas reprovado nas travas: ' + (r.ml.gateReason || '—')) : 'Nenhum modelo treinado para este ativo/TF (aba APRENDIZADO).'}`}</p></div>
      <div class="metric ${histRate === null ? 'metric--insuf' : ''}"><div class="metric__top"><span class="metric__lbl">Taxa histórica (análogos)</span><span class="metric__val">${histRate === null ? '—' : fmtPct(histRate)}</span></div>
        <p class="metric__src">${histRate === null
      ? `${INSUFFICIENT} ${escapeHtml(r.hist.text)} (mínimo configurado: ${r.hist.minSamples}).`
      : `amostra: ${r.hist.samples} sinais análogos no histórico carregado · alta ${r.hist.up} / baixa ${r.hist.down} · IC95% ${fmtPct(r.hist.ciLow * 100)}–${fmtPct(r.hist.ciHigh * 100)} ${r.hist.significant ? '<span class="badge badge--ok">IC não cruza 50%</span>' : '<span class="badge badge--warn">IC cruza 50% — pouco conclusivo</span>'}`}</p></div>
      <div class="metric"><div class="metric__top"><span class="metric__lbl">Expectativa matemática</span><span class="metric__val">${d.ev === null ? '—' : 'R$ ' + fmt(d.ev, 3)}</span></div>
        <p class="metric__src">${d.estimate.p === null
      ? `${INSUFFICIENT} Sem estimativa elegível, a decisão usa score técnico + travas de risco (a expectativa não é chutada).`
      : `p = ${fmtPct(d.estimate.p * 100)} (${escapeHtml(d.estimate.source)}, N = ${d.estimate.samples || '—'}) · payout ${(d.payout * 100).toFixed(0)}% · aposta R$ ${d.stake} · EV = p·payout·valor − (1−p)·valor · <strong>equilíbrio em ${fmtPct(d.breakEven * 100)}</strong>`}</p></div>
    </div>`;

  /* ---- categorias ---- */
  $('#catCard').innerHTML = summary('cat', 'Sub-scores por categoria', `viés final ${sc.bias100}/100`) + `
    <div class="details__body"><div class="catgrid">
    ${sc.categories.map(c => {
      const half = (c.sub - 50) / 50;
      const w = Math.abs(half) * 50;
      return `<div class="catrow" title="${escapeHtml(c.detail || '')}">
        <span>${escapeHtml(c.label)} <small class="muted">(peso ${c.weight})</small></span>
        <span class="catbar"><span class="catbar__mid"></span><i class="${half >= 0 ? 'pos' : 'neg'}" style="${half >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></i></span>
        <b class="${c.sub > 55 ? 'pos' : c.sub < 45 ? 'neg' : 'neu'}">${fmt(c.sub, 0)}</b></div>
        <p class="small muted" style="margin:-4px 0 4px">${escapeHtml(c.detail || '')}${c.neutralized ? ' <span class="badge badge--warn">neutralizado</span>' : ''}</p>`;
    }).join('')}
    </div></div>`;

  /* ---- multi-TF ---- */
  $('#mtfCard').innerHTML = summary('mtf', 'Confluência multi-timeframe', `${sc.confluence.text}`) + `
    <div class="details__body">
    <p class="mono">${r.mtf.map(m => `${m.tf} ${m.unavailable ? '⚠️ n/d' : m.dir > 0 ? '🟢 ALTA' : m.dir < 0 ? '🔴 BAIXA' : '⚪ NEUTRO'}`).join(' / ')} &nbsp;→&nbsp; <strong>CONFLUÊNCIA: ${sc.confluence.text}</strong></p>
    <div class="tablewrap"><table class="stack"><thead><tr><th>TF</th><th>Direção</th><th>Estrutura</th><th>Condição</th><th class="num">RSI</th><th class="num">ADX</th></tr></thead><tbody>
    ${r.mtf.map(m => m.unavailable
      ? `<tr><td data-label="TF" class="mono">${m.tf}${m.isMain ? ' ★' : ''}</td><td data-label="Direção" colspan="5"><span class="badge badge--warn">fonte indisponível para este TF</span></td></tr>`
      : `<tr><td data-label="TF" class="mono">${m.tf}${m.isMain ? ' ★' : ''}</td><td data-label="Direção">${dirLabel(m.dir)}</td>
         <td data-label="Estrutura">${escapeHtml(m.snap.structure.label)}</td>
         <td data-label="Condição">${escapeHtml(m.snap.adx === null ? '—' : m.snap.adx >= 25 ? 'tendência' : m.snap.adx >= 18 ? 'moderada' : 'lateral')}</td>
         <td data-label="RSI" class="num">${fmt(m.snap.rsi, 1)}</td><td data-label="ADX" class="num">${fmt(m.snap.adx, 1)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted">O veredito é sempre sobre a próxima vela do TF principal (★). Os outros entram como contexto.</p></div>`;

  /* ---- price action ---- */
  const pa = s.priceAction;
  $('#paCard').innerHTML = summary('pa', 'Price action avançado', `${pa.events.length} evento(s)`) + `
    <div class="details__body">
    <p><strong>${escapeHtml(pa.summary)}</strong></p>
    ${pa.events.length ? `<div class="tablewrap"><table class="stack"><thead><tr><th>Evento</th><th>Direção</th><th class="num">Peso</th><th>Detalhe</th></tr></thead><tbody>
      ${pa.events.map(e => `<tr><td data-label="Evento">${escapeHtml(e.name)}</td><td data-label="Direção">${dirLabel(e.dir)}</td><td data-label="Peso" class="num">${fmt(e.weight, 2)}</td><td data-label="Detalhe" class="muted small">${escapeHtml(e.detail || '')}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted small">Nenhum evento relevante nas últimas velas.</p>'}
    <div class="kv" style="margin-top:8px">
      <div class="kpi"><span>Corpo / amplitude</span><b>${fmtPct(pa.anatomy.bodyPct * 100, 0)}</b></div>
      <div class="kpi"><span>Pavio superior</span><b>${fmtPct(pa.anatomy.upperPct * 100, 0)}</b></div>
      <div class="kpi"><span>Pavio inferior</span><b>${fmtPct(pa.anatomy.lowerPct * 100, 0)}</b></div>
      <div class="kpi"><span>Amplitude vs ATR</span><b>${pa.sizeVsAtr === null ? '—' : fmt(pa.sizeVsAtr, 2) + '×'}</b></div>
    </div>
    <div class="tablewrap" style="margin-top:8px"><table class="stack"><thead><tr><th>Janela</th><th class="num">Altas</th><th class="num">Baixas</th><th class="num">Variação</th></tr></thead><tbody>
      ${Object.entries(pa.windows).map(([k, w]) => `<tr><td data-label="Janela">${w.velas} velas</td><td data-label="Altas" class="num pos">${w.altas}</td><td data-label="Baixas" class="num neg">${w.baixas}</td><td data-label="Variação" class="num ${w.variacaoPct > 0 ? 'pos' : w.variacaoPct < 0 ? 'neg' : ''}">${fmtPct(w.variacaoPct, 2)}</td></tr>`).join('')}
    </tbody></table></div></div>`;

  /* ---- zonas ---- */
  const z = s.zones;
  const zoneRow = (zz, kind) => `<tr><td data-label="Tipo">${kind}</td>
    <td data-label="Faixa" class="num">${fmtPrice(zz.low)} – ${fmtPrice(zz.high)}</td>
    <td data-label="Largura" class="num">${fmtPct(zz.widthPct, 3)}</td>
    <td data-label="Força" class="num">${zz.strength}/5</td>
    <td data-label="Toques" class="num">${zz.touches}</td>
    <td data-label="Distância" class="num">${fmtPct(zz.distPct, 3)} · ${fmt(zz.distEdgeAtr, 2)} ATR</td>
    <td data-label="Origem" class="muted small">${escapeHtml(zz.labels.join(', '))}</td></tr>`;
  $('#zoneCard').innerHTML = summary('zone', 'Zonas de suporte e resistência', sc.clearance ? escapeHtml(sc.clearance.reason) : '') + `
    <div class="details__body">
    ${sc.clearance ? `<p class="${sc.clearance.blocked ? 'neg' : 'muted'}">${sc.clearance.blocked ? '⚠️ BLOQUEADO: ' : ''}${escapeHtml(sc.clearance.reason)}</p>` : ''}
    <div class="tablewrap"><table class="stack"><thead><tr><th>Tipo</th><th class="num">Faixa</th><th class="num">Largura</th><th class="num">Força</th><th class="num">Toques</th><th class="num">Distância</th><th>Origem</th></tr></thead><tbody>
    ${z.resistances.slice().reverse().map(x => zoneRow(x, 'resistência')).join('')}
    ${z.supports.map(x => zoneRow(x, 'suporte')).join('')}
    </tbody></table></div>
    <p class="small muted">Posição na faixa mapeada: ${fmtPct(z.rangePos * 100, 0)} (0% = fundo, 100% = topo). Zonas são faixas de preço, agrupando pivôs, extremos e números redondos.</p></div>`;

  /* ---- penalidades ---- */
  $('#penaltyCard').innerHTML = summary('pen', 'Penalidades e bloqueios', `total −${fmt(sc.penaltyTotal, 1)} pts`) + `
    <div class="details__body">${sc.penalties.length
      ? `<ul class="bullets">${sc.penalties.map(p => `<li><span class="neg">−${fmt(p.value, 1)}</span> ${escapeHtml(p.name)}${p.blocking ? ' <span class="badge badge--err">bloqueante</span>' : ''}${p.detail ? ` <span class="muted small">(${escapeHtml(p.detail)})</span>` : ''}</li>`).join('')}</ul>`
      : '<p class="muted small">Nenhuma penalidade nesta leitura.</p>'}</div>`;

  /* ---- explicação ---- */
  $('#explainCard').innerHTML = summary('exp', 'Explicação completa em português') + `<div class="details__body"><p>${escapeHtml(r.explanation)}</p></div>`;

  /* ---- indicadores ---- */
  $('#detailCard').innerHTML = summary('det', 'Indicadores e números brutos') + `
    <div class="details__body"><div class="tablewrap"><table class="stack"><thead><tr><th>Indicador</th><th class="num">Valor</th><th>Indicador</th><th class="num">Valor</th></tr></thead><tbody>
      <tr><td data-label="Ind.">EMA 9 / 21</td><td data-label="Valor" class="num">${fmtPrice(s.ema.e9)} / ${fmtPrice(s.ema.e21)}</td><td data-label="Ind.">EMA 50 / 200</td><td data-label="Valor" class="num">${fmtPrice(s.ema.e50)} / ${s.ema.e200 ? fmtPrice(s.ema.e200) : '—'}</td></tr>
      <tr><td data-label="Ind.">RSI(14)</td><td data-label="Valor" class="num">${fmt(s.rsi, 1)}</td><td data-label="Ind.">Estocástico %K / %D</td><td data-label="Valor" class="num">${fmt(s.stoch.k, 1)} / ${fmt(s.stoch.d, 1)}</td></tr>
      <tr><td data-label="Ind.">MACD linha / sinal</td><td data-label="Valor" class="num">${fmtSmall(s.macd.line)} / ${fmtSmall(s.macd.signal)}</td><td data-label="Ind.">ROC(9)</td><td data-label="Valor" class="num">${fmtPct(s.roc, 2)}</td></tr>
      <tr><td data-label="Ind.">ADX(14) · +DI/−DI</td><td data-label="Valor" class="num">${fmt(s.adx, 1)} · ${fmt(s.plusDI, 0)}/${fmt(s.minusDI, 0)}</td><td data-label="Ind.">Compressão das EMAs</td><td data-label="Valor" class="num">${fmt(s.emaCompression, 2)} ATR</td></tr>
      <tr><td data-label="Ind.">ATR(14)</td><td data-label="Valor" class="num">${fmtPrice(s.atr)} (percentil ${fmt(s.atrPercentile, 0)})</td><td data-label="Ind.">Bollinger %B / largura</td><td data-label="Valor" class="num">${fmt(s.bb.percentB, 2)} / ${fmt(s.bb.bandwidth, 2)}%</td></tr>
      <tr><td data-label="Ind.">Volume relativo</td><td data-label="Valor" class="num">${s.volume.available ? fmt(s.volume.rel, 2) + '×' : 'sem volume real'}</td><td data-label="Ind.">Amplitude vs média</td><td data-label="Valor" class="num">${fmt(s.rangeRel, 2)}×</td></tr>
      <tr><td data-label="Ind.">Gap de abertura</td><td data-label="Valor" class="num">${fmt(s.gapAtr, 2)} ATR</td><td data-label="Ind.">Classe de setup</td><td data-label="Valor" class="num small">${r.fingerprint ? escapeHtml(r.fingerprint.label) : '—'}</td></tr>
    </tbody></table></div></div>`;

  renderDiag();
  renderSources(r);
  renderCharts(r);
  renderOperacao(r);
  updateBrokerFlag();
  updateCountdown();
}

/* ---- DIAGNÓSTICO DE CALIBRAÇÃO ---- */
function renderDiag() {
  const log = state.analysisLog;
  const bt = state.backtest;
  const fromLog = log.length ? distribute(log.map(x => ({ verdict: x.verdict, score: x.score, hour: x.hour, grade: x.grade }))) : null;
  const d = bt ? bt.distribution : null;
  const bar = dd => `<div class="dist">
      <i class="call" style="width:${dd.callPct}%">${dd.callPct >= 8 ? fmt(dd.callPct, 0) + '%' : ''}</i>
      <i class="put" style="width:${dd.putPct}%">${dd.putPct >= 8 ? fmt(dd.putPct, 0) + '%' : ''}</i>
      <i class="wait" style="width:${dd.waitPct}%">${dd.waitPct >= 8 ? fmt(dd.waitPct, 0) + '%' : ''}</i></div>`;
  $('#diagCard').innerHTML = `<div class="card__head"><h2>Diagnóstico de calibração</h2><span class="muted small">distribuição real dos vereditos</span></div>
    ${fromLog ? `<p class="small muted">Análises desta sessão (${fromLog.n}):</p>${bar(fromLog)}
      <p class="small mono">COMPRA ${fmtPct(fromLog.callPct)} · VENDA ${fmtPct(fromLog.putPct)} · AGUARDAR ${fmtPct(fromLog.waitPct)}</p>` : '<p class="muted small">Nenhuma análise registrada nesta sessão ainda.</p>'}
    ${d ? `<p class="small muted">Último backtest — ${escapeHtml(bt.meta.asset.name)} ${bt.meta.tfKey} (${d.n} velas):</p>${bar(d)}
      <p class="small mono">COMPRA ${fmtPct(d.callPct)} · VENDA ${fmtPct(d.putPct)} · AGUARDAR ${fmtPct(d.waitPct)}</p>
      <p class="small muted">Score: mín ${fmt(d.scoreMin, 1)} · p25 ${fmt(d.scoreP25, 1)} · mediana ${fmt(d.scoreMedian, 1)} · p75 ${fmt(d.scoreP75, 1)} · p90 ${fmt(d.scoreP90, 1)} · máx ${fmt(d.scoreMax, 1)}. Limiar em uso: ${effectiveMinScore(state.settings, state.asset.id, state.tf)}.</p>
      <p class="small muted">Notas: ${d.byGrade.map(x => `${x.key} ${fmtPct(x.pct, 0)}`).join(' · ')}</p>`
      : '<p class="small muted">Rode um backtest para ver a distribuição por vela, por hora e por nota, além da varredura de limiares.</p>'}`;
}

function renderSources(r) {
  const main = r.sources[r.tfKey];
  if (main) {
    $('#srcBadge').textContent = `fonte: ${main.source}`;
    $('#srcBadge').className = 'badge ' + (main.stale ? 'badge--warn' : 'badge--ok');
    const age = main.dataAgeMs !== undefined ? Math.max(0, Math.round(main.dataAgeMs / 1000)) : Math.max(0, Math.round((Date.now() - main.updatedAt) / 1000));
    const blocked = r.dataFreshness && r.dataFreshness.blocked;
    $('#srcMeta').textContent = `${main.count} candles · dado recebido há ${age}s · latência ${main.latencyMs} ms${blocked ? ' · ⚠ sinal bloqueado por atraso Yahoo' : ''} · atualizado ${fmtTime(main.updatedAt)}`;
    $('#volBadge').hidden = !!main.hasVolume;
    $('#aggBadge').hidden = !main.aggregatedFrom;
    if (main.aggregatedFrom) $('#aggBadge').textContent = `agregado a partir de ${main.aggregatedFrom}`;
  } else {
    $('#srcBadge').textContent = 'fonte: indisponível';
    $('#srcBadge').className = 'badge badge--err';
    $('#srcMeta').textContent = (r.errors && r.errors.length) ? r.errors[0] : 'nenhuma fonte respondeu';
    $('#volBadge').hidden = true; $('#aggBadge').hidden = true;
    return;
  }
  if (r.warnings && r.warnings.length) $('#srcMeta').textContent += ' · ' + r.warnings.join(' · ');
}

function updateCountdown() {
  if (!state.result || !state.result.tfKey) return;
  const w = candleWindow(TIMEFRAMES[state.result.tfKey].sec);
  const sec = Math.max(0, Math.floor(w.remaining / 1000));
  const txt = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const a = document.getElementById('cdVal'); if (a) a.textContent = txt;
  const b = document.getElementById('opCd'); if (b) b.textContent = txt;
}

function renderHealth() {
  const rows = Object.entries(providerHealth);
  $('#healthPanel').innerHTML = rows.length
    ? rows.map(([k, v]) => `<div>${v.ok ? '<span class="pos">OK</span>' : '<span class="neg">FALHOU</span>'} ${escapeHtml(k)} <span class="muted">${fmtTime(v.at)}${v.msg ? ' · ' + escapeHtml(v.msg.slice(0, 90)) : ''}</span></div>`).join('')
    : '—';
}

/* ============================ MODO OPERAÇÃO ============================ */
function renderOperacao(r) {
  const g = r.grade, sc = r.score, w = r.candleWindow;
  const verdictText = signalLabel(r.verdict);
  const isSignal = r.verdict === 'CALL' || r.verdict === 'PUT';
  $('#opScreen').innerHTML = `
    <div class="opcard opcard--compact">
      <div class="op__topline"><div class="op__pair">${escapeHtml(r.asset.name)} <small>${r.tfKey}</small></div><span class="badge ${isSignal ? (r.verdict === 'CALL' ? 'badge--ok' : 'badge--err') : 'badge--warn'}">${verdictText}</span></div>
      <div class="op__next">LEITURA PARA A PRÓXIMA VELA</div>
      <div class="op__badge ${vClass(r.verdict)}"><span class="op__dot"></span>${verdictText}</div>
      <div class="op__grid">
        <div class="op__cell"><span>Score</span><b>${fmt(sc.score, 0)}</b></div>
        <div class="op__cell"><span>Qualidade</span><b class="${gClass(g.grade)}">${g.grade}</b></div>
        <div class="op__cell"><span>Confluência</span><b>${escapeHtml(sc.confluence.text)}</b></div>
      </div>
      <div class="op__window"><span>ENTRADA DA PRÓXIMA VELA</span><strong>${fmtHM(w.open)} → ${fmtHM(w.close)}</strong><b id="opCd">—</b></div>
      ${r.verdict === 'AGUARDAR' ? '<p class="muted small op__note">Sem confluência suficiente. O sistema prefere AGUARDAR a forçar uma entrada.</p>' : ''}
      ${B.brokerState.divergent ? '<p class="neg small" style="margin-top:10px">⚠️ FEED DIVERGENTE — confirme a corretora antes de considerar o sinal.</p>' : ''}
      <div class="op__actions"><button id="opGo" class="btn btn--ghost" type="button">VER ANÁLISE</button><button id="opReanalyze" class="btn btn--primary" type="button">ATUALIZAR</button></div>
    </div>`;
  $('#opGo').addEventListener('click', () => document.querySelector('.tab[data-tab="analise"]').click());
  $('#opReanalyze').addEventListener('click', () => analyze(true));
  updateCountdown();
}

/* ============================ gráficos ============================ */
function chartFor(id) {
  if (!state.charts[id]) state.charts[id] = new PriceChart(document.getElementById(id));
  return state.charts[id];
}
async function renderCharts(r) {
  if (!r || r.dataError || !r.snapshot) {
    if (state.charts.ownChart) { state.charts.ownChart.destroy(); delete state.charts.ownChart; }
    $('#ownChart').innerHTML = '<p class="muted small" style="padding:14px">Sem candles reais para desenhar — a fonte de dados está indisponível. Nenhum gráfico é simulado.</p>';
    return;
  }
  if (state.chartView === 'tv') {
    try { renderAdvancedChart($('#tvChart'), r.asset, r.tfKey, state.settings.theme === 'light' ? 'light' : 'dark'); }
    catch (e) { $('#tvChart').innerHTML = '<p class="muted small">Widget do TradingView indisponível neste ambiente.</p>'; }
    return;
  }
  try {
    await chartFor('ownChart').render({
      candles: r.candles, zones: r.snapshot.zones, tfSec: TIMEFRAMES[r.tfKey].sec,
      verdict: r.verdict, nextOpen: r.candleWindow.open, hasVolume: r.hasVolume
    });
  } catch (e) {
    $('#ownChart').innerHTML = `<p class="muted small">Não foi possível desenhar o gráfico: ${escapeHtml(e.message)}</p>`;
  }
}
async function renderBrokerChart(r) {
  if (!r || r.dataError || !r.snapshot) { $('#bkChart').innerHTML = '<p class="muted small" style="padding:14px">Sem candles reais para desenhar (fonte indisponível).</p>'; return; }
  try {
    await chartFor('bkChart').render({
      candles: r.candles, zones: r.snapshot.zones, tfSec: TIMEFRAMES[r.tfKey].sec,
      verdict: r.verdict, nextOpen: r.candleWindow.open, hasVolume: r.hasVolume
    });
  } catch (e) { $('#bkChart').innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`; }
}

/* ============================ BUSCADOR (MELHORES OPORTUNIDADES) ============================ */
const SCORE_THRESHOLDS = [60, 65, 70, 75, 80];
let scanRows = [];
async function runScanner({ automatic = false } = {}) {
  if (state.busy) {
    if (automatic) scheduleAutoScanner(scannerEverySec() * 1000);
    else toast('Aguarde a análise atual terminar.', 'warn');
    return;
  }
  if (state.scannerTimer) { clearTimeout(state.scannerTimer); state.scannerTimer = null; }
  const market = $('#scanMarket').value;
  const wanted = [10,15,20].includes(Number($('#scanCount').value)) ? Number($('#scanCount').value) : 10;
  const tfs = $$('#scanTfs .tfbtn.is-active').map(b => b.dataset.scantf);
  if (!tfs.length) { toast('Escolha pelo menos um timeframe.', 'warn'); return; }
  const list = universe(market).slice(0, wanted);
  const jobs = [];
  for (const tf of tfs) for (const a of list) jobs.push({ asset: a, tf });
  state.settings.scannerMarket = market; state.settings.scannerCount = wanted; saveSettings();

  const btn = $('#scanBtn');
  btn.disabled = true; state.busy = true; scanRows = [];
  updateAutoScannerStatus(`varrendo ${jobs.length} análises…`);
  const prog = $('#scanProgress'); prog.hidden = false;
  const bar = prog.querySelector('.progress__bar'), lab = prog.querySelector('.progress__label');
  for (let i = 0; i < jobs.length; i++) {
    const { asset, tf } = jobs[i];
    lab.textContent = `${i + 1}/${jobs.length} — ${asset.name} ${tf}`;
    bar.style.width = `${(i / jobs.length) * 100}%`;
    try {
      const k = modelKey(asset, tf);
      if (!state.models[k]) { const saved = loadModel(k); if (saved) state.models[k] = saved; }
       const r = await analyzeAsset(asset, tf, state.settings, { light: true, model: state.models[k] || null, setupRanking: state.setupRankingReal[learningKey(asset, tf)] || null });
       if (!r.dataError) { const rec = H.addSignal(r, { origin: 'scanner-emitted', rankEligible: false }); if (rec) { buildHistoryAssetFilter(); } }
      scanRows.push(r.dataError
        ? { asset, tf, verdict: 'ERRO', score: null, grade: '—', reason: (r.errors[0] || r.reasons[0] || 'fonte indisponível').slice(0, 80) }
        : {
          asset, tf, verdict: r.verdict, score: r.score.score, grade: r.grade.grade,
          prob: r.decision.estimate.p === null ? null : r.decision.estimate.p * 100,
          probSource: r.decision.estimate.source, probSamples: r.decision.estimate.samples,
          hist: r.hist.insufficient ? null : (r.score.direction > 0 ? r.hist.pUp : r.hist.pDown) * 100,
          histSamples: r.hist.samples, confluence: r.score.confluence.text,
          condition: r.cond.label, reason: shortReason(r)
        });
    } catch (e) {
      scanRows.push({ asset, tf, verdict: 'ERRO', score: null, grade: '—', reason: String(e.message).slice(0, 80) });
    }
    renderScanner();
  }
  bar.style.width = '100%'; lab.textContent = `concluído: ${jobs.length} análises`;
  setTimeout(() => { prog.hidden = true; }, 1500);
  btn.disabled = false; state.busy = false; renderHealth();

  // Em cada rodada, o navegador aprofunda o treino de um ativo diferente. Assim a
  // página evolui sem sobrecarregar as fontes públicas com 10 treinos pesados de uma vez.
  if (state.settings.autoLearn !== false && jobs.length) {
    const learnJob = jobs[state.scanLearnCursor % jobs.length];
    state.scanLearnCursor = (state.scanLearnCursor + 1) % jobs.length;
    updateAutoScannerStatus(`treinando ${learnJob.asset.id} ${learnJob.tf}…`);
    await autoLearnAsset(learnJob.asset, learnJob.tf, { force: false });
  }

  const best = scanRows.filter(r => r.verdict === 'CALL' || r.verdict === 'PUT').sort((a, b) => opportunityRank(b) - opportunityRank(a))[0];
  toast(best ? `Melhor oportunidade: ${best.asset.name} ${best.tf} ${signalLabel(best.verdict)} (score ${fmt(best.score, 1)}, nota ${best.grade}).` : 'Nenhuma oportunidade forte — todos AGUARDAR ou insuficientes.', best ? 'ok' : 'info');
  if (state.settings.scannerAuto !== false) scheduleAutoScanner();
}

function opportunityRank(r) {
  if (!r || (r.verdict !== 'CALL' && r.verdict !== 'PUT')) return -Infinity;
  const g = { 'A+': 5, A: 4, B: 3, C: 2, D: 1, '—': 0 }[r.grade] || 0;
  const p = Number.isFinite(r.prob) ? r.prob : 50;
  const h = Number.isFinite(r.hist) ? r.hist : 50;
  const evidence = Math.max(0, Math.min(20, ((p - 50) * 0.25) + ((h - 50) * 0.20)));
  const conf = String(r.confluence || '0/0').split('/');
  const cr = Number(conf[1]) ? Number(conf[0]) / Number(conf[1]) : 0;
  const condBonus = /forte|moderada/i.test(r.condition || '') ? 5 : /lateral|ruim|anormal/i.test(r.condition || '') ? -6 : 0;
  return (Number(r.score) || 0) * 0.75 + g * 6 + cr * 10 + evidence + condBonus;
}

function renderScanBest(rows) {
  const el = $('#scanBest');
  const eligible = rows.filter(r => (r.verdict === 'CALL' || r.verdict === 'PUT') && r.score !== null);
  const best = eligible.slice().sort((a, b) => opportunityRank(b) - opportunityRank(a))[0];
  if (!best) {
    el.hidden = false;
    el.innerHTML = `<div class="card__head"><h2>⚪ NENHUMA OPORTUNIDADE FORTE</h2></div>
      <p class="muted">Foram analisados ${scanRows.length ? new Set(scanRows.map(r => r.asset.id)).size : 0} ativo(s). Nenhum apresentou confluência/score suficiente para uma operação de próxima vela com os filtros atuais. Isso é melhor do que forçar um sinal — tente reduzir o score mínimo ou ampliar o mercado.</p>`;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<div class="card__head"><h2>🥇 MELHOR OPORTUNIDADE</h2>
      <span class="badge ${best.verdict === 'CALL' ? 'badge--ok' : 'badge--err'}">${signalLabel(best.verdict)}</span></div>
    <p><strong>${escapeHtml(best.asset.name)} · ${best.tf}</strong></p>
    <div class="kpis">
      <div class="kpi"><span>Score</span><b>${fmt(best.score, 1)}<small class="muted">/100</small></b></div>
      <div class="kpi"><span>Qualidade</span><b class="${gClass(best.grade)}">${best.grade}</b></div>
      <div class="kpi"><span>Probabilidade histórica</span><b>${best.hist === null || best.hist === undefined ? '—' : fmtPct(best.hist)}</b></div>
      <div class="kpi"><span>Amostra</span><b>${best.histSamples || '—'}</b></div>
      <div class="kpi"><span>Confluência</span><b>${escapeHtml(best.confluence || '—')}</b></div>
    </div>
    <p class="small"><strong>Por que essa é a melhor oportunidade?</strong> ${escapeHtml(best.reason || 'sem detalhamento disponível.')}</p>
    <button class="btn btn--ghost" type="button" id="scanBestGo">Ver análise completa</button>`;
  $('#scanBestGo')?.addEventListener('click', () => {
    state.asset = best.asset; state.tf = best.tf;
    $('#assetSelect').value = best.asset.id; buildTfButtons();
    document.querySelector('.tab[data-tab="analise"]').click();
  });
}

function renderScanStats(rows) {
  const el = $('#scanStats');
  if (!scanRows.length) { el.hidden = true; return; }
  const done = scanRows.filter(r => r.verdict !== 'ERRO');
  const call = done.filter(r => r.verdict === 'CALL').length;
  const put = done.filter(r => r.verdict === 'PUT').length;
  const wait = done.filter(r => r.verdict === 'AGUARDAR').length;
  const n = done.length || 1;
  const withSignal = scanRows.filter(r => r.verdict === 'CALL' || r.verdict === 'PUT' || (r.verdict === 'AGUARDAR' && r.score !== null));
  const preview = SCORE_THRESHOLDS.map(t => `${t} → ${withSignal.filter(r => (r.verdict === 'CALL' || r.verdict === 'PUT') && r.score >= t).length}`).join(' · ');
  el.hidden = false;
  el.innerHTML = `<div class="card__head"><h2>Desta varredura</h2></div>
    <p class="small mono">COMPRA ${fmtPct(call / n * 100)} · VENDA ${fmtPct(put / n * 100)} · AGUARDAR ${fmtPct(wait / n * 100)} (${done.length} análises válidas)</p>
    <p class="small muted">Oportunidades por score mínimo: ${preview || '—'}</p>`;
}

function renderScanner() {
  const gradeF = $('#scanGrade').value, onlyF = $('#scanOnly').value;
  const scoreMin = Number($('#scanScoreMin')?.value || 0);
  let rows = scanRows.slice();
  if (onlyF === 'signals') rows = rows.filter(r => r.verdict === 'CALL' || r.verdict === 'PUT');
  else if (onlyF === 'CALL' || onlyF === 'PUT') rows = rows.filter(r => r.verdict === onlyF);
  if (gradeF === 'A+') rows = rows.filter(r => r.grade === 'A+');
  else if (gradeF === 'AA+') rows = rows.filter(r => r.grade === 'A' || r.grade === 'A+');
  else if (gradeF === 'B') rows = rows.filter(r => ['A+', 'A', 'B'].includes(r.grade));
  rows = rows.filter(r => r.verdict === 'AGUARDAR' || r.verdict === 'ERRO' || r.score === null || r.score >= scoreMin);
  const gOrder = { 'A+': 5, A: 4, B: 3, C: 2, D: 1, '—': 0 };
  const vOrder = { CALL: 2, PUT: 2, AGUARDAR: 1, ERRO: 0 };
  rows.sort((a, b) => (gOrder[b.grade] - gOrder[a.grade]) || ((b.score || 0) - (a.score || 0)) || ((b.prob || 0) - (a.prob || 0)));

  renderScanBest(scanRows);
  renderScanStats(scanRows);

  $('#scanResults').innerHTML = `<div class="card__head"><h2>Ranking</h2><span class="muted small">${rows.length} de ${scanRows.length} análises · clique numa linha para abrir a análise completa</span></div>
    ${rows.length ? `<div class="tablewrap tablewrap--tall"><table class="stack"><thead><tr><th>#</th><th>Ativo</th><th>TF</th><th>Sinal</th><th class="num">Score</th><th class="num">Probabilidade</th><th class="num">Histórico</th><th>Qualidade</th><th>Condição</th><th>Motivo</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="clickable" data-asset="${escapeHtml(r.asset.id)}" data-tf="${r.tf}">
        <td data-label="#">${['🥇', '🥈', '🥉'][i] || (i + 1)}</td>
        <td data-label="Ativo"><strong>${escapeHtml(r.asset.name)}</strong></td>
        <td data-label="TF" class="mono">${r.tf}</td>
        <td data-label="Sinal"><span class="badge ${r.verdict === 'CALL' ? 'badge--ok' : r.verdict === 'PUT' ? 'badge--err' : 'badge--warn'}">${signalLabel(r.verdict)}</span></td>
        <td data-label="Score" class="num">${r.score === null ? '—' : fmt(r.score, 1)}</td>
        <td data-label="Probabilidade" class="num">${r.prob === null || r.prob === undefined ? '<span class="muted">insuf.</span>' : fmtPct(r.prob) + `<small class="muted"> (N=${r.probSamples || '—'})</small>`}</td>
        <td data-label="Histórico" class="num">${r.hist === null || r.hist === undefined ? '<span class="muted">insuf.</span>' : fmtPct(r.hist) + `<small class="muted"> (N=${r.histSamples})</small>`}</td>
        <td data-label="Qualidade"><span class="gradepill ${gClass(r.grade)}">${r.grade}</span></td>
        <td data-label="Condição" class="small">${escapeHtml(r.condition || '—')}</td>
        <td data-label="Motivo" class="muted small">${escapeHtml(r.reason || '')}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Nenhuma linha atende aos filtros.</p>'}`;

  $$('#scanResults tr.clickable').forEach(tr => tr.addEventListener('click', () => {
    const a = getAsset(tr.dataset.asset); if (!a) return;
    state.asset = a; state.tf = tr.dataset.tf;
    $('#assetSelect').value = a.id; buildTfButtons();
    document.querySelector('.tab[data-tab="analise"]').click();
    loadModelFor(a, state.tf); analyze();
  }));
}

/* ============================ BACKTEST ============================ */
async function backtest() {
  const btn = $('#btRun');
  const asset = getAsset($('#btAsset').value);
  const tf = $('#btTf').value;
  const hours = $('#btHours').value.split(',').map(x => parseInt(x.trim(), 10)).filter(n => Number.isInteger(n) && n >= 0 && n <= 23);
  state.settings.banca = Number($('#btBanca').value) || 250;
  state.settings.stake = Number($('#btStake').value) || 5;
  state.settings.payout = Number($('#btPayout').value) || 85;
  state.settings.deepCandles = clamp(Number($('#btCandles').value) || 6000, 1000, 20000);
  saveSettings(); renderConfig();
  const prog = $('#btProgress');
  const bar = prog.querySelector('.progress__bar'), lab = prog.querySelector('.progress__label');
  prog.hidden = false; btn.disabled = true;
  $('#btResults').innerHTML = '<div class="skeleton skeleton--line"></div><div class="skeleton skeleton--line" style="width:60%"></div>';
  try {
    const res = await runBacktest(asset, tf, state.settings, {
      hourFilter: hours.length ? hours : null,
      maxTests: clamp(Number($('#btMax').value) || 1000, 300, 2000),
      model: state.models[modelKey(asset, tf)] || null,
      onProgress: (p, msg) => { bar.style.width = `${p * 100}%`; lab.textContent = msg || `${Math.round(p * 100)}%`; }
    });
    state.backtest = res;
    state.setupRankingBacktest[learningKey(asset, tf)] = res.setupRankingBacktest || res.setupRanking || null;
    renderBacktest(res);
    renderDiag();
    refreshSetupRanking();
  } catch (e) {
    $('#btResults').innerHTML = `<div class="errbox"><b>Backtest não executado.</b><p class="small">${escapeHtml(e.message)}</p><p class="small muted">Nada é simulado: sem histórico real suficiente o backtest não roda.</p></div>`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { prog.hidden = true; }, 1200);
  }
}

async function causalityTest() {
  const asset = getAsset($('#btAsset').value), tf = $('#btTf').value;
  const btn = $('#btCausal'); btn.disabled = true;
  try {
    const d = await getCandles(asset, tf, { depth: 'mid' });
    const t = assertNoLookahead(d.candles, d.hasVolume);
    toast(t.ok ? `Causalidade OK: features recalculadas só com candles ≤ t são idênticas (${t.checks.length} pontos testados).` : 'FALHOU: vazamento de futuro detectado — ' + t.checks.filter(c => !c.ok).map(c => c.diff).join(' | '), t.ok ? 'ok' : 'err', 9000);
  } catch (e) { toast('Teste não executado: ' + e.message, 'err'); }
  finally { btn.disabled = false; }
}

function renderBacktest(res) {
  const d = res.distribution, s = res.stats, sw = res.sweep, m = res.meta;
  const tbl = (title, rows, extra = '') => `<div class="card__head"><h2>${title}</h2><span class="muted small">${extra}</span></div><div class="tablewrap"><table class="stack"><thead><tr><th>Faixa</th><th class="num">Sinais</th><th class="num">Acertos</th><th class="num">Taxa</th><th class="num">EV/op</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td data-label="Faixa">${escapeHtml(String(r.key))}</td><td data-label="Sinais" class="num">${r.total}</td><td data-label="Acertos" class="num">${r.hits}</td><td data-label="Taxa" class="num ${r.rate >= s.breakEven ? 'pos' : 'neg'}">${fmtPct(r.rate)}</td><td data-label="EV/op" class="num ${r.ev > 0 ? 'pos' : 'neg'}">R$ ${fmt(r.ev, 3)}</td></tr>`).join('')}
  </tbody></table></div>`;

  $('#btResults').innerHTML = `
    <div class="card__head"><h2>Backtest — ${escapeHtml(m.asset.name)} ${m.tfKey}</h2><span class="muted small">fonte ${escapeHtml(m.source)} · ${m.candles} candles · ${d.n} velas avaliadas (${fmtDateTime(m.from)} → ${fmtDateTime(m.to)})</span></div>
    <h2 style="margin-bottom:6px">Distribuição real dos vereditos</h2>
    <div class="dist"><i class="call" style="width:${d.callPct}%">${d.callPct >= 8 ? fmt(d.callPct, 0) + '%' : ''}</i><i class="put" style="width:${d.putPct}%">${d.putPct >= 8 ? fmt(d.putPct, 0) + '%' : ''}</i><i class="wait" style="width:${d.waitPct}%">${d.waitPct >= 8 ? fmt(d.waitPct, 0) + '%' : ''}</i></div>
    <p class="small mono">COMPRA ${fmtPct(d.callPct)} · VENDA ${fmtPct(d.putPct)} · AGUARDAR ${fmtPct(d.waitPct)} — score mín ${fmt(d.scoreMin, 1)} / p25 ${fmt(d.scoreP25, 1)} / mediana ${fmt(d.scoreMedian, 1)} / p75 ${fmt(d.scoreP75, 1)} / p90 ${fmt(d.scoreP90, 1)} / máx ${fmt(d.scoreMax, 1)}</p>
    <p class="small muted">Notas dos setups: ${d.byGrade.map(x => `${x.key} ${fmtPct(x.pct, 0)}`).join(' · ')} · limiar de score usado: ${m.cfg.minScore}${m.lowerTfUnavailable ? ` · o TF menor (${m.lowerTfUnavailable}) não é reconstruível a partir do TF principal e entrou como "n/d"` : ''}</p>

    <div class="kpis" style="margin-top:12px">
      <div class="kpi"><span>Sinais</span><b>${s.total}</b></div>
      <div class="kpi"><span>Acertos</span><b class="pos">${s.hits}</b></div>
      <div class="kpi"><span>Erros</span><b class="neg">${s.errs}</b></div>
      <div class="kpi"><span>Taxa de acerto</span><b>${fmtPct(s.rate)}</b></div>
      <div class="kpi"><span>Acerto COMPRA</span><b>${s.call.hits}/${s.call.total}</b></div>
      <div class="kpi"><span>Acerto VENDA</span><b>${s.put.hits}/${s.put.total}</b></div>
      <div class="kpi"><span>% AGUARDAR</span><b>${fmtPct(d.waitPct)}</b></div>
      <div class="kpi"><span>Profit factor</span><b class="${s.profitFactor >= 1 ? 'pos' : 'neg'}">${s.profitFactor === null ? '—' : fmt(s.profitFactor, 2)}</b></div>
      <div class="kpi"><span>Expectativa/op</span><b class="${s.ev > 0 ? 'pos' : 'neg'}">R$ ${fmt(s.ev, 3)}</b></div>
      <div class="kpi"><span>Equilíbrio líquido</span><b>${fmtPct(s.breakEven)}</b></div>
      <div class="kpi"><span>Custo/operação</span><b>R$ ${fmt(s.operationCost || 0, 2)}</b></div>
      <div class="kpi"><span>Maior sequência ganhos</span><b>${s.bestWin}</b></div>
      <div class="kpi"><span>Maior sequência perdas</span><b>${s.bestLoss}</b></div>
    </div>

    <h2 style="margin-top:14px">Simulação de banca (sem martingale)</h2>
    <div class="kpis">
      <div class="kpi"><span>Banca inicial</span><b>R$ ${fmt(s.banca, 2)}</b></div>
      <div class="kpi"><span>Valor por operação</span><b>R$ ${fmt(s.stake, 2)}</b></div>
      <div class="kpi"><span>Payout</span><b>${fmt(s.payout * 100, 0)}%</b></div>
      <div class="kpi"><span>Banca final</span><b class="${s.net >= 0 ? 'pos' : 'neg'}">R$ ${fmt(s.finalBalance, 2)}</b></div>
      <div class="kpi"><span>Resultado líquido</span><b class="${s.net >= 0 ? 'pos' : 'neg'}">R$ ${fmt(s.net, 2)}</b></div>
      <div class="kpi"><span>Drawdown máximo</span><b class="neg">R$ ${fmt(s.maxDD, 2)} (${fmtPct(s.maxDDpct)})</b></div>
    </div>
    <canvas id="equity" class="minichart" style="margin-top:8px"></canvas>
    <p class="small muted">Curva da banca em R$. Aposta fixa de R$ ${fmt(s.stake, 2)} — <strong>sem martingale</strong>. Custo estimado por operação: R$ ${fmt(s.operationCost || 0, 2)}. Uma taxa de acerto de 75% com payout ${fmt(s.payout * 100, 0)}% dá EV líquido de R$ ${fmt(expectancy(0.75, s.payout, s.stake, s.operationCost || 0), 3)} por operação; abaixo de ${fmtPct(s.breakEven)} de acerto o resultado é negativo por definição.</p>

    <h2 style="margin-top:14px">Varredura de limiares</h2>
    <p class="small muted">Objetivo do <strong>MELHOR EQUILÍBRIO</strong>: ${escapeHtml(sw.objective)}. A tabela mostra somente a validação recente fora da amostra.</p>
    <div class="tablewrap"><table class="stack"><thead><tr><th>Limiar de score</th><th class="num">Sinais</th><th class="num">Taxa de acerto</th><th class="num">Profit factor</th><th class="num">Drawdown</th><th class="num">EV por op.</th><th class="num">Retorno esperado total</th></tr></thead><tbody>
      ${sw.rows.map(r => `<tr class="${sw.best && r === sw.best ? 'is-best' : ''}">
        <td data-label="Limiar" class="mono">${r.threshold}</td>
        <td data-label="Sinais" class="num">${r.signals}${r.enough ? '' : ' <span class="badge badge--warn">amostra pequena</span>'}</td>
        <td data-label="Taxa" class="num ${r.rate >= s.breakEven ? 'pos' : 'neg'}">${fmtPct(r.rate)}</td>
        <td data-label="PF" class="num">${r.profitFactor === null ? '—' : fmt(r.profitFactor, 2)}</td>
        <td data-label="Drawdown" class="num neg">R$ ${fmt(r.maxDD, 2)}</td>
        <td data-label="EV/op" class="num ${r.ev > 0 ? 'pos' : 'neg'}">R$ ${fmt(r.ev, 3)}</td>
        <td data-label="Esperado total" class="num ${r.totalExpected > 0 ? 'pos' : 'neg'}">R$ ${fmt(r.totalExpected, 2)}</td></tr>`).join('')}
    </tbody></table></div>
    ${sw.best ? `<p class="small"><strong>MELHOR EQUILÍBRIO:</strong> limiar <span class="mono">${sw.best.threshold}</span> → ${sw.best.signals} sinais · acerto ${fmtPct(sw.best.rate)} · EV R$ ${fmt(sw.best.ev, 3)} por operação · retorno esperado total R$ ${fmt(sw.best.totalExpected, 2)}.
      ${sw.best.ev <= 0 ? ' <span class="badge badge--warn">atenção: mesmo o melhor limiar tem expectativa ≤ 0 neste ativo/TF — o honesto é não operar</span>' : ''}
      <button id="applyThr" class="btn btn--ghost" type="button">APLICAR ESTE THRESHOLD</button></p>`
      : '<p class="small muted">Nenhum limiar alcançou a amostra mínima de sinais — sem recomendação.</p>'}

    <div class="grid grid--config" style="margin-top:12px">
      <div>${tbl('Por horário', s.byHour, 'hora local')}</div>
      <div>${tbl('Por faixa de score', s.byScore)}</div>
      <div>${tbl('Por qualidade do setup', s.byGrade)}</div>
      <div>${tbl('Por condição de mercado', s.byCondition)}</div>
    </div>

    <div class="card__head" style="margin-top:12px"><h2>Sinais (últimos 120)</h2></div>
    <div class="tablewrap tablewrap--tall"><table class="stack"><thead><tr><th>Data</th><th>Hora</th><th>Sinal</th><th class="num">Score</th><th class="num">Probabilidade</th><th>Setup</th><th class="num">Preço</th><th>Resultado</th><th class="num">Variação</th></tr></thead><tbody>
      ${res.signals.slice(-120).reverse().map(t => `<tr>
        <td data-label="Data" class="mono small">${new Date(t.t).toLocaleDateString('pt-BR')}</td>
        <td data-label="Hora" class="mono small">${fmtTime(t.t)}</td>
        <td data-label="Sinal"><span class="badge ${t.signal === 'CALL' ? 'badge--ok' : 'badge--err'}">${signalLabel(t.signal)}</span> <span class="gradepill ${gClass(t.grade)}">${t.grade}</span></td>
        <td data-label="Score" class="num">${fmt(t.score, 1)}</td>
        <td data-label="Probabilidade" class="num">${t.prob === null ? '<span class="muted">insuf.</span>' : fmtPct(t.prob) + `<small class="muted"> N=${t.probSamples || '—'}</small>`}</td>
        <td data-label="Setup" class="small muted">${escapeHtml((t.setupLabel || '').slice(0, 70))}</td>
        <td data-label="Preço" class="num">${fmtPrice(t.price)}</td>
        <td data-label="Resultado" class="${t.result === 'ACERTO' ? 'pos' : t.result === 'ERRO' ? 'neg' : 'neu'}">${t.result === 'NEUTRO' ? 'DOJI (neutro)' : t.result}</td>
        <td data-label="Variação" class="num ${t.changePct > 0 ? 'pos' : t.changePct < 0 ? 'neg' : ''}">${fmtPct(t.changePct, 3)}</td></tr>`).join('')}
    </tbody></table></div>`;

  drawLine('equity', s.equity.map(p => ({ x: p.t, y: p.bal })), { baseline: s.banca, label: 'banca (R$)' });
  const ap = document.getElementById('applyThr');
  if (ap) ap.addEventListener('click', () => {
    const key = `${m.asset.id}|${m.tfKey}`;
    state.settings.thresholds = Object.assign({}, state.settings.thresholds, { [key]: sw.best.threshold });
    saveSettings(); renderConfig();
    toast(`Limiar ${sw.best.threshold} aplicado para ${key}.`, 'ok');
    if (m.asset.id === state.asset.id && m.tfKey === state.tf) analyze();
  });
}

/* ============================ APRENDIZADO ============================ */
async function train() {
  const btn = $('#trainBtn'); btn.disabled = true;
  $('#mlProgress').textContent = 'carregando histórico profundo…';
  try {
    const d = await getCandles(state.asset, state.tf, { depth: 'deep', target: state.settings.deepCandles });
    $('#mlProgress').textContent = `calculando features de ${d.candles.length} candles…`;
    await new Promise(r => setTimeout(r, 30));
    const { snaps } = buildSnapshotPool(d.candles, d.hasVolume, { zoneLookback: 160 });
    const samples = snaps.filter(s => s.nextDir !== null && s.nextDir !== undefined && s.nextDir !== 0)
      .map(s => ({ vector: s.vector, label: s.nextDir > 0 ? 1 : 0 }));
    $('#mlProgress').textContent = `treinando com ${samples.length} amostras…`;
    const minValid = 400;
    const model = await trainLogistic(samples, { minValid, onProgress: p => { $('#mlProgress').textContent = `treinando… ${Math.round(p * 100)}%`; } });
    if (!model.ok) { toast('Treino não realizado: ' + model.reason, 'warn'); $('#mlProgress').textContent = model.reason; renderMlPanel(null); return; }
    const key = modelKey(state.asset, state.tf);
    const current = state.models[key] || loadModel(key);
    const promotion = shouldPromoteModel(model, current);
    if (promotion.accept) { state.models[key] = model; saveModel(key, model); }
    $('#mlProgress').textContent = promotion.accept ? 'modelo atualizado' : 'modelo atual preservado';
    renderMlPanel(state.models[key] || current || null);
    toast(promotion.accept
      ? `Modelo atualizado: ${promotion.reason}. Brier ${model.validMetrics.brier.toFixed(4)}.`
      : `Candidato não ativado: ${promotion.reason}.`, promotion.accept ? 'ok' : 'warn', 8000);
    analyze();
  } catch (e) {
    toast('Falha no treino: ' + e.message, 'err');
    $('#mlProgress').textContent = 'falha: ' + e.message;
  } finally { btn.disabled = false; }
}

function renderMlPanel(model) {
  const host = $('#mlPanel');
  if (!host) return;
  if (!model || !model.ok) {
    host.innerHTML = `Nenhum modelo treinado para <strong>${escapeHtml(state.asset ? state.asset.id : '')} ${state.tf}</strong>. O treino usa o histórico real do ativo/TF, divide 70% antigo (treino) / 30% recente (validação fora da amostra) e só entra na decisão se tiver amostra suficiente e <strong>Brier melhor que a taxa base</strong>.`;
    $('#relTable').innerHTML = '';
    drawReliability(null);
    return;
  }
  const n = (x, dec = 4) => x === null || x === undefined ? '—' : fmt(x, dec);
  host.innerHTML = `
    <div class="tablewrap"><table class="stack"><thead><tr><th>Divisão</th><th class="num">Amostras</th><th class="num">Acurácia</th><th class="num">LogLoss</th><th class="num">Brier</th><th class="num">AUC</th></tr></thead><tbody>
      <tr><td data-label="Divisão">Treino (70% antigo)</td><td data-label="Amostras" class="num">${model.trainMetrics.n}</td><td data-label="Acurácia" class="num">${fmtPct(model.trainMetrics.acc * 100)}</td><td data-label="LogLoss" class="num">${n(model.trainMetrics.logloss)}</td><td data-label="Brier" class="num">${n(model.trainMetrics.brier)}</td><td data-label="AUC" class="num">${n(model.trainMetrics.auc, 3)}</td></tr>
      <tr><td data-label="Divisão">Validação (30% recente)</td><td data-label="Amostras" class="num">${model.validMetrics.n}</td><td data-label="Acurácia" class="num">${fmtPct(model.validMetrics.acc * 100)}</td><td data-label="LogLoss" class="num">${n(model.validMetrics.logloss)}</td><td data-label="Brier" class="num">${n(model.validMetrics.brier)}</td><td data-label="AUC" class="num">${n(model.validMetrics.auc, 3)}</td></tr>
      <tr><td data-label="Divisão">Referência (taxa base)</td><td data-label="Amostras" class="num">—</td><td data-label="Acurácia" class="num">${fmtPct(Math.max(model.baseRate, 1 - model.baseRate) * 100)}</td><td data-label="LogLoss" class="num">—</td><td data-label="Brier" class="num">${n(model.baseBrier)}</td><td data-label="AUC" class="num">0,5</td></tr>
    </tbody></table></div>
    <p class="small">${model.usable ? '<span class="badge badge--ok">validado</span> a probabilidade do modelo é exibida e entra na decisão.' : `<span class="badge badge--warn">não validado</span> ${INSUFFICIENT} Motivo: ${escapeHtml(model.gateReason || '')}`}
      ${model.overfit ? ' <span class="badge badge--warn">possível overfitting</span>' : ''}</p>
    <p class="small muted">Travas: ${model.gates.map(g => `${g.ok ? '✓' : '×'} ${escapeHtml(g.text)}`).join(' · ')}</p>
    <p class="small muted">Treinado ${fmtDateTime(model.trainedAt)} · ${model.samples} amostras.</p>
    <div class="tablewrap"><table class="stack"><thead><tr><th>Variável (maior peso)</th><th class="num">Peso</th></tr></thead><tbody>
      ${model.weights.slice(0, 10).map(w => `<tr><td data-label="Variável">${escapeHtml(w.name)}</td><td data-label="Peso" class="num ${w.weight > 0 ? 'pos' : 'neg'}">${fmt(w.weight, 3)}</td></tr>`).join('')}
    </tbody></table></div>`;
  const rel = model.validMetrics.reliability || [];
  $('#relTable').innerHTML = `<div class="tablewrap"><table class="stack"><thead><tr><th>Faixa prevista</th><th class="num">Amostras</th><th class="num">Previsto</th><th class="num">Realizado</th></tr></thead><tbody>
    ${rel.map(b => `<tr><td data-label="Faixa">${b.faixa}</td><td data-label="Amostras" class="num">${b.n}</td><td data-label="Previsto" class="num">${b.previsto === null ? '—' : fmtPct(b.previsto * 100)}</td><td data-label="Realizado" class="num">${b.realizado === null ? '—' : fmtPct(b.realizado * 100)}</td></tr>`).join('')}
  </tbody></table></div>`;
  drawReliability(rel);
}

function renderSetupPanel(recordCount, realRanking = null, backtestRanking = null) {
  const host = $('#setupPanel');
  const r = realRanking;
  $('#learnStatus').textContent = `${recordCount} sinais resolvidos · ${r ? r.eligibleCount : 0} classes com amostra ≥ ${state.settings.minSetupSamples}`;
  if (!r || !r.all.length) {
    host.innerHTML = `<p class="muted small">Sem sinais reais verificados suficientes neste ativo/tempo gráfico. O backtest abaixo é referência hipotética e não altera o grade ao vivo.</p>${backtestRanking ? `<p class="small muted">Referência de backtest: ${backtestRanking.classes || 0} classes hipotéticas, mantidas separadas.</p>` : ''}`;
    return;
  }
  const block = (title, rows, cls) => `<div class="card__head"><h2>${title}</h2></div>
    ${rows.length ? rows.map(o => `<div class="metric"><div class="metric__top"><span class="metric__lbl">${escapeHtml(o.signal)} · ${o.total} amostras</span><span class="metric__val ${cls}">${fmtPct(o.rate)}</span></div>
      <p class="metric__src">${escapeHtml(o.label)}<br>EV R$ ${fmt(o.ev * (state.settings.stake || 5), 3)} por operação de R$ ${state.settings.stake} (payout ${state.settings.payout}%)</p></div>`).join('')
      : `<p class="muted small">Nenhuma classe com amostra ≥ ${r.minSamples}.</p>`}`;
  const topBySample = r.all.slice(0, 6).filter(o => !o.enough);
  host.innerHTML = block('Melhores setups', r.best, 'pos') + block('Piores setups', r.worst, 'neg') +
    (topBySample.length ? `<div class="card__head"><h2>Classes mais frequentes (ainda sem amostra suficiente)</h2></div>
      ${topBySample.map(o => `<div class="metric metric--insuf"><div class="metric__top"><span class="metric__lbl">${escapeHtml(o.signal)} · ${o.total} amostras</span><span class="metric__val">${fmtPct(o.rate)}</span></div>
        <p class="metric__src">${escapeHtml(o.label)}<br>⚠️ Dados insuficientes para estimativa estatística (mínimo ${r.minSamples}) — não entra na decisão.</p></div>`).join('')}` : '') +
    `<p class="small muted"><strong>Ranking real usado no sinal:</strong> ${r.classes} classes observadas; só sinais reais, publicados e verificados deste ativo/tempo gráfico entram aqui. ${backtestRanking ? `A referência de backtest tem ${backtestRanking.classes || 0} classes hipotéticas e não afeta esta nota.` : 'O backtest, quando executado, aparecerá somente como referência separada.'}</p>`;
}

/* ============================ HISTÓRICO ============================ */
function historyFilters() {
  return {
    assetId: $('#hAsset').value, tf: $('#hTf').value, signal: $('#hSignal').value,
    grade: $('#hGrade').value, status: $('#hStatus').value,
    minScore: $('#hMinScore').value, maxScore: $('#hMaxScore').value,
    from: $('#hFrom').value, to: $('#hTo').value
  };
}
function renderHistory() {
  const all = H.loadHistory();
  const list = H.filterHistory(all, historyFilters());
  const st = H.historyStats(list, { payout: (state.settings.payout || 85) / 100, stake: state.settings.stake || 5, operationCost: state.settings.operationCost || 0 });
  const grp = (title, rows) => `<div class="card__head"><h2>${title}</h2></div><div class="tablewrap"><table class="stack"><thead><tr><th>Item</th><th class="num">Total</th><th class="num">Acertos</th><th class="num">Taxa</th><th class="num">EV/op</th></tr></thead><tbody>
    ${rows.length ? rows.map(r => `<tr><td data-label="Item">${escapeHtml(String(r.key))}</td><td data-label="Total" class="num">${r.total}</td><td data-label="Acertos" class="num">${r.hits}</td><td data-label="Taxa" class="num">${fmtPct(r.rate)}</td><td data-label="EV/op" class="num ${r.ev > 0 ? 'pos' : 'neg'}">R$ ${fmt(r.ev, 3)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">sem dados</td></tr>'}
  </tbody></table></div>`;

  $('#hStats').innerHTML = `
    <div class="card__head"><h2>Estatísticas do histórico filtrado</h2><span class="muted small">${list.length} de ${all.length} registros · resultado verificado com candles reais quando a vela prevista fecha</span></div>
    <div class="dist"><i class="call" style="width:${st.total ? st.callCount / st.total * 100 : 0}%">${st.callCount}</i><i class="put" style="width:${st.total ? st.putCount / st.total * 100 : 0}%">${st.putCount}</i><i class="wait" style="width:${st.total ? st.wait / st.total * 100 : 0}%">${st.wait}</i></div>
    <p class="small mono">COMPRA ${st.callCount} · VENDA ${st.putCount} · AGUARDAR ${st.wait}</p>
    <div class="kpis">
      <div class="kpi"><span>Sinais operáveis</span><b>${st.operable}</b></div>
      <div class="kpi"><span>Pendentes</span><b>${st.pending}</b></div>
      <div class="kpi"><span>Resolvidos</span><b>${st.resolved}</b></div>
      <div class="kpi"><span>Acertos</span><b class="pos">${st.hits}</b></div>
      <div class="kpi"><span>Erros</span><b class="neg">${st.errs}</b></div>
      <div class="kpi"><span>Taxa de acerto</span><b>${st.resolved >= 20 ? fmtPct(st.rate) : '<span class="badge badge--warn">amostra pequena</span>'}</b></div>
      <div class="kpi"><span>EV por operação</span><b class="${st.ev > 0 ? 'pos' : 'neg'}">${st.ev === null ? '—' : 'R$ ' + fmt(st.ev, 3)}</b></div>
      <div class="kpi"><span>COMPRA</span><b>${st.call.hits}/${st.call.total}</b></div>
      <div class="kpi"><span>VENDA</span><b>${st.put.hits}/${st.put.total}</b></div>
      <div class="kpi"><span>Sequência ganhos</span><b>${st.bestStreak}</b></div>
      <div class="kpi"><span>Sequência perdas</span><b>${st.worstStreak}</b></div>
      <div class="kpi"><span>Neutros (doji)</span><b>${st.neutros}</b></div>
    </div>
    ${st.resolved < 20 ? `<p class="small"><span class="badge badge--warn">⚠️ Dados insuficientes para estimativa estatística</span> — ${st.resolved} sinais verificados; a taxa de acerto só é significativa com amostra maior.</p>` : ''}
    <div class="grid grid--config">
      <div>${grp('Por ativo', st.byAsset)}</div>
      <div>${grp('Por timeframe', st.byTf)}</div>
      <div>${grp('Por horário', st.byHour)}</div>
      <div>${grp('Por faixa de score', st.byBand)}</div>
      <div>${grp('Por qualidade', st.byGrade)}</div>
    </div>`;

  $('#hTable').innerHTML = `<div class="card__head"><h2>Registros</h2><span class="muted small">${storageState.ok ? 'persistido no navegador' : 'modo sessão (não persistido)'}</span></div>
    ${list.length ? `<div class="tablewrap tablewrap--tall"><table class="stack"><thead><tr><th>Gerado</th><th>Ativo</th><th>TF</th><th>Sinal</th><th>Nota</th><th class="num">Score</th><th class="num">Modelo</th><th class="num">Histórico</th><th>Vela prevista</th><th>Status</th><th class="num">Variação</th></tr></thead><tbody>
      ${list.slice(0, 400).map(r => `<tr>
        <td data-label="Gerado" class="mono small">${fmtDateTime(r.createdAt)}</td>
        <td data-label="Ativo">${escapeHtml(r.assetName || r.assetId)}</td>
        <td data-label="TF" class="mono">${r.tf}</td>
        <td data-label="Sinal"><span class="badge ${r.signal === 'CALL' ? 'badge--ok' : r.signal === 'PUT' ? 'badge--err' : 'badge--warn'}">${signalLabel(r.signal)}</span></td>
        <td data-label="Nota"><span class="gradepill ${gClass(r.grade)}">${r.grade || '—'}</span></td>
        <td data-label="Score" class="num">${fmt(r.score, 1)}</td>
        <td data-label="Modelo" class="num">${r.modelProb === null || r.modelProb === undefined ? '<span class="muted">insuf.</span>' : fmtPct(r.modelProb)}</td>
        <td data-label="Histórico" class="num">${r.histRate === null || r.histRate === undefined ? '<span class="muted">insuf.</span>' : fmtPct(r.histRate) + `<small class="muted"> N=${r.histSamples}</small>`}</td>
        <td data-label="Vela prevista" class="mono small">${fmtTime(r.predictedCandleOpen)}–${fmtTime(r.predictedCandleClose)}</td>
        <td data-label="Status" class="${r.status === 'ACERTO' ? 'pos' : r.status === 'ERRO' ? 'neg' : 'neu'}">${r.status}</td>
        <td data-label="Variação" class="num ${r.outcome && r.outcome.changePct > 0 ? 'pos' : r.outcome && r.outcome.changePct < 0 ? 'neg' : ''}">${r.outcome ? fmtPct(r.outcome.changePct, 3) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Nenhum registro com estes filtros. Toda análise (inclusive AGUARDAR) é registrada para medir a distribuição real.</p>'}`;

  drawLine('hEvoChart', st.evolution.map((p, i) => ({ x: i + 1, y: p.rate })), { baseline: breakEvenRate((state.settings.payout || 85) / 100) * 100, label: 'taxa de acerto acumulada (%)', yMin: 0, yMax: 100 });
}

/* ============================ CORRETORA ============================ */
function handleBrokerFile(file) {
  try {
    const url = B.setImage(file);
    if (!url) return;
    $('#brokerImg').src = url;
    $('#brokerPreview').hidden = false;
    $('#bkAsset').value = state.asset.id;
    $('#bkTf').value = state.tf;
    if (state.result) renderBrokerChart(state.result);
    toast('Print carregado apenas no seu navegador (nada é enviado a servidor). Preencha o checklist para comparar.', 'info', 6000);
  } catch (e) { toast(e.message, 'err'); }
}
async function compareBroker() {
  if (!state.result || state.result.dataError) { toast('Rode uma análise antes de comparar.', 'warn'); return; }
  const feed = {
    candles: state.result.candles, source: state.result.sources[state.result.tfKey].source,
    assetId: state.result.asset.id, tf: state.result.tfKey
  };
  B.compare({ assetId: $('#bkAsset').value, tf: $('#bkTf').value, timeHHMM: $('#bkTime').value, price: $('#bkPrice').value }, feed, state.settings);
  renderBrokerResult();
  updateBrokerFlag();
  analyze();
}
function renderBrokerResult() {
  const c = B.brokerState.check;
  const host = $('#bkResult');
  if (!c) { host.innerHTML = '<p class="muted small">Preencha o checklist e clique em comparar.</p>'; return; }
  host.innerHTML = `${c.ok ? '<p class="badge badge--ok">feed conferido: sem divergência relevante</p>' : `<div class="errbox"><b>⚠️ NÃO OPERAR — feed da corretora divergente</b><ul class="bullets small">${c.problems.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
      <p class="small">Enquanto esta divergência estiver marcada, os sinais desta sessão são <strong>bloqueados</strong> (aparecem como AGUARDAR com o motivo).</p></div>`}
    <div class="tablewrap"><table class="stack"><thead><tr><th>Item</th><th>Na corretora</th><th>No feed (${escapeHtml(c.source || '—')})</th><th>Confere?</th></tr></thead><tbody>
      ${c.rows.map(r => `<tr><td data-label="Item">${escapeHtml(r.item)}</td><td data-label="Corretora" class="mono">${escapeHtml(String(r.corretora))}</td><td data-label="Feed" class="mono">${escapeHtml(String(r.feed))}</td><td data-label="Confere">${r.ok ? '<span class="pos">✓</span>' : '<span class="neg">×</span>'} <span class="muted small">${escapeHtml(r.detail || '')}</span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted">Verificado ${fmtDateTime(c.at)} · tolerância de preço ${c.tolPct}% e no máximo 1 vela de defasagem. A leitura da imagem é manual — o app não interpreta o print.</p>`;
}
function updateBrokerFlag() { $('#brokerFlag').hidden = !B.brokerState.divergent; }

/* ============================ CONFIGURAÇÕES ============================ */
const TOGGLE_LABELS = { ema: 'EMAs / tendência', rsi: 'RSI', macd: 'MACD', stoch: 'Estocástico', volume: 'Volume', bollinger: 'Bollinger', estrutura: 'Estrutura (HH/HL)', sr: 'Zonas de S/R', priceaction: 'Price action', atr: 'ATR / volatilidade', multitf: 'Multi-timeframe' };
const WEIGHT_LABELS = { tendencia: 'Tendência', momentum: 'Momentum', multitf: 'Multi-TF', priceaction: 'Price Action', sr: 'S/R', volatilidade: 'Volatilidade', volume: 'Volume' };

function renderConfig() {
  const s = state.settings;
  const set = (sel, v) => { const el = $(sel); if (el) el.value = v; };
  set('#cfgMinScore', s.minScore); set('#cfgMinConf', s.minConfluence); set('#cfgMinSamples', s.minSamples);
  set('#cfgMinSetup', s.minSetupSamples); set('#cfgMaxDist', s.maxDistance); set('#cfgMinZone', s.minZoneAtr);
  set('#cfgEvGate', s.evGate); set('#cfgDeep', s.deepCandles); set('#cfgRefresh', s.refreshSec);
  set('#cfgAsset', s.defaultAsset); set('#cfgTf', s.defaultTf);
  set('#cfgBanca', s.banca); set('#cfgStake', s.stake); set('#cfgPayout', s.payout); set('#cfgBrokerTol', s.brokerTolPct);
  $('#cfgSound').checked = !!s.alertSound; $('#cfgVisual').checked = !!s.alertVisual;
  $('#cfgNotif').checked = !!s.alertNotification; $('#cfgUseMl').checked = !!s.useMl;
  $('#cfgOnlyA').checked = s.alertOnlyAGrades !== false;
  $$('#modeBtns .btn').forEach(b => b.classList.toggle('btn--primary', b.dataset.mode === s.mode));
  const be = breakEvenRate((s.payout || 85) / 100) * 100;
  $('#breakEvenNote').innerHTML = `Com payout de <strong>${s.payout}%</strong>, o ponto de equilíbrio é <strong>${fmtPct(be)}</strong> de acerto. Exemplo: 75% de acerto → EV de <strong>R$ ${fmt(expectancy(0.75, (s.payout || 85) / 100, s.stake || 5), 3)}</strong> por operação de R$ ${s.stake}; 52% de acerto → <strong>R$ ${fmt(expectancy(0.52, (s.payout || 85) / 100, s.stake || 5), 3)}</strong> (negativo).`;

  $('#weightList').innerHTML = '<p class="muted small">Pesos das categorias (relativos; a soma é normalizada)</p>' + Object.entries(WEIGHT_LABELS).map(([k, l]) =>
    `<label>${l} <input type="number" min="0" max="40" data-weight="${k}" value="${s.weights[k]}"></label>`).join('');
  $('#toggleList').innerHTML = '<p class="muted small">Ligar/desligar componentes</p>' + Object.entries(TOGGLE_LABELS).map(([k, l]) =>
    `<label class="check"><input type="checkbox" data-toggle="${k}" ${s.toggles[k] ? 'checked' : ''}> ${l}</label>`).join('');
  const thr = Object.entries(s.thresholds || {});
  $('#thresholdList').innerHTML = thr.length
    ? 'Limiares aplicados por ativo+timeframe: ' + thr.map(([k, v]) => `<span class="badge">${escapeHtml(k)} → ${v}</span>`).join(' ') + ' <button class="btn btn--ghost" id="clearThr" type="button">limpar</button>'
    : 'Nenhum limiar específico aplicado (use a varredura do backtest → APLICAR ESTE THRESHOLD).';
  const ct = document.getElementById('clearThr');
  if (ct) ct.addEventListener('click', () => { state.settings.thresholds = {}; saveSettings(); renderConfig(); analyze(); });

  const bindNum = (sel, key) => { const el = $(sel); if (el) el.onchange = e => { state.settings[key] = Number(e.target.value); saveSettings(); renderConfig(); }; };
  bindNum('#cfgMinScore', 'minScore'); bindNum('#cfgMinConf', 'minConfluence'); bindNum('#cfgMinSamples', 'minSamples');
  bindNum('#cfgMinSetup', 'minSetupSamples'); bindNum('#cfgMaxDist', 'maxDistance'); bindNum('#cfgMinZone', 'minZoneAtr');
  bindNum('#cfgDeep', 'deepCandles'); bindNum('#cfgRefresh', 'refreshSec');
  bindNum('#cfgBanca', 'banca'); bindNum('#cfgStake', 'stake'); bindNum('#cfgPayout', 'payout'); bindNum('#cfgBrokerTol', 'brokerTolPct');
  $('#cfgEvGate').onchange = e => { state.settings.evGate = e.target.value; saveSettings(); analyze(); };
  $('#cfgAsset').onchange = e => { state.settings.defaultAsset = e.target.value; saveSettings(); };
  $('#cfgTf').onchange = e => { state.settings.defaultTf = e.target.value; saveSettings(); };
  $('#cfgSound').onchange = e => { state.settings.alertSound = e.target.checked; saveSettings(); };
  $('#cfgVisual').onchange = e => { state.settings.alertVisual = e.target.checked; saveSettings(); };
  $('#cfgNotif').onchange = e => { state.settings.alertNotification = e.target.checked; saveSettings(); };
  $('#cfgUseMl').onchange = e => { state.settings.useMl = e.target.checked; saveSettings(); analyze(); };
  $('#cfgOnlyA').onchange = e => { state.settings.alertOnlyAGrades = e.target.checked; saveSettings(); };
  $$('#toggleList input').forEach(i => i.onchange = () => { state.settings.toggles[i.dataset.toggle] = i.checked; saveSettings(); analyze(); });
  $$('#weightList input').forEach(i => i.onchange = () => { state.settings.weights[i.dataset.weight] = Number(i.value); saveSettings(); analyze(); });
  $('#notifStatus').textContent = notifState.supported
    ? `Permissão atual: ${typeof Notification !== 'undefined' ? Notification.permission : 'desconhecida'}.`
    : 'A API de notificações não está disponível neste contexto (iframe sandbox).';
}

/* ============================ gráficos simples em canvas ============================ */
function drawLine(id, points, { baseline = null, label = '', yMin = null, yMax = null } = {}) {
  const cv = document.getElementById(id);
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600, h = cv.clientHeight || 190;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const cLine = css.getPropertyValue('--line').trim() || '#232a36';
  const cCall = css.getPropertyValue('--call').trim() || '#2fbf71';
  const cPut = css.getPropertyValue('--put').trim() || '#f04b52';
  const cDim = css.getPropertyValue('--text-mute').trim() || '#6c7788';
  ctx.clearRect(0, 0, w, h);
  if (!points.length) {
    ctx.fillStyle = cDim; ctx.font = '12px JetBrains Mono, monospace';
    ctx.fillText('sem dados suficientes', 12, h / 2);
    return;
  }
  const pad = 34;
  const ys = points.map(p => p.y).concat(baseline === null ? [] : [baseline]);
  const min = yMin !== null ? yMin : Math.min(...ys);
  const max = yMax !== null ? yMax : Math.max(...ys);
  const x = i => pad + (i / Math.max(1, points.length - 1)) * (w - pad * 1.3);
  const y = v => h - 20 - ((v - min) / Math.max(1e-9, max - min)) * (h - 40);
  if (baseline !== null) {
    ctx.strokeStyle = cLine; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, y(baseline)); ctx.lineTo(w - pad * .3, y(baseline)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cDim; ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(fmt(baseline, 1), 3, y(baseline) - 3);
  }
  ctx.strokeStyle = points[points.length - 1].y >= (baseline === null ? points[0].y : baseline) ? cCall : cPut;
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(x(i), y(p.y)) : ctx.moveTo(x(i), y(p.y)));
  ctx.stroke();
  ctx.fillStyle = cDim; ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText(fmt(max, 1), 3, y(max) + 9);
  ctx.fillText(fmt(min, 1), 3, y(min) - 2);
  ctx.fillText(label, w - Math.min(200, ctx.measureText(label).width + 8), 12);
}

function drawReliability(rel) {
  const cv = document.getElementById('relChart');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600, h = cv.clientHeight || 190;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const cDim = css.getPropertyValue('--text-mute').trim() || '#6c7788';
  const cAcc = css.getPropertyValue('--accent').trim() || '#4c8dff';
  const cLine = css.getPropertyValue('--line').trim() || '#232a36';
  if (!rel || !rel.some(b => b.n > 0)) {
    ctx.fillStyle = cDim; ctx.font = '12px JetBrains Mono, monospace';
    ctx.fillText('treine um modelo para ver a curva de calibração', 12, h / 2);
    return;
  }
  const pad = 30;
  const X = p => pad + p * (w - pad * 1.4);
  const Y = p => h - pad + 8 - p * (h - pad * 1.6);
  ctx.strokeStyle = cLine; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = cAcc; ctx.lineWidth = 1.8;
  ctx.beginPath();
  let started = false;
  for (const b of rel) {
    if (!b.n || b.previsto === null || b.realizado === null) continue;
    const px = X(b.previsto), py = Y(b.realizado);
    started ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    started = true;
  }
  ctx.stroke();
  ctx.fillStyle = cAcc;
  for (const b of rel) {
    if (!b.n || b.previsto === null || b.realizado === null) continue;
    ctx.beginPath(); ctx.arc(X(b.previsto), Y(b.realizado), Math.max(2, Math.min(6, Math.sqrt(b.n))), 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = cDim; ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('previsto →', w - 76, h - 8);
  ctx.fillText('realizado ↑', 4, 12);
}

function enhanceAccessibleTables(root = document) {
  const tables = root instanceof HTMLTableElement
    ? [root]
    : [...(root.querySelectorAll?.('table') || [])];
  for (const table of tables) {
    table.querySelectorAll('thead th').forEach(th => th.setAttribute('scope', 'col'));
    if (table.querySelector(':scope > caption')) continue;
    const container = table.closest('section, article, details, .card, .panel, .details__body') || table.parentElement;
    const heading = container?.querySelector('h1, h2, h3, summary');
    const caption = document.createElement('caption');
    caption.className = 'sr-only';
    caption.textContent = heading?.textContent?.trim()
      ? `Tabela: ${heading.textContent.trim()}`
      : 'Tabela de detalhes da análise';
    table.prepend(caption);
  }
}

// Several analytical tables are rendered after data arrives.  Enhance every
// new table at the DOM boundary so screen-reader semantics cannot depend on a
// particular rendering path.
const tableAccessibilityObserver = new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element) enhanceAccessibleTables(node);
    }
  }
});
tableAccessibilityObserver.observe(document.documentElement, { childList: true, subtree: true });
enhanceAccessibleTables();

window.addEventListener('error', e => console.error(e.error || e.message));
init();
