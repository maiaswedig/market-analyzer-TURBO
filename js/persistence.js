// persistence.js — armazenamento local durável do Market Analyzer.
// Esta camada é assíncrona por natureza: IndexedDB não bloqueia a interface.

export const DB_NAME = 'signal-atlas';
export const DB_VERSION = 1;

export const STORES = Object.freeze({
  KV: 'kv',
  SETTINGS: 'settings',
  MODELS: 'models',
  HISTORY: 'history',
  CALIBRATION: 'calibration',
  META: 'meta'
});

export const KEYS = Object.freeze({
  SETTINGS: 'current',
  REGISTRY: 'registry',
  SIGNAL_HISTORY: 'signal_atlas_signal_history_v1',
  FEEDBACK: 'signal_atlas_feedback_v1',
  FEEDBACK_META: 'signal_atlas_feedback_meta_v1',
  THRESHOLD_CALIBRATION_PREFIX: 'threshold-calibration:',
  LEGACY_MIGRATION: 'legacy-localstorage-v1'
});

const STORE_NAMES = Object.values(STORES);
const MODEL_PREFIX = 'ma_model_v2_';
const MISSING = Symbol('missing-persistence-value');
let openPromise = null;

export class PersistenceUnavailableError extends Error {
  constructor(message = 'IndexedDB não está disponível neste navegador ou contexto.') {
    super(message);
    this.name = 'PersistenceUnavailableError';
  }
}

function hasIndexedDb() {
  try { return !!globalThis.indexedDB; } catch (_) { return false; }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Falha ao ler/gravar no IndexedDB.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('Transação IndexedDB abortada.'));
    transaction.onerror = () => reject(transaction.error || new Error('Falha na transação IndexedDB.'));
  });
}

function assertStoreName(storeName) {
  if (!STORE_NAMES.includes(storeName)) throw new TypeError(`Store IndexedDB inválido: ${String(storeName)}`);
  return storeName;
}

function record(key, value) {
  if (key === undefined || key === null || key === '') throw new TypeError('A chave de persistência é obrigatória.');
  return { key: String(key), value, updatedAt: Date.now() };
}

/** Abre (ou cria) o banco versionado. Seguro para ser chamado várias vezes. */
export function openDatabase() {
  if (openPromise) return openPromise;
  if (!hasIndexedDb()) return Promise.reject(new PersistenceUnavailableError());

  openPromise = new Promise((resolve, reject) => {
    let request;
    try { request = globalThis.indexedDB.open(DB_NAME, DB_VERSION); }
    catch (error) { reject(error); return; }

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Outra aba pode pedir uma atualização futura. Fecha a conexão sem perder dados.
      db.onversionchange = () => { db.close(); openPromise = null; };
      resolve(db);
    };
    request.onerror = () => {
      openPromise = null;
      reject(request.error || new PersistenceUnavailableError('Não foi possível abrir o IndexedDB.'));
    };
    request.onblocked = () => {
      // Não rejeita: a aba que bloqueia pode liberar a versão logo em seguida.
    };
  });
  return openPromise;
}

/** Lê um valor; devolve fallback quando não houver registro. */
export async function get(storeName, key, fallback = null) {
  assertStoreName(storeName);
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const done = transactionDone(tx);
  const item = await requestResult(tx.objectStore(storeName).get(String(key)));
  await done;
  return item ? item.value : fallback;
}

/** Grava um valor de forma atômica. O valor precisa ser serializável pelo navegador. */
export async function set(storeName, key, value) {
  assertStoreName(storeName);
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  const done = transactionDone(tx);
  await requestResult(tx.objectStore(storeName).put(record(key, value)));
  await done;
  return value;
}

/** Remove um valor. Retorna true quando a transação terminou. */
export async function remove(storeName, key) {
  assertStoreName(storeName);
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  const done = transactionDone(tx);
  await requestResult(tx.objectStore(storeName).delete(String(key)));
  await done;
  return true;
}

/**
 * Lista registros de uma store, mais recentes primeiro por padrão.
 * Retorna [{ key, value, updatedAt }], o que torna a auditoria/exportação simples.
 */
export async function list(storeName, { prefix = '', newestFirst = true, limit = 0 } = {}) {
  assertStoreName(storeName);
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const done = transactionDone(tx);
  const rows = await requestResult(tx.objectStore(storeName).getAll());
  await done;
  const filtered = prefix ? rows.filter(row => row.key.startsWith(prefix)) : rows;
  filtered.sort((a, b) => newestFirst ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt);
  return limit > 0 ? filtered.slice(0, limit) : filtered;
}

export const del = remove;

// Atalhos para valores pequenos e isolados.
export const getKv = (key, fallback = null) => get(STORES.KV, key, fallback);
export const setKv = (key, value) => set(STORES.KV, key, value);
export const removeKv = key => remove(STORES.KV, key);

export const getSettings = () => get(STORES.SETTINGS, KEYS.SETTINGS, {});
export const saveSettings = settings => set(STORES.SETTINGS, KEYS.SETTINGS, settings);
export const getModel = modelKey => get(STORES.MODELS, MODEL_PREFIX + modelKey, null);
export const saveModel = (modelKey, model) => set(STORES.MODELS, MODEL_PREFIX + modelKey, model);
export const getModelRegistry = () => get(STORES.MODELS, KEYS.REGISTRY, {});
export const saveModelRegistry = registry => set(STORES.MODELS, KEYS.REGISTRY, registry);
export const getSignalHistory = () => get(STORES.HISTORY, KEYS.SIGNAL_HISTORY, []);
export const saveSignalHistory = rows => set(STORES.HISTORY, KEYS.SIGNAL_HISTORY, rows);
export const getFeedback = () => get(STORES.CALIBRATION, KEYS.FEEDBACK, []);
export const saveFeedback = rows => set(STORES.CALIBRATION, KEYS.FEEDBACK, rows);
export const getFeedbackMeta = () => get(STORES.CALIBRATION, KEYS.FEEDBACK_META, {});
export const saveFeedbackMeta = meta => set(STORES.CALIBRATION, KEYS.FEEDBACK_META, meta);
export const thresholdCalibrationKey = scope => KEYS.THRESHOLD_CALIBRATION_PREFIX + String(scope);
export const getThresholdCalibration = scope => get(STORES.CALIBRATION, thresholdCalibrationKey(scope), null);
export const saveThresholdCalibration = (scope, calibration) => set(STORES.CALIBRATION, thresholdCalibrationKey(scope), calibration);

function legacyStorage() {
  try {
    const storage = globalThis.localStorage;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch (_) { return null; }
}

function legacyValue(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return { exists: false, value: null };
  try { return { exists: true, value: JSON.parse(raw) }; }
  catch (_) { return { exists: true, value: raw }; }
}

async function putIfMissing(storeName, key, value, force) {
  if (!force) {
    const existing = await get(storeName, key, MISSING);
    if (existing !== MISSING) return false;
  }
  await set(storeName, key, value);
  return true;
}

/**
 * Importa uma vez os dados usados pelas versões anteriores do aplicativo.
 * Por segurança, os dados antigos NÃO são apagados por padrão. A operação é idempotente.
 */
export async function migrateFromLocalStorage({ force = false, removeLegacy = false } = {}) {
  const storage = legacyStorage();
  if (!storage) return { migrated: false, reason: 'localStorage indisponível', imported: [] };

  const prior = await get(STORES.META, KEYS.LEGACY_MIGRATION, null);
  if (prior && !force) return { migrated: false, alreadyMigrated: true, imported: prior.imported || [] };

  const imported = [];
  const transferred = [];
  const importOne = async (legacyKey, storeName, targetKey) => {
    const item = legacyValue(storage, legacyKey);
    if (!item.exists) return;
    if (await putIfMissing(storeName, targetKey, item.value, force)) imported.push({ from: legacyKey, to: `${storeName}/${targetKey}` });
    transferred.push(legacyKey);
  };

  await importOne('signal_atlas_settings_v1', STORES.SETTINGS, KEYS.SETTINGS);
  await importOne('signal_atlas_models_v1', STORES.MODELS, KEYS.REGISTRY);
  await importOne('signal_atlas_signal_history_v1', STORES.HISTORY, KEYS.SIGNAL_HISTORY);
  await importOne('signal_atlas_feedback_v1', STORES.CALIBRATION, KEYS.FEEDBACK);
  await importOne('signal_atlas_feedback_meta_v1', STORES.CALIBRATION, KEYS.FEEDBACK_META);

  // Os modelos são armazenados com uma chave por ativo/timeframe na versão anterior.
  let legacyKeys = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key) legacyKeys.push(key);
    }
  } catch (_) { legacyKeys = []; }
  for (const key of legacyKeys) {
    if (key.startsWith(MODEL_PREFIX)) await importOne(key, STORES.MODELS, key);
  }

  const marker = { migratedAt: Date.now(), imported, source: 'localStorage', version: 1 };
  await set(STORES.META, KEYS.LEGACY_MIGRATION, marker);

  if (removeLegacy) {
    for (const key of new Set(transferred)) {
      try { storage.removeItem(key); } catch (_) { /* armazenamento legado pode estar bloqueado */ }
    }
  }
  return { migrated: true, imported, removedLegacy: !!removeLegacy };
}

/** Abre o banco e tenta a migração sem apagar nenhum dado antigo. */
export async function initializePersistence(options = {}) {
  await openDatabase();
  return migrateFromLocalStorage(options);
}

// API compacta para uso por módulos da interface: persistence.delete(...), por exemplo.
export const persistence = Object.freeze({
  open: openDatabase,
  get,
  set,
  delete: remove,
  list,
  migrateFromLocalStorage,
  initialize: initializePersistence,
  stores: STORES,
  keys: KEYS
});
