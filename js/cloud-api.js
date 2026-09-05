// cloud-api.js — leitura do motor oficial 24/7.
// O backend congelado é a fonte oficial exibida; o motor local permanece
// separado e complementar, sem contaminar o ledger cloud.
import { getKv, setKv } from './persistence.js';

const CACHE_KEY = 'signal_atlas_cloud_snapshot_v5';
const FALLBACK_STORAGE_KEY = 'signal_atlas_cloud_snapshot_v5';
const DEFAULT_TIMEOUT_MS = 5000;

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(row, keys, fallback = null) {
  if (!row || typeof row !== 'object') return fallback;
  for (const key of keys) {
    if (row[key] !== null && row[key] !== undefined && row[key] !== '') return row[key];
  }
  return fallback;
}

function rows(value) {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
  if (value && Array.isArray(value.data)) return value.data.filter(item => item && typeof item === 'object');
  if (value && typeof value === 'object') return [value];
  return [];
}

function normalizeDirection(value) {
  const direction = text(value).toUpperCase();
  if (['BUY', 'CALL', 'COMPRA', 'LONG', '1'].includes(direction)) return 'CALL';
  if (['SELL', 'PUT', 'VENDA', 'SHORT', '-1'].includes(direction)) return 'PUT';
  return 'AGUARDAR';
}

function normalizeQuality(value) {
  const quality = text(value).toUpperCase();
  if (/CONFIRM|APROV|VALID/.test(quality)) return 'CONFIRMADO';
  if (/TECN|FRACA|LOW_STAT/.test(quality)) return 'TECNICO';
  if (/BAIX|LOW|INFORM|WAIT|AGUARD/.test(quality)) return 'BAIXA';
  return 'REFERENCIA';
}

function normalizeOutcome(value) {
  const outcome = text(value).toUpperCase();
  if (['WIN', 'ACERTO', 'HIT'].includes(outcome)) return 'ACERTO';
  if (['LOSS', 'ERRO', 'MISS'].includes(outcome)) return 'ERRO';
  if (['TIE', 'NEUTRO', 'DRAW'].includes(outcome)) return 'NEUTRO';
  if (['PENDING', 'PENDENTE', 'OPEN'].includes(outcome)) return 'PENDENTE';
  if (['UNRESOLVED_MISSING_DATA', 'DADOS_AUSENTES', 'PERMANENTLY_MISSING'].includes(outcome)) return 'DADOS_AUSENTES';
  if (['AWAITING_RESOLUTION', 'AGUARDANDO_RESOLUCAO'].includes(outcome)) return 'PENDENTE';
  return outcome || 'N/A';
}

function normalizeExplanation(row) {
  const raw = firstValue(row, ['reasons'], []);
  return {
    id: text(firstValue(row, ['id', 'decision_id'])),
    reasons: (Array.isArray(raw) ? raw : []).map(text).filter(Boolean).slice(0, 24)
  };
}

export function normalizeCloudGradeHistory(row, index = 0) {
  const base = normalizeReference(row, index);
  return {
    ...base,
    entryAt: timestamp(firstValue(row, ['entry_at'])),
    expiryAt: timestamp(firstValue(row, ['expiry_at'])),
    resolvedAt: timestamp(firstValue(row, ['resolved_at', 'abandoned_at'])),
    entryPrice: finite(firstValue(row, ['entry_price'])),
    closePrice: finite(firstValue(row, ['close_price'])),
    pnl: finite(firstValue(row, ['pnl'])),
  };
}

function normalizePercent(value) {
  const number = finite(value);
  if (number === null) return null;
  return Math.abs(number) <= 1 ? number * 100 : number;
}

function normalizeMode(value) {
  // The database keeps legacy modes for audit, while the public application
  // always consumes the single current policy stored under the neutral enum.
  return 'neutro';
}

function cacheKey(mode) {
  return `${CACHE_KEY}:${normalizeMode(mode)}`;
}

function normalizeReference(row, index = 0) {
  const symbol = text(firstValue(row, ['symbol', 'asset', 'asset_id', 'ticker', 'pair'], '—')) || '—';
  const tf = text(firstValue(row, ['timeframe', 'tf', 'interval'], '—')).toUpperCase() || '—';
  const decisionAt = timestamp(firstValue(row, ['decision_at', 'emitted_at', 'created_at', 'updated_at', 'collected_at']));
  const expiryRaw = firstValue(row, ['expiration', 'expiry', 'expiry_candles'], null);
  const expiry = expiryRaw === null ? null : /^E/i.test(text(expiryRaw)) ? text(expiryRaw).toUpperCase() : `E${Math.max(1, Math.round(Number(expiryRaw) || 1))}`;
  const historicalWinRate = normalizePercent(firstValue(row, ['historical_win_rate', 'win_rate', 'hit_rate', 'accuracy']));
  const modelConfidence = normalizePercent(firstValue(row, ['probability', 'confidence', 'win_probability', 'estimated_probability']));
  return {
    id: text(firstValue(row, ['id', 'signal_id', 'decision_id'], `cloud-${symbol}-${tf}-${decisionAt || index}`)),
    symbol,
    tf,
    verdict: normalizeDirection(firstValue(row, ['direction', 'verdict', 'signal', 'side', 'decision'])),
    quality: normalizeQuality(firstValue(row, ['quality', 'signal_quality', 'decision_quality', 'status'])),
    score: finite(firstValue(row, ['score', 'strength', 'force_score', 'technical_score'])),
    confidence: historicalWinRate ?? modelConfidence,
    historicalWinRate,
    modelConfidence,
    probabilityLb: normalizePercent(firstValue(row, ['probability_lb'])),
    benchmarkWinRate: normalizePercent(firstValue(row, ['benchmark_win_rate'], 0.5)),
    samples: finite(firstValue(row, ['resolved', 'samples', 'n', 'sample_size'])),
    validationSamples: finite(firstValue(row, ['sample_size'])),
    ev: finite(firstValue(row, ['ev_net', 'ev', 'expected_value', 'ev_net_per_trade'])),
    historicalEv: finite(firstValue(row, ['historical_ev_net', 'ev_net_per_trade'])),
    benchmarkEv: finite(firstValue(row, ['benchmark_ev_per_trade'])),
    rank: finite(firstValue(row, ['rank', 'position', 'ranking'])),
    rankingScore: finite(firstValue(row, ['ranking_score'])),
    grade: text(firstValue(row, ['grade'], 'D')).toUpperCase() || 'D',
    mode: normalizeMode(firstValue(row, ['mode'], 'neutro')),
    sampleStatus: text(firstValue(row, ['sample_status'])),
    expiry,
    outcome: normalizeOutcome(firstValue(row, ['outcome', 'result', 'resolution'])),
    reason: text(firstValue(row, ['reason', 'primary_reason', 'explanation', 'wait_reason'])),
    decisionAt,
    dataAgeMs: finite(firstValue(row, ['data_age_ms'])),
    sourceLatencyMs: finite(firstValue(row, ['source_latency_ms'])),
    entryAt: timestamp(firstValue(row, ['entry_at'])),
    expiryAt: timestamp(firstValue(row, ['expiry_at'])),
    referencePrice: finite(firstValue(row, ['reference_price'])),
    confluenceCount: finite(firstValue(row, ['confluence_count'])),
    source: text(firstValue(row, ['source'])),
    decisionStatus: text(firstValue(row, ['status'])).toLowerCase(),
    championPromoted: firstValue(row, ['champion_promoted_prospectively'], false) === true,
    promotionReviewId: text(firstValue(row, ['promotion_review_id'])),
    promotionPairedSamples: finite(firstValue(row, ['promotion_paired_samples'])) || 0,
    confirmedPass: firstValue(row, ['confirmed_pass'], false) === true,
    qualityContractVersion: finite(firstValue(row, ['quality_contract_version'])),
    evLb95: finite(firstValue(row, ['ev_lb95'])),
    usedLiveCandle: firstValue(row, ['used_live_candle', 'live_candle_used'], null) === true,
    origin: 'cloud-reference',
    rankEligible: false
  };
}

function normalizeCanonical(row, index = 0) {
  const reference = normalizeReference(row, index);
  const rawReasons = firstValue(row, ['reasons'], []);
  return {
    ...reference,
    criteria: (Array.isArray(rawReasons) ? rawReasons : []).map(text).filter(Boolean).slice(0, 32),
    origin: 'cloud-canonical',
    rankEligible: false,
  };
}

function normalizeMetric(row, index = 0) {
  const base = normalizeReference(row, index);
  return {
    ...base,
    resolved: finite(firstValue(row, ['resolved', 'resolved_signals', 'trades', 'total_resolved'])) || 0,
    wins: finite(firstValue(row, ['wins', 'hits', 'acertos'])) || 0,
    losses: finite(firstValue(row, ['losses', 'misses', 'erros'])) || 0,
    ties: finite(firstValue(row, ['ties', 'draws', 'empates'])) || 0,
    winRate: normalizePercent(firstValue(row, ['win_rate', 'hit_rate', 'accuracy'])),
    calibrationGap: normalizePercent(firstValue(row, ['calibration_gap']))
  };
}

function normalizePaper(row) {
  if (!row) return null;
  return {
    trades: finite(firstValue(row, ['trades', 'resolved_trades', 'total_trades'])) || 0,
    wins: finite(firstValue(row, ['wins', 'hits', 'acertos'])) || 0,
    losses: finite(firstValue(row, ['losses', 'misses', 'erros'])) || 0,
    ties: finite(firstValue(row, ['ties', 'draws', 'empates'])) || 0,
    winRate: normalizePercent(firstValue(row, ['win_rate', 'hit_rate', 'accuracy'])),
    ev: finite(firstValue(row, ['ev_net_per_trade', 'paper_ev', 'ev', 'avg_pnl'])),
    totalPnl: finite(firstValue(row, ['total_pnl', 'pnl', 'final_equity', 'net_result'])),
    maxDrawdown: finite(firstValue(row, ['max_drawdown', 'drawdown', 'max_dd'])),
    mode: normalizeMode(firstValue(row, ['mode'], 'neutro')),
    quality: normalizeQuality(firstValue(row, ['quality'], '')),
    sampleStatus: text(firstValue(row, ['sample_status'])),
    benchmarkEv: finite(firstValue(row, ['benchmark_ev_per_trade'])),
    edgeVsBenchmark: finite(firstValue(row, ['edge_vs_benchmark'])),
    updatedAt: timestamp(firstValue(row, ['updated_at', 'resolved_at', 'calculated_at', 'created_at'])),
    origin: 'cloud-reference',
    rankEligible: false
  };
}

function normalizeHealth(row) {
  if (!row) return null;
  return {
    processedAsset: text(firstValue(row, ['processed_asset', 'current_asset', 'last_symbol', 'symbol', 'asset'], '—')) || '—',
    timeframe: text(firstValue(row, ['timeframe', 'tf', 'interval'], '')),
    lastCollectionAt: timestamp(firstValue(row, ['last_collection_at', 'last_collected_at', 'collected_at', 'last_run_at', 'updated_at'])),
    resolvedProspective: finite(firstValue(row, ['resolved_prospective_signals', 'prospective_resolved', 'resolved_signals', 'total_resolved'])),
    status: text(firstValue(row, ['status', 'state', 'worker_status'], 'online')) || 'online',
    origin: 'cloud-reference',
    rankEligible: false
  };
}

function configured(raw = globalThis.SIGNAL_ATLAS_CLOUD_CONFIG) {
  const url = text(raw && raw.url);
  const publishableKey = text(raw && raw.publishableKey);
  return { enabled: !!url && !!publishableKey, url, publishableKey };
}

function restBase(rawUrl) {
  const parsed = new URL(rawUrl, globalThis.location && globalThis.location.href || undefined);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname))) {
    throw new Error('A nuvem exige HTTPS.');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '') + '/rest/v1';
  return parsed.toString().replace(/\/$/, '');
}

function functionsBase(rawUrl) {
  const parsed = new URL(rawUrl, globalThis.location && globalThis.location.href || undefined);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname))) {
    throw new Error('A nuvem exige HTTPS.');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/(?:rest|functions)\/v1$/i, '') + '/functions/v1';
  return parsed.toString().replace(/\/$/, '');
}

function endpoint(base, view, params) {
  const url = new URL(`${base}/${view}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function request(url, publishableKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { apikey: publishableKey, Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function localStorageValue(mode) {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(`${FALLBACK_STORAGE_KEY}:${normalizeMode(mode)}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

async function readCache(mode) {
  try {
    const saved = await getKv(cacheKey(mode), null);
    if (saved && typeof saved === 'object') return saved;
  } catch (_) { /* IndexedDB opcional; tenta o espelho abaixo. */ }
  return localStorageValue(mode);
}

async function writeCache(snapshot, mode) {
  try { await setKv(cacheKey(mode), snapshot); } catch (_) { /* fallback abaixo */ }
  try { globalThis.localStorage && globalThis.localStorage.setItem(`${FALLBACK_STORAGE_KEY}:${normalizeMode(mode)}`, JSON.stringify(snapshot)); } catch (_) { /* cache é opcional */ }
}

export function cloudIsConfigured() {
  return configured().enabled;
}

export function cloudAssetSymbol(asset) {
  if (!asset) return null;
  if (asset.kind === 'crypto') return asset.okx || null;
  return asset.yahoo || null;
}

/**
 * Lê fotografias históricas completas do calendário em lotes limitados. A
 * função retorna apenas informação pública de eventos; tabelas privadas e a
 * chave de serviço nunca chegam ao navegador.
 */
export async function loadCausalCalendarReplay(points, {
  timeoutMs = 12_000,
  maxStaleMinutes = 360,
  batchSize = 500,
} = {}) {
  const cfg = configured();
  const clean = (Array.isArray(points) ? points : []).filter(point => point && typeof point === 'object');
  if (!clean.length) return { configured: cfg.enabled, requested: 0, covered: 0, snapshots: [], errors: [] };
  if (!cfg.enabled) {
    return { configured: false, requested: clean.length, covered: 0, snapshots: [], errors: ['backend histórico não configurado'] };
  }

  let base;
  try { base = functionsBase(cfg.url); }
  catch (error) {
    return { configured: true, requested: clean.length, covered: 0, snapshots: [], errors: [error && error.message || 'URL inválida'] };
  }

  const chunks = [];
  const size = Math.max(1, Math.min(750, Math.round(Number(batchSize) || 500)));
  for (let index = 0; index < clean.length; index += size) chunks.push(clean.slice(index, index + size));
  const snapshots = [];
  const errors = [];
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/calendar-replay`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          apikey: cfg.publishableKey,
          Authorization: `Bearer ${cfg.publishableKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ points: chunk, maxStaleMinutes }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true || !Array.isArray(payload.snapshots)) {
        throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`);
      }
      snapshots.push(...payload.snapshots);
    } catch (error) {
      errors.push(error && error.name === 'AbortError' ? 'tempo esgotado' : error && error.message || 'consulta indisponível');
    } finally {
      clearTimeout(timer);
    }
  }
  const byKey = new Map(snapshots.map(snapshot => [String(snapshot.key), snapshot]));
  const ordered = clean.map(point => byKey.get(String(point.key))).filter(Boolean);
  const covered = ordered.filter(snapshot => snapshot.status === 'ready' && Number.isFinite(Number(snapshot.fetchedAt))).length;
  return { configured: true, requested: clean.length, covered, snapshots: ordered, errors };
}

export async function loadCloudDashboard({ limit = 16, historyLimit = 200, timeoutMs = DEFAULT_TIMEOUT_MS, mode = 'neutro' } = {}) {
  const cfg = configured();
  const selectedMode = normalizeMode(mode);
  if (!cfg.enabled) {
    return {
      configured: false, status: 'local', fromCache: false, fetchedAt: null, mode: selectedMode,
      canonicalSignals: [], latestDecisions: [], opportunities: [], gradeHistory: [], metrics: [], qualityMetrics: [], qualityPaper: [], strategyLab: [], naiveBaselines: [], gradeCalibration: [], paper: null, health: null, errors: []
    };
  }

  let base;
  try { base = restBase(cfg.url); }
  catch (error) {
    return {
      configured: true, status: 'offline', fromCache: false, fetchedAt: null, mode: selectedMode,
      canonicalSignals: [], latestDecisions: [], opportunities: [], gradeHistory: [], metrics: [], qualityMetrics: [], qualityPaper: [], strategyLab: [], naiveBaselines: [], gradeCalibration: [], paper: null, health: null,
      errors: [error && error.message || 'Configuração inválida.']
    };
  }

  const calls = [
    ['canonical', 'cloud_canonical_signals', { select: '*', mode: `eq.${selectedMode}`, order: 'decision_at.desc', limit: 100 }],
    ['latest', 'cloud_latest_decisions', { select: '*', mode: `eq.${selectedMode}`, order: 'decision_at.desc', limit: Math.max(1, Math.min(100, Number(limit) * 3 || 48)) }],
    ['opportunities', 'cloud_opportunities', { select: '*', mode: `eq.${selectedMode}`, order: 'rank.asc', limit: Math.max(1, Math.min(50, Number(limit) || 16)) }],
    ['gradeHistory', 'cloud_grade_history', { select: '*', mode: `eq.${selectedMode}`, order: 'decision_at.desc', limit: Math.max(1, Math.min(500, Number(historyLimit) || 200)) }],
    ['explanations', 'cloud_decision_explanations', { select: 'id,reasons,decision_at', mode: `eq.${selectedMode}`, order: 'decision_at.desc', limit: Math.max(100, Math.min(750, Number(historyLimit) * 3 || 600)) }],
    ['metrics', 'cloud_segment_metrics', { select: '*', mode: `eq.${selectedMode}`, limit: 250 }],
    ['qualityMetrics', 'cloud_quality_segment_metrics', { select: '*', mode: `eq.${selectedMode}`, limit: 750 }],
    ['paper', 'cloud_single_paper_summary', { select: '*', limit: 1 }],
    ['qualityPaper', 'cloud_single_quality_paper_summary', { select: '*', order: 'quality.asc', limit: 3 }],
    ['strategyLab', 'cloud_strategy_lab', { select: '*', order: 'arm.asc', limit: 10 }],
    ['naiveBaselines', 'cloud_single_naive_baselines', { select: '*', order: 'strategy.asc', limit: 10 }],
    ['gradeCalibration', 'cloud_single_grade_calibration', { select: '*', limit: 5 }],
    ['health', 'cloud_system_health', { select: '*', limit: 1 }]
  ];
  const settled = await Promise.allSettled(calls.map(([, view, params]) => request(endpoint(base, view, params), cfg.publishableKey, timeoutMs)));
  const payload = {};
  const errors = [];
  settled.forEach((result, index) => {
    const name = calls[index][0];
    if (result.status === 'fulfilled') payload[name] = result.value;
    else errors.push(`${name}: ${result.reason && result.reason.name === 'AbortError' ? 'tempo esgotado' : 'indisponível'}`);
  });
  const successful = settled.filter(result => result.status === 'fulfilled').length;

  if (!successful) {
    const cached = await readCache(selectedMode);
    if (cached && typeof cached === 'object') {
      return { ...cached, configured: true, status: 'offline', fromCache: true, errors };
    }
    return {
      configured: true, status: 'offline', fromCache: false, fetchedAt: null, mode: selectedMode,
      canonicalSignals: [], latestDecisions: [], opportunities: [], gradeHistory: [], metrics: [], qualityMetrics: [], qualityPaper: [], strategyLab: [], naiveBaselines: [], gradeCalibration: [], paper: null, health: null, errors
    };
  }

  const explanationMap = new Map(rows(payload.explanations).map(normalizeExplanation).filter(row => row.id).map(row => [row.id, row.reasons]));
  const withExplanation = row => ({ ...row, criteria: explanationMap.get(row.id) || [] });
  const canonicalSignals = rows(payload.canonical).map(normalizeCanonical).map(row => ({
    ...row,
    criteria: row.criteria.length ? row.criteria : explanationMap.get(row.id) || [],
  })).sort((a, b) => (b.decisionAt || 0) - (a.decisionAt || 0));
  const latestDecisions = rows(payload.latest).map(normalizeReference).map(withExplanation);
  const opportunities = rows(payload.opportunities).map(normalizeReference).map(withExplanation).sort((a, b) => {
    const rankA = a.rank === null ? Number.POSITIVE_INFINITY : a.rank;
    const rankB = b.rank === null ? Number.POSITIVE_INFINITY : b.rank;
    return rankA - rankB || (b.ev ?? -Infinity) - (a.ev ?? -Infinity) || (b.score ?? -Infinity) - (a.score ?? -Infinity) || (b.decisionAt || 0) - (a.decisionAt || 0);
  });
  const gradeHistory = rows(payload.gradeHistory).map(normalizeCloudGradeHistory).map(withExplanation)
    .filter(row => ['A', 'A+'].includes(row.grade))
    .sort((a, b) => (b.decisionAt || 0) - (a.decisionAt || 0));
  const metrics = rows(payload.metrics).map(normalizeMetric);
  const qualityMetrics = rows(payload.qualityMetrics).map(normalizeMetric);
  const paper = normalizePaper(rows(payload.paper)[0]);
  const qualityPaper = rows(payload.qualityPaper).map(normalizePaper);
  const strategyLab = rows(payload.strategyLab);
  const naiveBaselines = rows(payload.naiveBaselines);
  const gradeCalibration = rows(payload.gradeCalibration);
  const health = normalizeHealth(rows(payload.health)[0]);
  const snapshot = {
    configured: true,
    mode: selectedMode,
    status: successful === calls.length ? 'online' : 'partial',
    fromCache: false,
    fetchedAt: Date.now(),
    canonicalSignals,
    latestDecisions,
    opportunities,
    gradeHistory,
    metrics,
    qualityMetrics,
    qualityPaper,
    strategyLab,
    naiveBaselines,
    gradeCalibration,
    paper,
    health,
    errors
  };
  await writeCache(snapshot, selectedMode);
  return snapshot;
}
