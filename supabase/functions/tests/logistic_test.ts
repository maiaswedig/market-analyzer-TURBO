import { trainChronological, type TieObservation, type TrainingSample } from "../_shared/logistic.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("challenger exige 300 validações e supera baseline com margem pareada", () => {
  const samples: TrainingSample[] = Array.from({ length: 1_200 }, (_, index) => {
    const signal = Math.sin(index * 0.31) + Math.cos(index * 0.07) * 0.25;
    const vector = Array.from({ length: 14 }, (_, column) => column === 0 ? signal : Math.sin(index / (column + 3)) * 0.05);
    return { at: Date.UTC(2020, 0, 1) + index * 300_000, vector, label: signal > 0 ? 1 : 0 };
  });
  const result = trainChronological(samples, { minValidation: 300, epochs: 80, zMargin: 1.5, tieRate: 0.01 });
  assert(result.ok && !!result.artifact, result.reason || "artefato ausente");
  assert(result.artifact.validationSamples >= 300, "holdout menor que 300");
  const walkForward = result.artifact.metrics.walkForward as { passed?: boolean; windows?: Array<{ validationSamples?: number }> };
  assert(walkForward?.passed === true && walkForward.windows?.length === 3, "walk-forward de três janelas não passou");
  assert(walkForward.windows.every(window => Number(window.validationSamples) >= 200), "janela walk-forward pequena demais");
  assert(result.artifact.usable, "sinal sintético forte deveria passar nos gates");
});

Deno.test("tieRate de cada janela usa somente observações anteriores ao corte de treino", () => {
  const start = Date.UTC(2021, 0, 1);
  const samples: TrainingSample[] = Array.from({ length: 1_200 }, (_, index) => {
    const signal = Math.sin(index * 0.31) + Math.cos(index * 0.07) * 0.25;
    const vector = Array.from({ length: 14 }, (_, column) => column === 0 ? signal : Math.sin(index / (column + 3)) * 0.05);
    return { at: start + index * 300_000, vector, label: signal > 0 ? 1 : 0 };
  });
  const outcomeTimeline: TieObservation[] = samples.map((sample, index) => ({
    at: sample.at,
    // Deliberately change the historical tie regime so each expanding window
    // must calculate a different estimate from its own past.
    isTie: index < 450 ? index % 20 === 0 : index < 800 ? index % 8 === 0 : index % 3 === 0,
  }));
  const options = { minValidation: 300, epochs: 80, zMargin: 1.5, outcomeTimeline };
  const result = trainChronological(samples, options);
  assert(result.ok && !!result.artifact, result.reason || "artefato ausente");
  const walkForward = result.artifact.metrics.walkForward as {
    windows: Array<{
      trainTo: string;
      validationFrom: string;
      tieRate: number;
      tieObservations: number;
      tieCutoffAt: string;
      tieRateSource: string;
    }>;
  };
  assert(walkForward.windows.length === 3, "faltam janelas walk-forward");
  for (const window of walkForward.windows) {
    assert(window.tieRateSource === "training-window-laplace", "janela não usou Laplace causal");
    assert(window.tieObservations > 0, "janela não contou observações de empate");
    assert(window.tieCutoffAt === window.trainTo, "corte do empate não coincide com o fim do treino");
    assert(Date.parse(window.tieCutoffAt) < Date.parse(window.validationFrom), "empate futuro vazou para a janela");
  }
  assert(new Set(walkForward.windows.map((window) => window.tieRate.toFixed(8))).size > 1,
    "regimes históricos diferentes deveriam gerar tieRates diferentes");

  const futureTimeline = outcomeTimeline.concat(Array.from({ length: 50 }, (_, index) => ({
    at: start + (2_000 + index) * 300_000,
    isTie: true,
  })));
  const futureResult = trainChronological(samples, { ...options, outcomeTimeline: futureTimeline });
  assert(futureResult.ok && !!futureResult.artifact, futureResult.reason || "artefato futuro ausente");
  const futureWalkForward = futureResult.artifact.metrics.walkForward as typeof walkForward;
  assert(
    JSON.stringify(futureWalkForward.windows.map((window) => window.tieRate)) ===
      JSON.stringify(walkForward.windows.map((window) => window.tieRate)),
    "observações futuras alteraram taxas de empate históricas",
  );
  assert(futureResult.artifact.tieRate === result.artifact.tieRate,
    "observações futuras alteraram a taxa de empate do artefato final");
});
