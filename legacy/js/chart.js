// chart.js — gráfico próprio com TradingView Lightweight Charts (biblioteca gratuita via CDN).
// Desenha: candles reais, EMAs 9/21/50/200, histograma de volume, bandas das zonas de S/R
// e o marcador "← PRÓXIMA VELA" (o candle que a análise tenta prever).
import { ema } from './indicators.js';

const CDNS = [
  'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js',
  'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js'
];
let libPromise = null;

export function loadCharts() {
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= CDNS.length) { reject(new Error('não foi possível carregar a biblioteca de gráficos (CDN bloqueado)')); return; }
      const s = document.createElement('script');
      s.src = CDNS[idx++];
      s.async = true;
      s.onload = () => window.LightweightCharts ? resolve(window.LightweightCharts) : tryNext();
      s.onerror = () => tryNext();
      document.head.appendChild(s);
    };
    tryNext();
  });
  return libPromise;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export class PriceChart {
  constructor(container) {
    this.container = container;
    this.chart = null;
    this.overlay = null;
    this.state = null;
  }

  async ensure() {
    if (this.chart) return;
    const LWC = await loadCharts();
    this.container.innerHTML = '';
    this.container.style.position = 'relative';
    const dark = document.documentElement.dataset.theme !== 'light';
    this.chart = LWC.createChart(this.container, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: cssVar('--surface-1', dark ? '#11151c' : '#fff') },
        textColor: cssVar('--text-dim', dark ? '#98a2b3' : '#4b5563'),
        fontFamily: "'JetBrains Mono', ui-monospace, monospace"
      },
      grid: { vertLines: { color: cssVar('--line', '#232a36') }, horzLines: { color: cssVar('--line', '#232a36') } },
      rightPriceScale: { borderColor: cssVar('--line', '#232a36'), scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: cssVar('--line', '#232a36'), timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      localization: {
        locale: 'pt-BR',
        timeFormatter: t => new Date(t * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      }
    });
    this.candles = this.chart.addCandlestickSeries({
      upColor: cssVar('--call', '#2fbf71'), downColor: cssVar('--put', '#f04b52'),
      borderUpColor: cssVar('--call', '#2fbf71'), borderDownColor: cssVar('--put', '#f04b52'),
      wickUpColor: cssVar('--call', '#2fbf71'), wickDownColor: cssVar('--put', '#f04b52')
    });
    this.vol = this.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    const line = (color, width, title) => this.chart.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title });
    this.e9 = line('#4c8dff', 1, 'EMA9');
    this.e21 = line('#d9a13b', 1, 'EMA21');
    this.e50 = line('#a78bfa', 1, 'EMA50');
    this.e200 = line('#94a3b8', 2, 'EMA200');

    this.overlay = document.createElement('canvas');
    this.overlay.className = 'chart-overlay';
    this.container.appendChild(this.overlay);
    const redraw = () => this.drawOverlay();
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    this.chart.subscribeCrosshairMove(() => { });
    this._timer = setInterval(redraw, 700);
    window.addEventListener('resize', redraw);
  }

  /**
   * @param data { candles, zones, tfSec, verdict, nextOpen, hasVolume }
   */
  async render(data) {
    await this.ensure();
    this.state = data;
    const view = data.candles.slice(-Math.min(data.candles.length, 320));
    const closes = view.map(k => k.c);
    const toSec = k => Math.floor(k.t / 1000);
    const last = view[view.length - 1];
    this.nextOpenSec = Math.floor((data.nextOpen || (last.t + data.tfSec * 1000)) / 1000);
    const candleData = view.map(k => ({ time: toSec(k), open: k.o, high: k.h, low: k.l, close: k.c }));
    candleData.push({ time: this.nextOpenSec });   // whitespace: reserva o slot da próxima vela
    this.candles.setData(candleData);
    if (data.hasVolume) {
      this.vol.setData(view.map(k => ({ time: toSec(k), value: k.v || 0, color: k.c >= k.o ? 'rgba(47,191,113,.35)' : 'rgba(240,75,82,.35)' })));
    } else this.vol.setData([]);
    const put = (series, arr, projectNext = true) => {
      const points = view.map((k, i) => arr[i] === null || arr[i] === undefined ? null : { time: toSec(k), value: arr[i] }).filter(Boolean);
      // O gráfico continua sendo REAL: candles e indicadores históricos são os
      // dados do feed. Apenas acrescentamos um ponto projetado no slot da
      // próxima vela para que a leitura visual corresponda ao sinal futuro.
      if (projectNext && points.length >= 2) {
        const a = points[points.length - 2].value, b = points[points.length - 1].value;
        points.push({ time: this.nextOpenSec, value: b + (b - a) });
      }
      series.setData(points);
    };
    put(this.e9, ema(closes, 9));
    put(this.e21, ema(closes, 21));
    put(this.e50, ema(closes, 50));
    if (view.length > 200) put(this.e200, ema(closes, 200)); else this.e200.setData([]);

    this.drawOverlay();
  }

  drawOverlay() {
    if (!this.overlay || !this.state || !this.chart) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    this.overlay.width = w * dpr; this.overlay.height = h * dpr;
    this.overlay.style.width = w + 'px'; this.overlay.style.height = h + 'px';
    const ctx = this.overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { zones, verdict } = this.state;
    const dbg = { w, h, zones: zones ? (zones.supports || []).length + (zones.resistances || []).length : 0, drawn: 0, x: null, err: null };
    window.__chartDbg = dbg;
    try {

    // ---- bandas das zonas de suporte (verde) e resistência (vermelho)
    if (zones) {
      const draw = (z, color, label) => {
        const y1 = this.candles.priceToCoordinate(z.high);
        const y2 = this.candles.priceToCoordinate(z.low);
        if (y1 === null || y2 === null) return;
        const top = Math.min(y1, y2), height = Math.max(2, Math.abs(y2 - y1));
        dbg.drawn++;
        ctx.fillStyle = color;
        ctx.fillRect(0, top, w, height);
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.fillStyle = label.color;
        ctx.fillText(`${label.text} ${z.strength}/5`, 6, top + Math.min(height, 11) + (height > 12 ? 0 : -3));
      };
      for (const z of (zones.supports || []).slice(0, 2)) draw(z, 'rgba(47,191,113,.15)', { color: 'rgba(47,191,113,.9)', text: 'suporte' });
      for (const z of (zones.resistances || []).slice(0, 2)) draw(z, 'rgba(240,75,82,.15)', { color: 'rgba(240,75,82,.9)', text: 'resistência' });
    }

    // ---- slot da PRÓXIMA VELA
    const plotW = this.chart.timeScale().width() || w;
    let x = this.chart.timeScale().timeToCoordinate(this.nextOpenSec);
    if (x !== null) {
      const bw = Math.max(8, Math.min(22, this.chart.timeScale().options().barSpacing || 10));
      x = Math.min(x, plotW - bw / 2 - 2);
      const bottom = h * 0.74;
      const color = verdict === 'CALL' ? 'rgba(47,191,113,.22)' : verdict === 'PUT' ? 'rgba(240,75,82,.22)' : 'rgba(148,163,184,.18)';
      ctx.fillStyle = color;
      ctx.fillRect(x - bw / 2, 10, bw, bottom - 10);
      ctx.strokeStyle = verdict === 'CALL' ? 'rgba(47,191,113,.8)' : verdict === 'PUT' ? 'rgba(240,75,82,.8)' : 'rgba(148,163,184,.7)';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x - bw / 2, 10, bw, bottom - 10);
      ctx.setLineDash([]);
      // seta de direção
      const cy = bottom * 0.55;
      if (verdict === 'CALL' || verdict === 'PUT') {
        const up = verdict === 'CALL';
        ctx.beginPath();
        ctx.moveTo(x, up ? cy - 22 : cy + 22);
        ctx.lineTo(x - 7, up ? cy - 8 : cy + 8);
        ctx.lineTo(x + 7, up ? cy - 8 : cy + 8);
        ctx.closePath();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
      ctx.font = '600 11px Inter Tight, system-ui, sans-serif';
      ctx.fillStyle = ctx.strokeStyle;
      const txt = '← PRÓXIMA VELA';
      const tw = ctx.measureText(txt).width;
      ctx.fillText(txt, Math.max(4, Math.min(plotW - tw - 4, x - bw / 2 - tw - 6)), 22);
    }
    dbg.x = x;
    } catch (e) { dbg.err = String(e && e.message || e); }
  }

  destroy() {
    if (this._timer) clearInterval(this._timer);
    if (this.chart) { this.chart.remove(); this.chart = null; }
    this.container.innerHTML = '';
  }
}
