import { candleProgress, cyclePhase, floorCandleOpen, signalClock } from "../_shared/time.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("relógio alinha M5 e resolve E1 no fechamento exato da próxima vela", () => {
  const observed = Date.UTC(2026, 7, 26, 12, 10, 0);
  const clock = signalClock(observed, "M5", 1);
  assert(clock.entryCandleOpen === Date.UTC(2026, 7, 26, 12, 15, 0), "entrada E1 incorreta");
  assert(clock.targetCandleOpen === clock.entryCandleOpen, "o alvo E1 deve ser a vela de entrada");
  assert(clock.resolveAfter === Date.UTC(2026, 7, 26, 12, 20, 0), "fechamento E1 incorreto");
});

Deno.test("progresso e janela do cron usam a vela atual, sem misturar timeframes", () => {
  const now = Date.UTC(2026, 7, 26, 12, 14, 10);
  const open = floorCandleOpen(now, "M5");
  assert(open === Date.UTC(2026, 7, 26, 12, 10, 0), "abertura M5 incorreta");
  assert(candleProgress(now, open, "M5") > 0.8, "progresso M5 deveria estar no trecho final");
  assert(cyclePhase(now, "M5").analyze, "M5 deveria estar na janela de análise");
  assert(!cyclePhase(now, "H1").analyze, "H1 não deveria ser analisado aos 14 minutos");
});

Deno.test("M30 alinha entrada e expiração sem reutilizar a vela observada", () => {
  const observed = Date.UTC(2026, 7, 30, 12, 0, 0);
  const clock = signalClock(observed, "M30", 1);
  assert(clock.entryCandleOpen === Date.UTC(2026, 7, 30, 12, 30, 0), "entrada M30 incorreta");
  assert(clock.targetCandleOpen === clock.entryCandleOpen, "alvo M30 deve ser a próxima vela");
  assert(clock.resolveAfter === Date.UTC(2026, 7, 30, 13, 0, 0), "expiração M30 incorreta");
});
