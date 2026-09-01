// tv.js — widgets gratuitos do TradingView (gráfico avançado + medidor de análise técnica).
// O TradingView não oferece API pública gratuita de candles: o gráfico é apenas visual;
// todos os cálculos do app vêm dos feeds públicos (OKX/Coinbase/Kraken/Yahoo).
import { TIMEFRAMES } from './assets.js';

function widget(container, config, script) {
  container.innerHTML = '';
  const outer = document.createElement('div');
  outer.className = 'tradingview-widget-container';
  outer.style.height = '100%';
  const inner = document.createElement('div');
  inner.className = 'tradingview-widget-container__widget';
  inner.style.height = '100%';
  outer.appendChild(inner);
  const s = document.createElement('script');
  s.type = 'text/javascript';
  s.async = true;
  s.src = script;
  s.innerHTML = JSON.stringify(config);
  outer.appendChild(s);
  container.appendChild(outer);
}

export function renderAdvancedChart(container, asset, tfKey, theme = 'dark') {
  widget(container, {
    autosize: true,
    symbol: asset.tv || 'OKX:BTCUSDT',
    interval: TIMEFRAMES[tfKey].tv,
    timezone: 'America/Sao_Paulo',
    theme,
    style: '1',
    locale: 'br',
    hide_side_toolbar: true,
    allow_symbol_change: false,
    withdateranges: false,
    save_image: false,
    studies: ['STD;EMA', 'STD;RSI'],
    support_host: 'https://www.tradingview.com'
  }, 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js');
}

export function renderTechnicalGauge(container, asset, tfKey, theme = 'dark') {
  const map = { M1: '1m', M2: '1m', M3: '5m', M5: '5m', M15: '15m', M30: '30m', H1: '1h', H4: '4h' };
  widget(container, {
    interval: map[tfKey] || '5m',
    width: '100%',
    isTransparent: true,
    height: 400,
    symbol: asset.tv || 'OKX:BTCUSDT',
    showIntervalTabs: false,
    displayMode: 'single',
    locale: 'br',
    colorTheme: theme
  }, 'https://s3.tradingview.com/external-embedding/embed-widget-technical-analysis.js');
}
