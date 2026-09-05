export const TIMEFRAMES = Object.freeze({
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
} as const);

export type Timeframe = keyof typeof TIMEFRAMES;
// `WatchAsset.source` names the preferred provider. `Candle.source` records
// the provider that actually supplied the bar, including a real fallback.
export type MarketSource = "binance" | "okx" | "yahoo";

export interface WatchAsset {
  id?: string;
  symbol: string;
  providerSymbol: string;
  market: string;
  source: MarketSource;
}

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: MarketSource;
  isClosed: boolean;
  receivedAt: number;
}

export interface FeatureRow {
  index: number;
  openTime: number;
  vector: number[];
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  rsi: number;
  atr: number;
  macdHistogram: number;
  relativeVolume: number | null;
  bodyRatio: number;
  rangeAtr: number;
  bollingerPercentB: number;
  momentumAtr: number;
  regime: MarketRegime;
  regimeInputs: {
    emaAlignment: number;
    adxLike: number;
    atrPercentile: number | null;
    bbBandwidth: number;
    bbBwPercentile: number | null;
    structureDir: number;
  };
}

export type MarketRegime =
  | "alta volatilidade"
  | "baixa volatilidade (squeeze)"
  | "tendência forte de alta"
  | "tendência forte de baixa"
  | "tendência fraca de alta"
  | "tendência fraca de baixa"
  | "consolidação"
  | "indefinido";

export interface LogisticArtifact {
  algorithm: "logistic-regression";
  featureSchemaVersion: string;
  validationPolicyVersion: number;
  decisionPolicyVersion?: number;
  weights: number[];
  bias: number;
  mean: number[];
  std: number[];
  tieRate: number;
  trainedAt: string;
  trainFrom: string;
  trainTo: string;
  validationFrom: string;
  validationTo: string;
  samples: number;
  validationSamples: number;
  metrics: Record<string, unknown>;
  usable: boolean;
}

export interface StoredModel {
  id: string;
  status: "production" | "candidate" | "rejected" | "retired";
  artifact: LogisticArtifact;
  createdAt?: string;
}

export interface ModelPrediction {
  modelId: string;
  role: "champion" | "shadow";
  probabilityUp: number;
  tieProbability: number;
  policyAction: "buy" | "sell" | "wait";
  policyDirection: "buy" | "sell" | null;
  winProbability: number;
  expectedEv: number;
  decisionPolicyVersion: number;
  featureSchemaVersion: string;
}

export type AssessmentStatus = "pass" | "partial" | "fail";
export type AssessmentFamily = "trend" | "momentum" | "rsi" | "volume" | "price_action";

export interface DecisionAssessmentCheck {
  id: string;
  label: string;
  family: AssessmentFamily;
  status: AssessmentStatus;
  weight: number;
  earned: number;
  detail: string;
}

export interface DecisionAssessment {
  score: number;
  passed: number;
  partial: number;
  failed: number;
  total: number;
  checks: DecisionAssessmentCheck[];
  families: Array<{
    id: AssessmentFamily;
    label: string;
    cap: number;
    earned: number;
  }>;
}

export interface MarketDecision {
  symbol: string;
  timeframe: Timeframe;
  observedCandleOpen: number;
  entryCandleOpen: number;
  targetCandleOpen: number;
  resolveAfter: number;
  direction: "buy" | "sell" | null;
  status: "signal" | "wait";
  score: number;
  grade: "A+" | "A" | "B" | "C" | "D";
  regime: MarketRegime;
  assessment: DecisionAssessment;
  confluence: number;
  confidence: number | null;
  evNet: number | null;
  expiration: "E1";
  referencePrice: number;
  usedLiveCandle: boolean;
  blockers: string[];
  reasons: string[];
  featureVector: number[];
  predictions: ModelPrediction[];
  championModelId: string | null;
}

