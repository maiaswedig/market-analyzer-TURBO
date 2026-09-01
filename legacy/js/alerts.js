// alerts.js — som (WebAudio, sem arquivos), notificação do navegador e alerta visual.
import { toast, signalLabel } from './util.js';

let ctx = null;
export const notifState = { permission: 'default', supported: typeof Notification !== 'undefined', error: null };

export function beep(kind = 'call') {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const freqs = kind === 'call' ? [660, 880] : kind === 'put' ? [440, 330] : [520];
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, now + idx * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.16, now + idx * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.16 + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + idx * 0.16); osc.stop(now + idx * 0.16 + 0.18);
    });
    return true;
  } catch (e) { return false; }
}

export async function requestNotifications() {
  try {
    if (typeof Notification === 'undefined') { notifState.supported = false; notifState.error = 'Notification API não disponível neste contexto'; return false; }
    const p = await Notification.requestPermission();
    notifState.permission = p;
    return p === 'granted';
  } catch (e) {
    notifState.error = e.message;
    return false;
  }
}

export function notify(title, body) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    new Notification(title, { body });
    return true;
  } catch (e) { notifState.error = e.message; return false; }
}

/**
 * Dispara alerta. Por padrão SOMENTE para setups nota A ou A+ (spec v2).
 * Formato da mensagem: 🔔 BTC/USDT M5 — CALL — Score 89
 */
export function fireAlert(result, settings) {
  if (result.verdict !== 'CALL' && result.verdict !== 'PUT') return false;
  const grade = result.grade ? result.grade.grade : null;
  if (settings.alertOnlyAGrades !== false && grade !== 'A' && grade !== 'A+') return false;
  const kind = result.verdict === 'CALL' ? 'call' : 'put';
  const msg = `🔔 ${result.asset.name} ${result.tfKey} — ${signalLabel(result.verdict)} — Score ${Math.round(result.score.score)}`;
  if (settings.alertSound) beep(kind);
  if (settings.alertVisual) toast(`${msg} · qualidade ${grade}`, kind === 'call' ? 'ok' : 'err', 7000);
  if (settings.alertNotification) notify(msg, `Qualidade ${grade} · confluência ${result.score.confluence.text} · ${result.cond ? result.cond.label : ''}`);
  return true;
}
