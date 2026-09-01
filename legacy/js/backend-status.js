// Estado do serviço opcional. A interface continua funcionando sozinha quando aberta
// como arquivo; quando é servida pelo backend, este painel confirma a coleta 24/7.
const API = (globalThis.MARKET_ANALYZER_API_URL || '/api/v1').replace(/\/$/, '');
const STATIC_HOSTS = /(?:^|\.)(netlify\.app|vercel\.app|github\.io)$/i;

function time(ms) {
  return ms ? new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

function show(el, state, message, detail = '') {
  el.dataset.state = state;
  el.textContent = message;
  const extra = document.getElementById('backendStatusDetail');
  if (extra) extra.textContent = detail;
}

export function startBackendStatus() {
  const el = document.getElementById('backendStatus');
  if (!el) return;
  let stopped = false;

  const refresh = async () => {
    if (stopped) return;
    if (location.protocol === 'file:' && !globalThis.MARKET_ANALYZER_API_URL) {
      show(el, 'offline', 'Servidor 24/7 não conectado', 'Abra pelo endereço http://127.0.0.1:8787 após iniciar o backend.');
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${API}/health`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = await response.json();
      const w = health.worker || {};
      const db = health.database || {};
      const cfg = health.config || {};
      const state = w.running ? 'working' : 'online';
      const label = w.running ? 'Servidor 24/7 analisando agora' : 'Servidor 24/7 conectado';
      const detail = `watchlist: ${(cfg.watchlist || []).length} pares · candles: ${db.candles || 0} · análises resolvidas: ${db.resolvedAnalyses || 0} · modelos ativos: ${db.activeModels || 0} · último ciclo: ${time(w.lastFinishedAt)}`;
      show(el, state, label, detail);
    } catch {
      if (STATIC_HOSTS.test(location.hostname)) {
        show(el, 'online', 'Modo navegador online', 'Este link analisa candles reais e aprende enquanto estiver aberto. O histórico e o modelo ficam salvos somente neste navegador.');
      } else {
        show(el, 'offline', 'Servidor 24/7 não conectado', 'O frontend segue disponível; inicie o backend para coleta, validação e treino contínuos.');
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  refresh();
  const timer = setInterval(refresh, 30000);
  window.addEventListener('beforeunload', () => { stopped = true; clearInterval(timer); }, { once: true });
}
