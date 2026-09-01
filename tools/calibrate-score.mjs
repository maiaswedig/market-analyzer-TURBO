import { ASSETS } from '../js/assets.js';
import { DEFAULT_SETTINGS } from '../js/analyze.js';
import { buildReplayContext, runBacktest } from '../js/backtest.js';
import { calibrateCategoryWeights, calibrateScoreScale } from '../js/score-calibration.js';

const args = process.argv.slice(2);
const positional = args.filter(value => !value.startsWith('--'));
const option = (name, fallback = null) => {
  const prefix = `--${name}=`;
  const found = args.find(value => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};
const mode = String(option('mode', 'scale')).toLowerCase();
if (!['scale', 'weights'].includes(mode)) throw new Error(`Modo inválido: ${mode}. Use --mode=scale ou --mode=weights.`);
const assetId = String(positional[0] || 'BTCUSDT').toUpperCase();
const timeframe = String(positional[1] || 'M5').toUpperCase();
const candles = Math.max(1500, Math.min(10000, Number(positional[2]) || 5000));
const asset = ASSETS.find(item => item.id === assetId);
if (!asset) throw new Error(`Ativo desconhecido: ${assetId}`);
if (!['M1', 'M5', 'M15', 'M30', 'H1', 'H4'].includes(timeframe)) throw new Error(`Timeframe inválido: ${timeframe}`);

const settings = {
  ...DEFAULT_SETTINGS,
  deepCandles: candles,
  // Evita que um ranking de setups selecionado com a escala antiga participe
  // da calibração dos próprios B0/B1.
  minSetupSamples: Number.MAX_SAFE_INTEGER,
};
let lastProgressBucket = -1;
const onProgress = (progress, message) => {
    const bucket = Math.floor(Math.max(0, Math.min(1, Number(progress) || 0)) * 10);
    if (!message.startsWith('Avaliando vela') || bucket > lastProgressBucket) {
      lastProgressBucket = Math.max(lastProgressBucket, bucket);
      process.stderr.write(`${message}\n`);
    }
};
const economics = {
  payout: (Number(settings.payout) || 85) / 100,
  stake: Number(settings.stake) || 5,
  operationCost: Number(settings.operationCost) || 0,
  tiePolicy: settings.tiePolicy,
};

if (mode === 'weights') {
  const context = await buildReplayContext(asset, timeframe, settings, {
    maxTests: Math.min(8000, candles - 250),
    onProgress,
    precomputeHistorical: true,
  });
  const report = calibrateCategoryWeights(context, {
    ...economics,
    selectionWindows: Number(option('windows', 4)),
    purgeBars: Number(option('purge-bars', 3)),
    finalHoldoutFraction: Number(option('holdout-fraction', 0.25)),
    productionWeights: settings.weights,
    onProgress,
  });
  const deploymentBlockedReasons = [];
  if (context.historicalNewsUnavailable) {
    deploymentBlockedReasons.push('calendário econômico histórico indisponível para reproduzir o filtro de notícias');
  }
  const calibrationAccepted = report.accepted;
  const accepted = calibrationAccepted && deploymentBlockedReasons.length === 0;
  console.log(JSON.stringify({
    asset: asset.id,
    timeframe,
    mode,
    source: context.data.source,
    candles: context.candles.length,
    warning: 'Resultado diagnóstico. Não altera pesos, defaults ou produção e não prova vantagem estatística.',
    calibratedParameters: ['pesos das sete categorias, soma normalizada em 100'],
    ...report,
    calibrationAccepted,
    accepted,
    deploymentBlockedReasons,
  }, null, 2));
  process.exit(0);
}

const result = await runBacktest(asset, timeframe, settings, {
  maxTests: Math.min(3000, candles - 250),
  onProgress,
});
const report = calibrateScoreScale(result.bars, {
  ...economics,
  purgeBars: 3,
  defaultMinScore: Number(settings.minScore) || 62,
});
const deploymentBlockedReasons = [];
if (result.meta.newsHistoricalUnavailable) {
  deploymentBlockedReasons.push('calendário econômico histórico indisponível para reproduzir o filtro de notícias');
}
const calibrationAccepted = report.accepted;
const accepted = calibrationAccepted && deploymentBlockedReasons.length === 0;

console.log(JSON.stringify({
  asset: asset.id,
  timeframe,
  source: result.meta.source,
  candles: result.meta.candles,
  mode,
  warning: 'Resultado diagnóstico. Não altera defaults nem prova vantagem estatística.',
  calibratedParameters: ['scoreB0', 'scoreB1', 'minScore'],
  notCalibratedHere: ['pesos de categoria', 'coeficientes internos de indicadores', 'limiares RSI/ATR/SR'],
  ...report,
  calibrationAccepted,
  accepted,
  deploymentBlockedReasons,
}, null, 2));
