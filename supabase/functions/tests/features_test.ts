import {
  buildDecisionAssessment,
  buildFeatureRows,
  directionalEconomics,
  FEATURE_NAMES,
  gradeDecisionAssessment,
  independentModelDecision,
} from "../_shared/features.ts";
import type { Candle } from "../_shared/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function candles(count: number): Candle[] {
  const start = Date.UTC(2026, 0, 1);
  let price = 100;
  return Array.from({ length: count }, (_, index) => {
    const open = price;
    price += Math.sin(index / 7) * 0.3 + 0.04;
    const close = price;
    return {
      symbol: "TESTUSDT", timeframe: "M5", openTime: start + index * 300_000,
      open, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, close,
      volume: 100 + index % 17, source: "binance", isClosed: true, receivedAt: start + index * 300_000 + 300_000,
    };
  });
}

Deno.test("feature antiga não muda quando candles futuros são anexados", () => {
  const base = candles(240);
  const before = buildFeatureRows(base);
  const target = before[before.length - 1];
  const future = candles(245).slice(240);
  for (const [index, candle] of future.entries()) {
    candle.close *= 4 + index;
    candle.high = candle.close + 100;
    candle.low = Math.min(candle.low, candle.open / 3);
    candle.volume *= 1000;
  }
  const after = buildFeatureRows([...base, ...future]);
  const sameTime = after.find((row) => row.openTime === target.openTime);
  assert(!!sameTime, "snapshot causal desapareceu");
  assert(JSON.stringify(sameTime.vector) === JSON.stringify(target.vector), "candle futuro alterou feature passada");
  assert(target.vector.length === FEATURE_NAMES.length, "schema e vetor divergiram");
});

Deno.test("política independente compra, vende ou aguarda pelo EV líquido", () => {
  const buy = independentModelDecision(0.72, 0.01, 0.85, 0.02);
  const sell = independentModelDecision(0.28, 0.01, 0.85, 0.02);
  const wait = independentModelDecision(0.52, 0.01, 0.85, 0.02);
  const tieWait = independentModelDecision(0.70, 0.30, 0.85, 0.02);
  assert(buy.action === "buy" && buy.expectedEv > 0, "probabilidade forte de alta não virou compra");
  assert(sell.action === "sell" && sell.expectedEv > 0, "probabilidade forte de baixa não virou venda");
  assert(wait.action === "wait" && wait.direction === null, "zona sem EV positivo não virou aguardar");
  assert(tieWait.action === "wait", "risco de empate não reduziu corretamente a vantagem econômica");
});

Deno.test("política independente respeita a regra econômica de empate", () => {
  const loss = independentModelDecision(0.60, 0.10, 0.85, 0.02, "loss");
  const refund = independentModelDecision(0.60, 0.10, 0.85, 0.02, "refund");
  const win = independentModelDecision(0.60, 0.10, 0.85, 0.02, "win");
  assert(Math.abs(loss.expectedEv - (-0.021)) < 1e-12, "empate como perda divergiu do ledger");
  assert(Math.abs(refund.expectedEv - 0.079) < 1e-12, "empate reembolsado divergiu do ledger");
  assert(Math.abs(win.expectedEv - 0.164) < 1e-12, "empate como acerto divergiu do ledger");
  assert(loss.action === "wait", "EV negativo com empate-perda deveria aguardar");
  assert(refund.action === "buy" && win.action === "buy", "política favorável de empate deveria preservar a compra");
});

Deno.test("economia direcional usa probabilidade condicional sem perder o empate", () => {
  const result = directionalEconomics(0.60, 0.10, 0.85, 0.02, "refund");
  assert(Math.abs(result.winProbability - 0.54) < 1e-12, "probabilidade de vitória incondicional incorreta");
  assert(Math.abs(result.lossProbability - 0.36) < 1e-12, "probabilidade de perda incondicional incorreta");
  assert(Math.abs(result.tieProbability - 0.10) < 1e-12, "probabilidade de empate foi descartada");
  assert(Math.abs(result.expectedEv - 0.079) < 1e-12, "EV canônico divergiu da política refund");
});

Deno.test("avaliação ponderada diferencia quatro aprovações de duas", () => {
  const four = buildDecisionAssessment({
    direction: "buy", directionalScore: 70, alignment: 1,
    emaFast: 0.2, emaSlow: 0.1, rsiCentered: 0.3,
    macd: -0.2, momentum: -0.2, relativeVolume: 0.2, wickRatio: 0.7,
  });
  const two = buildDecisionAssessment({
    direction: "buy", directionalScore: 70, alignment: 1,
    emaFast: -0.2, emaSlow: -0.1, rsiCentered: -0.3,
    macd: -0.2, momentum: -0.2, relativeVolume: 0.2, wickRatio: 0.7,
  });
  assert(four.passed === 4, "caso de quatro aprovações foi contado incorretamente");
  assert(two.passed === 2, "caso de duas aprovações foi contado incorretamente");
  assert(four.score > two.score, "quatro aprovações não superaram duas aprovações");
});

Deno.test("oito aprovações produzem nota A+", () => {
  const assessment = buildDecisionAssessment({
    direction: "buy", directionalScore: 75, alignment: 1,
    emaFast: 0.3, emaSlow: 0.2, rsiCentered: 0.4,
    macd: 0.2, momentum: 0.2, relativeVolume: 1.1, wickRatio: 0.1,
  });
  assert(assessment.passed === 8 && assessment.score === 100, "oito aprovações não somaram 100");
  assert(gradeDecisionAssessment(assessment.score) === "A+", "pontuação máxima não recebeu A+");
  assert(assessment.families.find(item => item.id === "trend")?.earned === 30, "família de tendência excedeu ou perdeu seu teto");
  assert(assessment.families.find(item => item.id === "momentum")?.earned === 20, "família de momentum excedeu ou perdeu seu teto");
});

Deno.test("faixas A e B permanecem alcançáveis sem alterar a qualidade", () => {
  const gradeA = buildDecisionAssessment({
    direction: "buy", directionalScore: 70, alignment: 1,
    emaFast: 0.2, emaSlow: 0.1, rsiCentered: 0.3,
    macd: 0.2, momentum: 0.2, relativeVolume: 0.6, wickRatio: 0.7,
  });
  const gradeB = buildDecisionAssessment({
    direction: "buy", directionalScore: 70, alignment: 1,
    emaFast: 0.2, emaSlow: 0.1, rsiCentered: 0.3,
    macd: 0.2, momentum: 0.2, relativeVolume: 0.2, wickRatio: 0.7,
  });
  assert(gradeDecisionAssessment(gradeA.score) === "A", `esperava A, recebeu ${gradeA.score}`);
  assert(gradeDecisionAssessment(gradeB.score) === "B", `esperava B, recebeu ${gradeB.score}`);
});
