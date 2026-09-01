// market-worker.js — Worker de cálculo para treino, inferência e varredura.
// Deve ser criado pela UI com:
//   new Worker(new URL('./market-worker.js', import.meta.url), { type: 'module' })
// Protocolo: pedidos possuem { id, type, ...payload }. Eventos devolvem o mesmo id.

import { trainLogistic, predict } from './ml.js';
import { analyzeAsset, buildSnapshotPool } from './analyze.js';
import { getCandles, DEPTH_TARGET } from './data.js';
import { runBacktest } from './backtest.js';

const PROTOCOL_VERSION = 1;
const cancelled = new Set();
let queue = Promise.resolve();

function post(message, transfer = undefined) {
  if (transfer && transfer.length) self.postMessage(message, transfer);
  else self.postMessage(message);
}

function errorPayload(error) {
  return {
    name: error && error.name ? error.name : 'Error',
    message: error && error.message ? error.message : String(error || 'Erro desconhecido'),
    stack: error && error.stack ? String(error.stack) : undefined
  };
}

function progress(id, stage, data = {}) {
  post({ id, type: 'progress', stage, at: Date.now(), ...data });
}

function isCancelled(id) { return cancelled.has(id); }

function throwIfCancelled(id) {
  if (isCancelled(id)) {
    const error = new Error('Tarefa cancelada.');
    error.name = 'AbortError';
    throw error;
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} é obrigatório.`);
  return value;
}

function summarizeAnalysis(result) {
  // O scanner retorna apenas o necessário para a lista. A análise profunda usa `analyze`.
  return {
    asset: result.asset,
    tfKey: result.tfKey,
    at: result.at,
    verdict: result.verdict,
    dataError: !!result.dataError,
    errors: result.errors || [],
    warnings: result.warnings || [],
    dataFreshness: result.dataFreshness || null,
    calendar: result.calendar || null,
    expiry: result.expiry || null,
    filters: result.filters || null,
    candleCount: result.candleCount,
    totalCandles: result.totalCandles,
    inProgressCandle: !!result.inProgressCandle,
    snapshot: result.snapshot ? {
      t: result.snapshot.t,
      price: result.snapshot.price,
      candle: result.snapshot.candle,
      vector: result.snapshot.vector
    } : null,
    score: result.score ? {
      score: result.score.score,
      bias100: result.score.bias100,
      direction: result.score.direction,
      confluence: result.score.confluence,
      categories: result.score.categories
    } : null,
    grade: result.grade || null,
    decision: result.decision ? {
      verdict: result.decision.verdict,
      blocked: result.decision.blocked,
      reasons: result.decision.reasons,
      estimate: result.decision.estimate,
      ev: result.decision.ev,
      payout: result.decision.payout,
      expiryCandles: result.decision.expiryCandles,
      expiryReason: result.decision.expiryReason,
      filters: result.decision.filters || null
    } : null,
    why: result.why || [],
    sources: result.sources || {},
    ml: result.ml || null,
    confluence: result.confluence
  };
}

function modelForAsset(models, asset, tfKey) {
  if (!models || typeof models !== 'object') return null;
  const id = `${asset.id}|${tfKey}`;
  // Aceita tanto {'BTCUSDT|M5': model} quanto {'ma_model_v2_BTCUSDT|M5': model}.
  return models[id] || models[`ma_model_v2_${id}`] || null;
}

async function trainSamples(id, samples, rawOptions = {}) {
  const options = (rawOptions && typeof rawOptions === 'object') ? rawOptions : {};
  const userProgress = Number.isFinite(options.progressEvery) ? Math.max(1, options.progressEvery) : 1;
  let lastProgress = -Infinity;
  progress(id, 'training', { progress: 0, samples: samples.length, text: 'Preparando treino local…' });

  const model = await trainLogistic(samples, {
    epochs: Number.isFinite(options.epochs) ? options.epochs : 350,
    lr: Number.isFinite(options.lr) ? options.lr : undefined,
    l2: Number.isFinite(options.l2) ? options.l2 : undefined,
    minValid: Number.isFinite(options.minValid) ? options.minValid : undefined,
    onProgress: value => {
      if (isCancelled(id)) return;
      const percent = Math.round(value * 100);
      if (percent === 100 || percent - lastProgress >= userProgress) {
        lastProgress = percent;
        progress(id, 'training', { progress: value, percent, samples: samples.length, text: `Treinando modelo: ${percent}%` });
      }
    }
  });
  throwIfCancelled(id);
  return model;
}

async function handleTrain(message) {
  const { id } = message;
  if (!Array.isArray(message.samples)) throw new TypeError('train requer samples: [{ vector, label }].');
  throwIfCancelled(id);
  return trainSamples(id, message.samples, message.options);
}

/** Caminho completo: rede, preparação e treino permanecem no Worker. */
async function handleTrainAsset(message) {
  const { id } = message;
  const asset = assertObject(message.asset, 'asset');
  if (!message.tfKey) throw new TypeError('trainAsset requer tfKey.');
  const options = (message.options && typeof message.options === 'object') ? message.options : {};
  const requestedTarget = Number(message.target ?? options.target ?? DEPTH_TARGET.deep);
  const target = Math.max(500, Math.min(50000, Number.isFinite(requestedTarget) ? Math.round(requestedTarget) : DEPTH_TARGET.deep));
  throwIfCancelled(id);

  progress(id, 'fetch', {
    progress: 0, assetId: asset.id, assetName: asset.name || asset.id, target,
    text: `Buscando candles fechados de ${asset.name || asset.id}…`
  });
  const data = await getCandles(asset, message.tfKey, {
    depth: 'deep', target, includeLive: false,
    onProgress: (value, count) => progress(id, 'fetch', {
      progress: value, count, target, assetId: asset.id, assetName: asset.name || asset.id,
      text: `Baixando histórico: ${count} candles…`
    })
  });
  throwIfCancelled(id);

  progress(id, 'preparing', {
    progress: 0, candleCount: data.candles.length, assetId: asset.id, assetName: asset.name || asset.id,
    text: `Preparando indicadores em ${data.candles.length} candles fechados…`
  });
  const { snaps } = buildSnapshotPool(data.candles, data.hasVolume, {
    zoneLookback: Number.isFinite(options.zoneLookback) ? options.zoneLookback : 160,
    stride: Number.isFinite(options.stride) && options.stride > 0 ? Math.floor(options.stride) : 1,
    max: Number.isFinite(options.maxSnapshots) && options.maxSnapshots > 0 ? Math.floor(options.maxSnapshots) : 0
  });
  throwIfCancelled(id);
  const labeled = snaps
    .filter(s => s.nextDir !== null && Array.isArray(s.vector));
  const ties = labeled.filter(s => s.nextDir === 0).length;
  const samples = labeled
    .filter(s => s.nextDir !== 0)
    .map(s => ({ vector: s.vector, label: s.nextDir > 0 ? 1 : 0 }));
  progress(id, 'preparing', {
    progress: 1, candleCount: data.candles.length, samples: samples.length,
    assetId: asset.id, assetName: asset.name || asset.id,
    text: `${samples.length} exemplos direcionais e ${ties} empates cronológicos prontos para validação.`
  });

  const model = await trainSamples(id, samples, options);
  if (model && model.ok) {
    // A regressão é binária e é treinada apenas nos desfechos direcionais.
    // Guardamos separadamente a frequência suavizada de empate para que a
    // decisão/EV não trate os dojis como se nunca pudessem acontecer.
    model.tieRate = labeled.length ? (ties + 1) / (labeled.length + 2) : null;
    model.tieSamples = labeled.length;
  }
  return {
    model,
    samples: samples.length,
    tieSamples: labeled.length,
    ties,
    candleCount: data.candles.length,
    source: data.source,
    updatedAt: data.updatedAt,
    hasVolume: data.hasVolume,
    target,
    stale: !!data.stale
  };
}

async function handlePredict(message) {
  assertObject(message.model, 'model');
  if (!Array.isArray(message.vector)) throw new TypeError('predict requer vector: number[].');
  const p = predict(message.model, message.vector);
  return { probabilityUp: p, usable: !!message.model.usable, trainedAt: message.model.trainedAt || null };
}

function analysisOptions(message, id, asset = null) {
  return {
    light: !!message.light,
    historyTarget: Number.isFinite(Number(message.historyTarget)) ? Number(message.historyTarget) : undefined,
    includeLive: message.includeLive !== false,
    model: message.model || null,
    // Só rankings reais chegam aqui. Eles são separados por ativo/TF/expiração
    // pelo próprio evaluateBar; nenhum ranking hipotético de backtest participa.
    setupRankings: message.setupRankings || null,
    setupRanking: message.setupRanking || null,
    calendarSnapshot: message.calendarSnapshot || null,
    brokerDivergence: message.brokerDivergence || null,
    onStage: text => progress(id, 'analysis', { text }),
    onFetchProgress: (value, count) => progress(id, 'fetch', { progress: value, count })
  };
}

async function handleAnalyze(message) {
  const { id } = message;
  const asset = assertObject(message.asset, 'asset');
  if (!message.tfKey) throw new TypeError('analyze requer tfKey.');
  throwIfCancelled(id);
  progress(id, 'analysis', { text: `Analisando ${asset.name || asset.id}…` });
  const result = await analyzeAsset(asset, message.tfKey, message.settings || {}, analysisOptions(message, id, asset));
  throwIfCancelled(id);
  return result;
}

async function handleScan(message) {
  const { id } = message;
  if (!Array.isArray(message.assets) || !message.assets.length) throw new TypeError('scan requer uma lista não vazia de assets.');
  if (!message.tfKey) throw new TypeError('scan requer tfKey.');

  const total = message.assets.length;
  const rows = new Array(total);
  const failures = [];
  const options = { ...message, light: message.light !== false, includeLive: message.includeLive !== false };
  const concurrency = Math.max(1, Math.min(3, Math.floor(Number(message.scanConcurrency) || 2), total));
  let cursor = 0;
  let completed = 0;
  const runNext = async () => {
    while (true) {
      throwIfCancelled(id);
      const index = cursor++;
      if (index >= total) return;
      const asset = assertObject(message.assets[index], `assets[${index}]`);
      const report = (stage, extra = {}) => progress(id, stage, {
        index: completed,
        completed,
        position: index + 1,
        total,
        assetId: asset.id,
        assetName: asset.name || asset.id,
        ...extra
      });
      report('scan', { text: `Analisando ${asset.name || asset.id} — item ${index + 1} de ${total}` });
      try {
        const result = await analyzeAsset(asset, message.tfKey, message.settings || {}, {
          ...analysisOptions({ ...options, model: modelForAsset(message.models, asset, message.tfKey) }, id, asset),
          onStage: text => report('scan', { text }),
          onFetchProgress: (value, count) => report('fetch', { progress: value, count })
        });
        throwIfCancelled(id);
        rows[index] = message.returnFull ? { asset, result } : { asset, result: summarizeAnalysis(result) };
        // Entrega cada ativo assim que termina. A UI pode montar um ranking
        // parcial enquanto os demais continuam, sem esperar o lote inteiro.
        report('scan', { partialRow: rows[index], text: `${asset.name || asset.id} concluído` });
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        failures.push({ assetId: asset.id, assetName: asset.name || asset.id, message: error && error.message ? error.message : String(error) });
        report('scan', { warning: true, text: `Sem dados para ${asset.name || asset.id}; continuando…` });
      } finally {
        completed += 1;
        report('scan', { index: completed, completed, text: `${completed} de ${total} ativos concluídos` });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => runNext()));
  return { rows: rows.filter(Boolean), failures, total, completedAt: Date.now() };
}

/** Backtest também fica fora da thread visual; o mesmo motor causal é preservado. */
async function handleBacktest(message) {
  const { id } = message;
  const asset = assertObject(message.asset, 'asset');
  if (!message.tfKey) throw new TypeError('backtest requer tfKey.');
  throwIfCancelled(id);
  const options = (message.options && typeof message.options === 'object') ? message.options : {};
  const result = await runBacktest(asset, message.tfKey, message.settings || {}, {
    hourFilter: options.hourFilter || null,
    maxTests: Number.isFinite(Number(options.maxTests)) ? Number(options.maxTests) : undefined,
    model: null,
    onProgress: (value, text) => progress(id, 'backtest', { progress: value, text, assetId: asset.id, assetName: asset.name || asset.id })
  });
  throwIfCancelled(id);
  return result;
}

async function dispatch(message) {
  switch (message.type) {
    case 'ping':
      return {
        protocolVersion: PROTOCOL_VERSION,
        worker: 'market-worker',
        capabilities: ['train', 'trainAsset', 'predict', 'analyze', 'scan', 'backtest', 'cancel'],
        at: Date.now()
      };
    case 'train': return handleTrain(message);
    case 'trainAsset': return handleTrainAsset(message);
    case 'predict': return handlePredict(message);
    case 'analyze': return handleAnalyze(message);
    case 'scan': return handleScan(message);
    case 'backtest': return handleBacktest(message);
    default: throw new TypeError(`Tipo de mensagem desconhecido: ${String(message.type)}`);
  }
}

async function run(message) {
  const id = message.id;
  try {
    const result = await dispatch(message);
    if (!isCancelled(id)) post({ id, type: 'result', result, at: Date.now() });
    else post({ id, type: 'cancelled', at: Date.now() });
  } catch (error) {
    if (error && error.name === 'AbortError') post({ id, type: 'cancelled', at: Date.now() });
    else post({ id, type: 'error', error: errorPayload(error), at: Date.now() });
  } finally {
    cancelled.delete(id);
  }
}

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'cancel') {
    if (message.id !== undefined && message.id !== null) cancelled.add(message.id);
    post({ id: message.id, type: 'cancel-requested', at: Date.now() });
    return;
  }
  if (message.id === undefined || message.id === null) {
    post({ id: null, type: 'error', error: { name: 'TypeError', message: 'Toda mensagem deve incluir um id.' }, at: Date.now() });
    return;
  }
  // Uma fila única evita que dois treinos pesados disputem CPU no mesmo Worker.
  queue = queue.then(() => run(message), () => run(message));
});

self.addEventListener('unhandledrejection', event => {
  post({ id: null, type: 'error', error: errorPayload(event.reason), at: Date.now() });
});

post({ type: 'ready', protocolVersion: PROTOCOL_VERSION, worker: 'market-worker', at: Date.now() });
