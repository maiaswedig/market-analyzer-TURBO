import { classifyEconomicEvent, fetchCalendarSnapshot } from "../_shared/market-guards.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("categorias econômicas são determinísticas e não inferem direção", () => {
  assert(classifyEconomicEvent("Federal Funds Rate") === "rate_decision", "juros não categorizados");
  assert(classifyEconomicEvent("CPI m/m") === "inflation", "inflação não categorizada");
  assert(classifyEconomicEvent("Non-Farm Employment Change") === "employment", "emprego não categorizado");
  assert(classifyEconomicEvent("Advance GDP q/q") === "growth", "crescimento não categorizado");
  assert(classifyEconomicEvent("Fed Chair Powell Speaks") === "central_bank", "banco central não categorizado");
});

Deno.test("snapshot preserva os campos conhecidos na hora da coleta", async () => {
  const originalFetch = globalThis.fetch;
  const fetchedAt = Date.UTC(2026, 7, 30, 12, 0, 0);
  globalThis.fetch = (async () => new Response(JSON.stringify([{
    title: "CPI m/m",
    country: "USD",
    date: "2026-08-30T13:30:00Z",
    impact: "High",
    forecast: "0.3%",
    previous: "0.2%",
    actual: "",
  }]), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  try {
    const snapshot = await fetchCalendarSnapshot(fetchedAt);
    assert(snapshot.error === null && snapshot.events?.length === 1, "snapshot válido não foi aceito");
    const event = snapshot.events[0];
    assert(event.category === "inflation" && event.categoryVersion === 1, "categoria/versionamento incorretos");
    assert(event.forecast === "0.3%" && event.previous === "0.2%" && event.actual === null,
      "campos observáveis não foram preservados");
    assert(event.eventKey.includes("2026-08-30T13:30:00.000Z"), "chave causal não contém o horário do evento");
    assert(!("direction" in event) && !("sentiment" in event), "arquivo seguro não deve inventar direção/sentimento");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
