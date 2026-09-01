// broker.js — comparação ASSISTIDA com a corretora.
// A imagem NÃO é lida automaticamente (nenhum OCR): o usuário informa ativo, timeframe,
// horário da última vela e preço aproximado, e o app compara com o feed real.
// Divergência acima da tolerância → ⚠️ NÃO OPERAR (bloqueia/rebaixa o sinal na sessão).
import { TIMEFRAMES } from './assets.js';

export const brokerState = {
  imageUrl: null, fileName: null,
  check: null,            // último resultado de comparação
  divergent: false,
  reason: '',
  at: null
};

export function setImage(file) {
  clearImage();
  if (!file) return null;
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) throw new Error('formato não suportado (use PNG, JPG ou WEBP)');
  brokerState.imageUrl = URL.createObjectURL(file);   // apenas local: nada é enviado a servidor
  brokerState.fileName = file.name;
  return brokerState.imageUrl;
}
export function clearImage() {
  if (brokerState.imageUrl) { try { URL.revokeObjectURL(brokerState.imageUrl); } catch (e) { } }
  brokerState.imageUrl = null; brokerState.fileName = null;
}

/**
 * @param form { assetId, tf, timeHHMM, price }
 * @param feed { candles, source, assetId, tf }
 * @param cfg  { brokerTolPct }
 */
export function compare(form, feed, cfg = {}) {
  const tolPct = Number(cfg.brokerTolPct) || 0.15;
  const problems = [];
  const rows = [];
  if (!feed || !feed.candles || !feed.candles.length) {
    brokerState.divergent = false;
    brokerState.reason = 'sem feed carregado para comparar';
    brokerState.check = { ok: false, rows: [], problems: [brokerState.reason], at: Date.now() };
    return brokerState.check;
  }
  const last = feed.candles[feed.candles.length - 1];
  const tfSec = TIMEFRAMES[form.tf] ? TIMEFRAMES[form.tf].sec : null;

  // 1) ativo
  const sameAsset = String(form.assetId || '').toUpperCase() === String(feed.assetId || '').toUpperCase();
  rows.push({ item: 'Ativo', corretora: form.assetId || '—', feed: feed.assetId, ok: sameAsset });
  if (!sameAsset) problems.push('ativo informado é diferente do ativo analisado');

  // 2) timeframe
  const sameTf = String(form.tf) === String(feed.tf);
  rows.push({ item: 'Timeframe', corretora: form.tf || '—', feed: feed.tf, ok: sameTf });
  if (!sameTf) problems.push('timeframe informado é diferente do timeframe analisado');

  // 3) horário da última vela
  let timeOk = true, skew = null;
  if (form.timeHHMM && tfSec) {
    const [hh, mm] = String(form.timeHHMM).split(':').map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) {
      const ref = new Date(last.t);
      const informed = new Date(ref);
      informed.setHours(hh, mm, 0, 0);
      // corrige virada de dia
      let diff = informed.getTime() - ref.getTime();
      if (Math.abs(diff) > 12 * 3600 * 1000) diff = diff - Math.sign(diff) * 24 * 3600 * 1000;
      skew = diff / 1000 / tfSec;                 // em velas
      timeOk = Math.abs(skew) <= 1;
      rows.push({
        item: 'Horário da última vela', corretora: form.timeHHMM,
        feed: new Date(last.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        ok: timeOk, detail: `defasagem de ${skew.toFixed(2)} vela(s)`
      });
      if (!timeOk) problems.push(`horário da corretora está ${Math.abs(skew).toFixed(1)} velas fora do feed`);
    }
  }

  // 4) preço
  let priceOk = true, diffPct = null;
  const price = Number(String(form.price || '').replace(',', '.'));
  if (Number.isFinite(price) && price > 0) {
    diffPct = Math.abs(price - last.c) / last.c * 100;
    priceOk = diffPct <= tolPct;
    rows.push({ item: 'Preço aproximado', corretora: price, feed: last.c, ok: priceOk, detail: `diferença de ${diffPct.toFixed(3)}% (tolerância ${tolPct}%)` });
    if (!priceOk) problems.push(`preço da corretora difere ${diffPct.toFixed(3)}% do feed (tolerância ${tolPct}%)`);
  }

  const divergent = problems.length > 0;
  brokerState.divergent = divergent;
  brokerState.reason = problems.join(' · ');
  brokerState.at = Date.now();
  brokerState.check = { ok: !divergent, rows, problems, at: brokerState.at, tolPct, diffPct, skew, source: feed.source };
  return brokerState.check;
}

export function reset() {
  brokerState.divergent = false;
  brokerState.reason = '';
  brokerState.check = null;
}
