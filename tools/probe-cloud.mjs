import '../cloud-config.js';
const { url, publishableKey } = globalThis.SIGNAL_ATLAS_CLOUD_CONFIG;
for (const view of ['cloud_system_health', 'cloud_canonical_signals', 'cloud_opportunities', 'cloud_single_paper_summary']) {
  const start = performance.now();
  try {
    const response = await fetch(`${url}/rest/v1/${view}?select=*&limit=100`, {
      headers: { apikey: publishableKey }, signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    console.log(JSON.stringify({ view, status: response.status, ms: Math.round(performance.now()-start), rows: Array.isArray(data) ? data.length : null, error: Array.isArray(data) ? null : data }));
  } catch (error) { console.log(JSON.stringify({view, ms: Math.round(performance.now()-start), error: error.message})); }
}
