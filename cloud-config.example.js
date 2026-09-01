// Configuração opcional do Monitoramento 24/7.
// Use apenas a chave pública/publicável do projeto. Nunca coloque service_role aqui.
// Se os campos ficarem vazios, o Market Analyzer continuará 100% no modo local.
globalThis.SIGNAL_ATLAS_CLOUD_CONFIG = globalThis.SIGNAL_ATLAS_CLOUD_CONFIG || {
  url: '',
  publishableKey: ''
};
