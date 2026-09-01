// assets.js — universo de ativos (cripto + forex), timeframes e escada multi-timeframe.
// Foco da v2: CRIPTO (OKX/Coinbase/Kraken) e FOREX (pares fiat reais da Kraken, Yahoo como reserva).
export const TIMEFRAMES = {
  M1: { key: 'M1', label: 'M1', sec: 60, tv: '1' },
  M5: { key: 'M5', label: 'M5', sec: 300, tv: '5' },
  M15: { key: 'M15', label: 'M15', sec: 900, tv: '15' },
  M30: { key: 'M30', label: 'M30', sec: 1800, tv: '30' },
  H1: { key: 'H1', label: 'H1', sec: 3600, tv: '60' },
  H4: { key: 'H4', label: 'H4', sec: 14400, tv: '240' }
};
export const TF_LIST = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'];

// Escada multi-timeframe: TF principal + contextos. O veredito é SEMPRE sobre a próxima
// vela do TF principal; os outros entram apenas como contexto (confluência).
export const MTF_MAP = {
  M1: ['M1', 'M5', 'M15', 'M30'],
  M5: ['M1', 'M5', 'M15', 'H1'],
  M15: ['M5', 'M15', 'H1', 'H4'],
  M30: ['M15', 'M30', 'H1', 'H4'],
  H1: ['M15', 'M30', 'H1', 'H4'],
  H4: ['M30', 'H1', 'H4']
};

const crypto = (id, name, okxBase, { coinbase = null, kraken = null } = {}) => ({
  id, name, group: 'Cripto', kind: 'crypto',
  okx: `${okxBase}-USDT`, coinbase, kraken, tv: `OKX:${okxBase}USDT`
});

export const ASSETS = [
  // ---------------- Cripto (OKX principal; Coinbase/Kraken de reserva) ----------------
  crypto('BTCUSDT', 'BTC/USDT', 'BTC', { coinbase: 'BTC-USD', kraken: 'XBTUSD' }),
  crypto('ETHUSDT', 'ETH/USDT', 'ETH', { coinbase: 'ETH-USD', kraken: 'ETHUSD' }),
  crypto('SOLUSDT', 'SOL/USDT', 'SOL', { coinbase: 'SOL-USD', kraken: 'SOLUSD' }),
  crypto('XRPUSDT', 'XRP/USDT', 'XRP', { coinbase: 'XRP-USD', kraken: 'XRPUSD' }),
  crypto('BNBUSDT', 'BNB/USDT', 'BNB'),
  crypto('DOGEUSDT', 'DOGE/USDT', 'DOGE', { coinbase: 'DOGE-USD', kraken: 'XDGUSD' }),
  crypto('ADAUSDT', 'ADA/USDT', 'ADA', { coinbase: 'ADA-USD', kraken: 'ADAUSD' }),
  crypto('AVAXUSDT', 'AVAX/USDT', 'AVAX', { coinbase: 'AVAX-USD', kraken: 'AVAXUSD' }),
  crypto('LINKUSDT', 'LINK/USDT', 'LINK', { coinbase: 'LINK-USD', kraken: 'LINKUSD' }),
  crypto('LTCUSDT', 'LTC/USDT', 'LTC', { coinbase: 'LTC-USD', kraken: 'LTCUSD' }),
  crypto('TONUSDT', 'TON/USDT', 'TON'),
  crypto('DOTUSDT', 'DOT/USDT', 'DOT', { coinbase: 'DOT-USD', kraken: 'DOTUSD' }),
  crypto('TRXUSDT', 'TRX/USDT', 'TRX', { kraken: 'TRXUSD' }),
  crypto('MATICUSDT', 'MATIC/USDT', 'MATIC', { coinbase: 'MATIC-USD' }),
  crypto('SHIBUSDT', 'SHIB/USDT', 'SHIB', { coinbase: 'SHIB-USD' }),
  crypto('NEARUSDT', 'NEAR/USDT', 'NEAR', { coinbase: 'NEAR-USD' }),
  crypto('APTUSDT', 'APT/USDT', 'APT', { coinbase: 'APT-USD' }),
  crypto('ATOMUSDT', 'ATOM/USDT', 'ATOM', { coinbase: 'ATOM-USD' }),
  crypto('UNIUSDT', 'UNI/USDT', 'UNI', { coinbase: 'UNI-USD' }),
  crypto('FILUSDT', 'FIL/USDT', 'FIL', { coinbase: 'FIL-USD' }),
  crypto('ETCUSDT', 'ETC/USDT', 'ETC', { coinbase: 'ETC-USD' }),
  crypto('XLMUSDT', 'XLM/USDT', 'XLM', { coinbase: 'XLM-USD' }),
  crypto('BCHUSDT', 'BCH/USDT', 'BCH', { coinbase: 'BCH-USD' }),
  crypto('ARBUSDT', 'ARB/USDT', 'ARB', { coinbase: 'ARB-USD' }),
  crypto('OPUSDT', 'OP/USDT', 'OP', { coinbase: 'OP-USD' }),
  crypto('INJUSDT', 'INJ/USDT', 'INJ', { coinbase: 'INJ-USD' }),
  crypto('SUIUSDT', 'SUI/USDT', 'SUI', { coinbase: 'SUI-USD' }),
  crypto('SEIUSDT', 'SEI/USDT', 'SEI', { coinbase: 'SEI-USD' }),
  crypto('AAVEUSDT', 'AAVE/USDT', 'AAVE', { coinbase: 'AAVE-USD' }),
  crypto('LDOUSDT', 'LDO/USDT', 'LDO', { coinbase: 'LDO-USD' }),
  crypto('ALGOUSDT', 'ALGO/USDT', 'ALGO', { coinbase: 'ALGO-USD' }),
  crypto('ICPUSDT', 'ICP/USDT', 'ICP', { coinbase: 'ICP-USD' }),
  crypto('FTMUSDT', 'FTM/USDT', 'FTM'),
  crypto('SANDUSDT', 'SAND/USDT', 'SAND', { coinbase: 'SAND-USD' }),
  crypto('MANAUSDT', 'MANA/USDT', 'MANA', { coinbase: 'MANA-USD' }),
  crypto('AXSUSDT', 'AXS/USDT', 'AXS', { coinbase: 'AXS-USD' }),
  crypto('CRVUSDT', 'CRV/USDT', 'CRV', { coinbase: 'CRV-USD' }),
  crypto('GRTUSDT', 'GRT/USDT', 'GRT', { coinbase: 'GRT-USD' }),
  crypto('EGLDUSDT', 'EGLD/USDT', 'EGLD'),
  crypto('THETAUSDT', 'THETA/USDT', 'THETA'),
  crypto('PEPEUSDT', 'PEPE/USDT', 'PEPE'),
  crypto('WIFUSDT', 'WIF/USDT', 'WIF'),
  crypto('ORDIUSDT', 'ORDI/USDT', 'ORDI'),
  crypto('RUNEUSDT', 'RUNE/USDT', 'RUNE'),
  crypto('FLOWUSDT', 'FLOW/USDT', 'FLOW'),
  crypto('CHZUSDT', 'CHZ/USDT', 'CHZ'),
  crypto('ENJUSDT', 'ENJ/USDT', 'ENJ'),
  crypto('ZILUSDT', 'ZIL/USDT', 'ZIL'),
  crypto('KSMUSDT', 'KSM/USDT', 'KSM'),
  crypto('COMPUSDT', 'COMP/USDT', 'COMP'),

  // ---------------- Forex (Kraken tem OHLC fiat REAL com CORS; Yahoo é reserva) ----------------
  { id: 'EURUSD', name: 'EUR/USD', group: 'Forex', kind: 'fx', kraken: 'ZEURZUSD', yahoo: 'EURUSD=X', tv: 'FX:EURUSD' },
  { id: 'GBPUSD', name: 'GBP/USD', group: 'Forex', kind: 'fx', kraken: 'ZGBPZUSD', yahoo: 'GBPUSD=X', tv: 'FX:GBPUSD' },
  { id: 'USDJPY', name: 'USD/JPY', group: 'Forex', kind: 'fx', kraken: 'ZUSDZJPY', yahoo: 'USDJPY=X', tv: 'FX:USDJPY' },
  { id: 'AUDUSD', name: 'AUD/USD', group: 'Forex', kind: 'fx', kraken: 'AUDUSD', yahoo: 'AUDUSD=X', tv: 'FX:AUDUSD' },
  { id: 'USDCAD', name: 'USD/CAD', group: 'Forex', kind: 'fx', kraken: 'ZUSDZCAD', yahoo: 'USDCAD=X', tv: 'FX:USDCAD' },
  { id: 'USDCHF', name: 'USD/CHF', group: 'Forex', kind: 'fx', kraken: 'USDCHF', yahoo: 'USDCHF=X', tv: 'FX:USDCHF' },
  { id: 'EURJPY', name: 'EUR/JPY', group: 'Forex', kind: 'fx', kraken: 'EURJPY', yahoo: 'EURJPY=X', tv: 'FX:EURJPY' },
  { id: 'EURGBP', name: 'EUR/GBP', group: 'Forex', kind: 'fx', kraken: 'EURGBP', yahoo: 'EURGBP=X', tv: 'FX:EURGBP' },
  { id: 'AUDJPY', name: 'AUD/JPY', group: 'Forex', kind: 'fx', kraken: 'AUDJPY', yahoo: 'AUDJPY=X', tv: 'FX:AUDJPY' },
  { id: 'EURAUD', name: 'EUR/AUD', group: 'Forex', kind: 'fx', kraken: 'EURAUD', yahoo: 'EURAUD=X', tv: 'FX:EURAUD' },
  { id: 'EURCHF', name: 'EUR/CHF', group: 'Forex', kind: 'fx', kraken: 'EURCHF', yahoo: 'EURCHF=X', tv: 'FX:EURCHF' },
  { id: 'EURCAD', name: 'EUR/CAD', group: 'Forex', kind: 'fx', kraken: 'EURCAD', yahoo: 'EURCAD=X', tv: 'FX:EURCAD' },
  { id: 'NZDUSD', name: 'NZD/USD (só Yahoo)', group: 'Forex', kind: 'yahoo', yahoo: 'NZDUSD=X', tv: 'FX:NZDUSD' },
  { id: 'USDBRL', name: 'USD/BRL (só Yahoo)', group: 'Forex', kind: 'yahoo', yahoo: 'USDBRL=X', tv: 'FX_IDC:USDBRL' },
  { id: 'GBPJPY', name: 'GBP/JPY (só Yahoo)', group: 'Forex', kind: 'yahoo', yahoo: 'GBPJPY=X', tv: 'FX:GBPJPY' },
  { id: 'CHFJPY', name: 'CHF/JPY (só Yahoo)', group: 'Forex', kind: 'yahoo', yahoo: 'CHFJPY=X', tv: 'FX:CHFJPY' }
];

export const GROUPS = ['Cripto', 'Forex'];

/** Tamanho REAL do universo disponível nos feeds gratuitos (usado pelo scanner, sem inflar números). */
export function universeSize(market) {
  const list = market === 'Cripto' ? ASSETS.filter(a => a.group === 'Cripto')
    : market === 'Forex' ? ASSETS.filter(a => a.group === 'Forex')
      : ASSETS;
  return list.length;
}
export function universe(market) {
  if (market === 'Cripto') return ASSETS.filter(a => a.group === 'Cripto');
  if (market === 'Forex') return ASSETS.filter(a => a.group === 'Forex');
  // 'Ambos': intercala cripto e forex (nessa ordem de liquidez dentro de cada grupo)
  // para que um "TOP N" combinado não vire só criptomoedas.
  const crip = ASSETS.filter(a => a.group === 'Cripto');
  const fx = ASSETS.filter(a => a.group === 'Forex');
  const out = [];
  const max = Math.max(crip.length, fx.length);
  for (let i = 0; i < max; i++) {
    if (crip[i]) out.push(crip[i]);
    if (fx[i]) out.push(fx[i]);
  }
  return out;
}

const customs = [];
export function getAsset(id) {
  return ASSETS.find(a => a.id === id) || customs.find(a => a.id === id) || null;
}
export function allAssets() { return ASSETS.concat(customs); }

// Ativo personalizado: cripto (OKX) quando parece par USDT, senão Yahoo.
export function addCustomAsset(raw) {
  const sym = String(raw || '').trim().toUpperCase();
  if (!sym) return null;
  const existing = getAsset(sym);
  if (existing) return existing;
  let a;
  if (/USDT$/.test(sym.replace('-', '')) || /^[A-Z0-9]{2,10}-USDT$/.test(sym)) {
    const instId = sym.includes('-') ? sym : sym.replace(/USDT$/, '-USDT');
    a = { id: sym, name: sym + ' (personalizado)', group: 'Cripto', kind: 'crypto', okx: instId, coinbase: null, kraken: null, tv: 'OKX:' + instId.replace('-', ''), custom: true };
  } else {
    a = { id: sym, name: sym + ' (personalizado)', group: 'Forex', kind: 'yahoo', yahoo: sym, tv: sym.replace('=X', ''), custom: true };
  }
  customs.push(a);
  return a;
}
