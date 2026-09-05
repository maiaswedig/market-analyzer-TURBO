import { trainChronological, type TrainingSample } from "../_shared/logistic.ts";

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
